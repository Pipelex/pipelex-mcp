/**
 * `scripts/image-block-probe.ts` — the host probe behind the inline-image feature.
 *
 * Why it exists: what a *host* charges for an MCP image content block inside a
 * tool result is undocumented. Claude Code's documentation says image blocks
 * count against `MAX_MCP_OUTPUT_TOKENS` without saying how their base64 is
 * counted, and its tracker carries a report of base64 image data billed like
 * text — ten to twenty times the model's own native vision price. The caps and
 * the per-shell default of `mthds_run_results`'s inline-image walk therefore
 * hang on a measurement rather than on the model API's limits, which are the
 * wrong ceiling.
 *
 * What it is: a throwaway stdio MCP server on the plain SDK, registering one
 * tool, `probe_image`, which answers a text block naming the size and one image
 * content block carrying a valid PNG of *exactly* the requested byte count. A
 * host is then asked to call it at a size ladder and the run's own accounting is
 * read back: accepted or refused, what it cost, and whether the model
 * demonstrably saw the picture.
 *
 * How the picture is made checkable: the PNG carries a solid shape in a named
 * colour on a background, and the tool result never says which. Asking the model
 * to describe what it sees is therefore a real test — the answer is checked
 * against what the probe drew, which it records on stderr and, when
 * `IMAGE_BLOCK_PROBE_LOG` names a file, as one JSON line per call in it.
 *
 * How a byte target is hit exactly: a PNG's `tEXt` chunk is ancillary, so every
 * decoder skips it and any amount of filler in one is still a decodable image.
 * The image is built first, then one `tEXt` chunk is sized to make up the
 * difference — no image library, no resampling.
 *
 * Two fills, and the difference is the whole point of the probe:
 *   - `solid` (the default) draws the shape on a flat background, so the PNG
 *     compresses to almost nothing and nearly every byte of the target is
 *     `tEXt` filler. It measures what the *container* costs.
 *   - `noise` sizes an incompressible random-pixel canvas to the target and
 *     draws the shape on top. It measures what a *real* photograph of that size
 *     costs, and it is the honest reading if a host re-encodes the image (which
 *     would drop the filler chunk and make a `solid` measurement flatter).
 *
 * Dev tooling under `scripts/`: typechecked by `tsconfig.scripts.json`, linted
 * and formatted with `src/`, and never reachable from either shipped entrypoint.
 *
 * Who sets the size: the harness, through the environment, not the model. Asked
 * in prose for a four-megabyte image a model will call with fifty kilobytes and
 * the rung silently measures the wrong thing, so `IMAGE_BLOCK_PROBE_BYTES`,
 * `_FILL`, `_WIDTH`, `_HEIGHT` and `_LABEL` supply every default and the model is
 * told to call the tool with no arguments at all. An argument the model does
 * pass still wins, which is what makes the tool usable by hand.
 *
 * Run it directly with `npx tsx scripts/image-block-probe.ts`, or register it in
 * a host:
 *   claude mcp add image-block-probe -- npx tsx <abs path>/scripts/image-block-probe.ts
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Nameable colours: the model's description has to land on one of these words. */
const COLORS = {
  red: [220, 40, 40],
  green: [40, 170, 70],
  blue: [40, 90, 220],
  yellow: [240, 210, 50],
  purple: [150, 60, 200],
  orange: [240, 140, 40],
  black: [20, 20, 20],
  white: [245, 245, 245],
} as const satisfies Record<string, readonly [number, number, number]>;

type ColorName = keyof typeof COLORS;

const COLOR_NAMES = Object.keys(COLORS) as ColorName[];

/** Shapes a description can be checked against without ambiguity. */
const SHAPES = ["circle", "square", "triangle", "diamond", "cross"] as const;

type ShapeName = (typeof SHAPES)[number];

const FILLS = ["solid", "noise"] as const;

type FillName = (typeof FILLS)[number];

/**
 * The shape of the result itself, so a host that refuses the call can be asked
 * *what* it refused. `full` carries the standard's `annotations` hint, `meta`
 * carries a block-level `_meta`, `bare` carries neither, and `text` omits the
 * image block entirely, which is the control: a host that fails `bare` and
 * passes `text` fails on image blocks as such, and one that fails a decorated
 * variant but passes `bare` fails only on that decoration.
 *
 * `meta` is the shape this repo actually ships (`{ type, data, mimeType,
 * _meta: { uri } }`), and it was added after the fact — the first run of this
 * probe measured `full` and `bare` and nothing else, so the shipped block had
 * never been sent to any host. That gap is exactly the one the probe exists to
 * close: `annotations` is an optional field the MCP standard permits and Codex
 * refuses outright, and `_meta` is an optional field the MCP standard permits.
 * Whether a host tolerates the second does not follow from anything; it has to
 * be measured.
 */
const VARIANTS = ["full", "meta", "bare", "text"] as const;

type VariantName = (typeof VARIANTS)[number];

/** The side of a `solid` canvas when the caller names no dimensions. */
const DEFAULT_SIDE = 512;

/**
 * A `noise` canvas is sized so its incompressible pixels land just under the
 * byte target, leaving the `tEXt` chunk a little filler to land on it exactly.
 * Deflate on random bytes is stored-block sized (raw + ~0.03%), so the headroom
 * is mostly for the fixed chunk overhead.
 */
const NOISE_HEADROOM = 0.94;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `tEXt` keyword, per the PNG spec: 1–79 Latin-1 characters, then a NUL. */
const PAD_KEYWORD = "Comment";

/** signature + IHDR + IDAT overhead + IEND, i.e. everything but the pixels and the filler. */
const FIXED_OVERHEAD = PNG_SIGNATURE.length + 25 + 12 + 12;

/** The smallest `tEXt` chunk that can carry the keyword and one filler byte. */
const MIN_PAD_CHUNK = 12 + PAD_KEYWORD.length + 1 + 1;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

interface Drawing {
  width: number;
  height: number;
  shape: ShapeName;
  color: ColorName;
  background: ColorName;
  fill: FillName;
}

/** RGB pixels, row-major, no filter bytes yet. */
function paint(drawing: Drawing): Buffer {
  const { width, height, fill } = drawing;
  const pixels = Buffer.alloc(width * height * 3);
  const fg = COLORS[drawing.color];
  const bg = COLORS[drawing.background];

  if (fill === "noise") {
    // Incompressible by construction: this is what makes a `noise` PNG's byte
    // size real rather than filler.
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = Math.floor(Math.random() * 256);
  } else {
    for (let i = 0; i < pixels.length; i += 3) {
      pixels[i] = bg[0];
      pixels[i + 1] = bg[1];
      pixels[i + 2] = bg[2];
    }
  }

  // The shape occupies the middle half of the canvas, so it reads at any size.
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = Math.min(width, height) * 0.3;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!insideShape(drawing.shape, x - cx, y - cy, radius)) continue;
      const offset = (y * width + x) * 3;
      pixels[offset] = fg[0];
      pixels[offset + 1] = fg[1];
      pixels[offset + 2] = fg[2];
    }
  }

  return pixels;
}

function insideShape(shape: ShapeName, dx: number, dy: number, r: number): boolean {
  switch (shape) {
    case "circle":
      return dx * dx + dy * dy <= r * r;
    case "square":
      return Math.abs(dx) <= r && Math.abs(dy) <= r;
    case "diamond":
      return Math.abs(dx) + Math.abs(dy) <= r;
    case "cross":
      return (
        (Math.abs(dx) <= r * 0.32 && Math.abs(dy) <= r) ||
        (Math.abs(dy) <= r * 0.32 && Math.abs(dx) <= r)
      );
    case "triangle": {
      // Point up, base at +r: the two sides close at the apex.
      if (dy > r) return false;
      const halfWidth = ((dy + r) / (2 * r)) * r;
      return dy >= -r && Math.abs(dx) <= halfWidth;
    }
  }
}

function encodePng(drawing: Drawing, targetBytes: number): { png: Buffer; padBytes: number } {
  const { width, height } = drawing;
  const pixels = paint(drawing);

  // One filter byte (0 = None) per scanline, then zlib.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 3)] = 0;
    pixels.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = deflateSync(raw, { level: drawing.fill === "noise" ? 0 : 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const body = FIXED_OVERHEAD + idat.length;
  // Below the minimum the target is unreachable; the caller is told the real size.
  const padBytes = Math.max(0, targetBytes - body - 12 - PAD_KEYWORD.length - 1);
  const pad =
    targetBytes - body < MIN_PAD_CHUNK
      ? Buffer.alloc(0)
      : chunk(
          "tEXt",
          Buffer.concat([
            Buffer.from(`${PAD_KEYWORD}\0`, "latin1"),
            // Printable ASCII only: `tEXt` forbids NUL in the text, and Latin-1
            // keeps every byte one byte on the wire.
            Buffer.alloc(padBytes, "x"),
          ]),
        );

  return {
    png: Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      pad,
      chunk("IEND", Buffer.alloc(0)),
    ]),
    padBytes: pad.length,
  };
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

function stripUndefined(input: ProbeInput): ProbeInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as ProbeInput;
}

/** The native price of a picture on the Claude API: ⌈w/28⌉ × ⌈h/28⌉ tokens. */
function nativeVisionTokens(width: number, height: number): number {
  return Math.ceil(width / 28) * Math.ceil(height / 28);
}

interface ProbeInput {
  bytes?: number;
  width?: number;
  height?: number;
  shape?: ShapeName;
  color?: ColorName;
  background?: ColorName;
  fill?: FillName;
  label?: string;
}

/**
 * Environment defaults, so a ladder rung is set by the harness and not by the
 * model. A measurement whose size the model chooses is not a measurement: asked
 * for four megabytes, a model will quietly call with fifty kilobytes instead.
 */
function envDefaults(env: NodeJS.ProcessEnv): ProbeInput {
  const num = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.floor(value) : undefined;
  };
  const fill = env.IMAGE_BLOCK_PROBE_FILL;
  return {
    bytes: num("IMAGE_BLOCK_PROBE_BYTES"),
    width: num("IMAGE_BLOCK_PROBE_WIDTH"),
    height: num("IMAGE_BLOCK_PROBE_HEIGHT"),
    fill: FILLS.includes(fill as FillName) ? (fill as FillName) : undefined,
    label: env.IMAGE_BLOCK_PROBE_LABEL,
  };
}

function envVariant(env: NodeJS.ProcessEnv): VariantName {
  const raw = env.IMAGE_BLOCK_PROBE_VARIANT;
  return VARIANTS.includes(raw as VariantName) ? (raw as VariantName) : "full";
}

function buildProbe(
  called: ProbeInput,
  env: NodeJS.ProcessEnv = process.env,
): {
  png: Buffer;
  drawing: Drawing;
  record: Record<string, unknown>;
} {
  const defaults = envDefaults(env);
  // The call wins where it says something; the environment fills the rest.
  const input: ProbeInput = { ...defaults, ...stripUndefined(called) };
  const targetBytes = Math.max(0, Math.floor(input.bytes ?? 50 * 1024));
  const fill: FillName = input.fill ?? "solid";

  const derivedSide =
    fill === "noise"
      ? Math.max(16, Math.floor(Math.sqrt((targetBytes * NOISE_HEADROOM) / 3)))
      : DEFAULT_SIDE;
  const width = input.width ?? derivedSide;
  const height = input.height ?? derivedSide;

  const color = input.color ?? pick(COLOR_NAMES);
  // Never draw a shape in its own background: the description has to be possible.
  const background =
    input.background ?? pick(COLOR_NAMES.filter((name) => name !== color) as ColorName[]);

  const drawing: Drawing = {
    width,
    height,
    shape: input.shape ?? pick(SHAPES),
    color,
    background,
    fill,
  };

  const { png, padBytes } = encodePng(drawing, targetBytes);

  return {
    png,
    drawing,
    record: {
      at: new Date().toISOString(),
      label: input.label ?? null,
      requested_bytes: targetBytes,
      actual_bytes: png.length,
      base64_bytes: Buffer.from(png).toString("base64").length,
      pad_chunk_bytes: padBytes,
      width,
      height,
      fill,
      shape: drawing.shape,
      color: drawing.color,
      background: drawing.background,
      native_vision_tokens: nativeVisionTokens(width, height),
    },
  };
}

function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  process.stderr.write(`image-block-probe ${line}\n`);
  const logPath = process.env.IMAGE_BLOCK_PROBE_LOG;
  if (logPath !== undefined && logPath !== "") {
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch (err) {
      process.stderr.write(
        `image-block-probe could not write ${logPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export function createProbeServer(): McpServer {
  const server = new McpServer(
    { name: "image-block-probe", version: "0.0.0" },
    {
      capabilities: {},
      instructions:
        "A measurement fixture. `probe_image` answers one MCP image content block of a requested byte size. " +
        "Call it exactly as asked, then describe the picture you received in plain words — the shape and its colour, " +
        "and the colour behind it. Say so plainly if no image reached you.",
    },
  );

  server.registerTool(
    "probe_image",
    {
      description:
        "Return one image content block carrying a PNG of exactly `bytes` bytes, beside a text block naming the size. " +
        "The picture is a solid shape in one colour on a background of another; neither is named in the result, " +
        "so describing it back is a test of whether the image reached the model.",
      inputSchema: {
        bytes: z
          .number()
          .int()
          .min(0)
          .max(64 * 1024 * 1024)
          .optional()
          .describe(
            "Exact size of the returned PNG in bytes. Defaults to IMAGE_BLOCK_PROBE_BYTES, else 51200 (50 KiB).",
          ),
        width: z.number().int().min(8).max(8192).optional().describe("Canvas width in pixels."),
        height: z.number().int().min(8).max(8192).optional().describe("Canvas height in pixels."),
        shape: z.enum(SHAPES).optional().describe("Force the drawn shape instead of picking one."),
        color: z.enum(COLOR_NAMES as [ColorName, ...ColorName[]]).optional(),
        background: z.enum(COLOR_NAMES as [ColorName, ...ColorName[]]).optional(),
        fill: z
          .enum(FILLS)
          .optional()
          .describe(
            "solid: a flat background, so the target size is mostly filler — measures the container. " +
              "noise: an incompressible canvas sized to the target — measures a real photograph.",
          ),
        label: z.string().optional().describe("Echoed into the probe log, to key a ladder rung."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const { png, drawing, record: entry } = buildProbe(input as ProbeInput);
      const variant = envVariant(process.env);
      record({ ...entry, variant });

      const text = {
        type: "text" as const,
        text: `probe_image: PNG, ${png.length} bytes, ${drawing.width}x${drawing.height}, fill=${drawing.fill}, variant=${variant}. Describe the picture: the shape, its colour, and the colour behind it.`,
      };
      if (variant === "text") return { content: [text] };

      const image = {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
        ...(variant === "full"
          ? {
              annotations: {
                audience: ["user" as const, "assistant" as const],
                priority: 0.8,
              },
            }
          : {}),
        // The shipped shape: a storage reference on the block's own `_meta`,
        // which the standard's `ImageContentSchema` declares optional and
        // which never reaches the model.
        ...(variant === "meta"
          ? { _meta: { uri: `pipelex-storage://probe/${drawing.fill}-${png.length}.png` } }
          : {}),
      };
      return { content: [text, image] };
    },
  );

  return server;
}

// `tsx scripts/image-block-probe.ts` starts the server; importing the module does not.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = createProbeServer();
  await server.connect(new StdioServerTransport());
}
