import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  INLINE_TREE_MAX_BYTES,
  RequestArgumentError,
  RunLifecycleUnavailableError,
} from "@pipelex/sdk";

import { sha256Hex, treeDigest } from "mthds";

import type { ListingLimits } from "./method-tree.js";
import {
  ALLOW_HTTP_ENV,
  allowsPlainHttp,
  argumentProblem,
  blueprintMainPipeRefOf,
  buildApiConfig,
  buildArtifactFetchConfig,
  createPipelexApiClient,
  DEFAULT_API_URL,
  faultsProblem,
  fetchItemProblem,
  imageCandidatesOf,
  isExecutionLocusRefusal,
  looksLikeImageKey,
  methodFilesInputSchema,
  parseAllowHttpOverride,
  problemOf,
  problemSchema,
  problemSummary,
  refusalProblem,
  resolveMethodSource,
  storageKeyOf,
  toolResultContent,
  validateMethodSelectorRequest,
  validateRunIdRequest,
  withFilesSent,
  failedBeforeSending,
  markUnsent,
} from "./shared.js";
import type { FileResolver, MethodSourceInput, Problem, ResolvedMethodSource } from "./shared.js";

describe("buildApiConfig", () => {
  it("defaults to the hosted API with no key", () => {
    const config = buildApiConfig({});

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
    expect(config.apiKey).toBeUndefined();
  });

  it("reads the base URL and key from the environment", () => {
    const config = buildApiConfig({
      PIPELEX_BASE_URL: "http://localhost:8081",
      PIPELEX_API_KEY: "secret",
    });

    expect(config.baseUrl).toBe("http://localhost:8081");
    expect(config.apiKey).toBe("secret");
  });

  it("treats an empty key as absent", () => {
    const config = buildApiConfig({ PIPELEX_API_KEY: "" });

    expect(config.apiKey).toBeUndefined();
  });

  it("falls back to the hosted default when the base URL is blank", () => {
    const config = buildApiConfig({ PIPELEX_BASE_URL: "" });

    expect(config.baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("methodFilesInputSchema", () => {
  it("accepts the content arm and the path arm, a template path being a path item", () => {
    const parsed = methodFilesInputSchema.parse([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { path: "methods/bundle.mthds" },
      { path: "methods/templates/invoice.xlsx" },
    ]);

    expect(parsed).toEqual([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { path: "methods/bundle.mthds" },
      { path: "methods/templates/invoice.xlsx" },
    ]);
  });

  it("parses a pathological both-keys item as the content arm, ignoring path", () => {
    const parsed = methodFilesInputSchema.parse([
      { content: 'domain = "demo"', path: "methods/bundle.mthds" },
    ]);

    expect(parsed).toEqual([{ content: 'domain = "demo"' }]);
  });

  it("rejects an item matching neither arm", () => {
    expect(methodFilesInputSchema.safeParse([{ uri: "bundle.mthds" }]).success).toBe(false);
  });
});

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The limits a deployment announces, the workshop's own standing in for none. */
const LIMITS: ListingLimits = {
  maxFileCount: 1_000,
  maxFileSize: 32 * 1024 * 1024,
  maxTotalSize: 64 * 1024 * 1024,
};

/** A limits reader that counts how often it was asked. */
function limitsReader(limits: ListingLimits = LIMITS): (() => Promise<ListingLimits>) & {
  calls: number;
} {
  const read = Object.assign(
    () => {
      read.calls += 1;
      return Promise.resolve(limits);
    },
    { calls: 0 },
  );
  return read;
}

/**
 * A resolver reading `{ path }` items from `files`, each at `/w/<path>`: the
 * working directory the fake stands for. A path is looked up the way the
 * workshop resolves it, so `./a.mthds` and `a.mthds` name one file. `grown`
 * holds the bytes a read finds in place of `files`', a file that grew between
 * its stat and its read.
 */
function fakeFileResolver(
  files: Record<string, string | Uint8Array>,
  options: { grown?: Record<string, string | Uint8Array> } = {},
): FileResolver & {
  stats: string[];
  reads: { path: string; maxBytes: number }[];
} {
  const stats: string[] = [];
  const reads: { path: string; maxBytes: number }[] = [];
  const keyOf = (submitted: string) =>
    path.posix.relative("/w", path.posix.resolve("/w", submitted));
  const bytesOf = (content: string | Uint8Array) =>
    typeof content === "string" ? encode(content) : content;
  return {
    stats,
    reads,
    resolve: () => Promise.reject(new Error("a method's files are read as bytes")),
    async statMethodFile(submitted) {
      stats.push(submitted);
      const key = keyOf(submitted);
      const content = files[key];
      if (content === undefined) {
        return { ok: false, message: `File not found: ${submitted}`, remedy: "Check the path." };
      }
      return {
        ok: true,
        absolute: `/w/${key}`,
        relative: key,
        size: bytesOf(content).byteLength,
      };
    },
    async readMethodFile(submitted, { maxBytes }) {
      reads.push({ path: submitted, maxBytes });
      const key = keyOf(submitted);
      const content = options.grown?.[key] ?? files[key];
      if (content === undefined) {
        return { ok: false, message: `File not found: ${submitted}`, remedy: "Check the path." };
      }
      const bytes = bytesOf(content);
      if (bytes.byteLength > maxBytes) {
        return { ok: false, message: `${submitted} is too large.`, remedy: "Shrink it." };
      }
      return { ok: true, bytes };
    },
  };
}

/** The tree a resolution sends, file by file: tree path, where the caller finds it, and its text. */
function sentFiles(resolution: ResolvedMethodSource) {
  return resolution.tree?.files.map((file) => ({
    treePath: file.treePath,
    shown: file.shown,
    onDisk: file.onDisk,
    text: decode(file.bytes),
  }));
}

describe("resolveMethodSource on files", () => {
  it("sends inline items at the tree's top, under their uri's file name or bundle.mthds, held to the limits", async () => {
    const limits = limitsReader();
    const resolution = await resolveMethodSource(
      {
        files: [
          { content: 'domain = "a"', uri: "methods/a.mthds" },
          { content: 'domain = "b"' },
          { content: 'domain = "c"', uri: "https://example.com/x/report.html" },
          { content: 'domain = "d"', uri: "C:\\work\\a.mthds" },
        ],
      },
      undefined,
      "one_selector",
      limits,
    );

    expect(resolution.faults).toEqual([]);
    expect(sentFiles(resolution)).toEqual([
      { treePath: "a.mthds", shown: "a.mthds", onDisk: false, text: 'domain = "a"' },
      { treePath: "bundle-2.mthds", shown: "bundle-2.mthds", onDisk: false, text: 'domain = "c"' },
      { treePath: "bundle-3.mthds", shown: "bundle-3.mthds", onDisk: false, text: 'domain = "d"' },
      { treePath: "bundle.mthds", shown: "bundle.mthds", onDisk: false, text: 'domain = "b"' },
    ]);
    expect(resolution.tree?.fromFolder).toBe(false);
    // An inline-only list is held to the limits like any other.
    expect(limits.calls).toBe(1);
  });

  it("holds inline items to the limit on one file, at the item, and to the count and the total", async () => {
    const big = await resolveMethodSource(
      { files: [{ content: 'domain = "a"' }, { content: "x".repeat(20) }] },
      undefined,
      "one_selector",
      limitsReader({ ...LIMITS, maxFileSize: 16 }),
    );
    expect(big.faults).toEqual([
      expect.objectContaining({ location: { field: "files[1].content" }, domain: "input" }),
    ]);
    expect(big.faults[0]?.message).toContain("20 bytes, past the limit of 16 bytes");

    const many = await resolveMethodSource(
      { files: [{ content: "a" }, { content: "b" }, { content: "c" }] },
      undefined,
      "one_selector",
      limitsReader({ ...LIMITS, maxFileCount: 2 }),
    );
    expect(many.faults).toEqual([expect.objectContaining({ location: { field: "files" } })]);
    expect(many.faults[0]?.message).toContain("3 files, past the limit of 2");

    const heavy = await resolveMethodSource(
      { files: [{ content: "aaaa" }, { content: "bbbb" }] },
      undefined,
      "one_selector",
      limitsReader({ ...LIMITS, maxTotalSize: 7, workshopSet: ["maxTotalSize"] }),
    );
    expect(heavy.faults).toEqual([expect.objectContaining({ location: { field: "files" } })]);
    expect(heavy.faults[0]?.message).toContain("the workshop's own limit of 7 bytes");
  });

  it("refuses a list holding no .mthds file at files, before stating, reading or hashing any item", async () => {
    const XLSX = new Uint8Array(INLINE_TREE_MAX_BYTES + 1).fill(0xff);
    const resolver = fakeFileResolver({
      "finance/payroll.xlsx": XLSX,
      "finance/report.html": "<p>{{ total }}</p>",
    });
    const limits = limitsReader();

    const resolution = await resolveMethodSource(
      { files: [{ path: "finance/payroll.xlsx" }, { path: "finance/report.html" }] },
      resolver,
      "one_selector",
      limits,
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({
        domain: "input",
        location: { field: "files" },
        retry: "no",
        code: "client.argument_invalid",
        params: { argument: "files", reason: "no_method_file" },
        message: expect.stringContaining(
          "The files hold no .mthds file, so they make no method; nothing was read or sent.",
        ),
      }),
    ]);
    expect(resolution.faults[0]?.message).toContain("method_dir");
    expect(resolution.tree).toBeUndefined();
    expect(resolver.stats).toEqual([]);
    expect(resolver.reads).toEqual([]);
    expect(limits.calls).toBe(0);

    // One .mthds file, by path in any letter case or inline, makes the list a method.
    for (const files of [
      [{ path: "finance/payroll.xlsx" }, { path: "finance/PAYROLL.MTHDS" }],
      [{ path: "finance/payroll.xlsx" }, { content: 'domain = "payroll"' }],
    ]) {
      const named = await resolveMethodSource(
        { files },
        fakeFileResolver({
          "finance/payroll.xlsx": "PK",
          "finance/PAYROLL.MTHDS": 'domain = "payroll"',
        }),
        "one_selector",
        limitsReader(),
      );
      expect(named.faults.map((error) => error.location?.field)).not.toContain("files");
    }
  });

  it("refuses an empty .mthds file read from a { path } item at its item, naming it", async () => {
    const resolution = await resolveMethodSource(
      { files: [{ path: "m/main.mthds" }, { path: "m/blank.mthds" }] },
      fakeFileResolver({ "m/main.mthds": 'domain = "demo"', "m/blank.mthds": " \n\t" }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({
        domain: "input",
        location: { field: "files[1].path" },
        params: { argument: "files[1].path", reason: "empty_bundle" },
        message: expect.stringContaining("m/blank.mthds is empty."),
      }),
    ]);
    expect(resolution.tree).toBeUndefined();
  });

  it("roots the { path } items at the deepest directory holding them all, each shown as given", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const resolver = fakeFileResolver({
      "methods/invoice/invoice.mthds": 'domain = "invoice"',
      "methods/invoice/templates/invoice.xlsx": XLSX,
    });
    const limits = limitsReader();

    const resolution = await resolveMethodSource(
      {
        files: [
          { path: "methods/invoice/templates/invoice.xlsx" },
          { path: "methods/invoice/invoice.mthds" },
          { path: "./methods/invoice/invoice.mthds" },
        ],
      },
      resolver,
      "one_selector",
      limits,
    );

    expect(resolution.faults).toEqual([]);
    expect(resolution.tree?.files.map(({ treePath, shown }) => ({ treePath, shown }))).toEqual([
      { treePath: "invoice.mthds", shown: "methods/invoice/invoice.mthds" },
      { treePath: "templates/invoice.xlsx", shown: "methods/invoice/templates/invoice.xlsx" },
    ]);
    // Asked once, every file held to the deployment's limit on one file, and
    // the path given twice read once.
    expect(limits.calls).toBe(1);
    expect(resolver.reads).toEqual([
      { path: "methods/invoice/templates/invoice.xlsx", maxBytes: LIMITS.maxFileSize },
      { path: "methods/invoice/invoice.mthds", maxBytes: LIMITS.maxFileSize },
    ]);

    // The SDK's tree, built from the same bytes.
    const source = resolution.tree!.source;
    const listing = [
      { path: "invoice.mthds", bytes: encode('domain = "invoice"') },
      { path: "templates/invoice.xlsx", bytes: XLSX },
    ].map(({ path: treePath, bytes }) => ({
      path: treePath,
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    }));
    expect(source.files).toEqual(listing);
    expect(source.digest).toBe(treeDigest(listing));
    expect(await source.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    await expect(source.readFile("absent.mthds")).rejects.toThrow("not a file");
  });

  it("roots the tree at the working directory beside an inline item, so a lone { path } keeps its path", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const resolution = await resolveMethodSource(
      {
        files: [
          { content: 'domain = "invoice"', uri: "invoice.mthds" },
          { path: "templates/invoice.xlsx" },
        ],
      },
      fakeFileResolver({ "templates/invoice.xlsx": XLSX }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([]);
    expect(
      resolution.tree?.files.map(({ treePath, shown, onDisk }) => ({ treePath, shown, onDisk })),
    ).toEqual([
      { treePath: "invoice.mthds", shown: "invoice.mthds", onDisk: false },
      { treePath: "templates/invoice.xlsx", shown: "templates/invoice.xlsx", onDisk: true },
    ]);
  });

  it("refuses, beside an inline item, a { path } item outside the working directory", async () => {
    const resolver: FileResolver = {
      resolve: () => Promise.reject(new Error("a method's files are read as bytes")),
      statMethodFile: () =>
        Promise.resolve({
          ok: true,
          absolute: "/elsewhere/a.xlsx",
          relative: "../elsewhere/a.xlsx",
          size: 4,
        }),
      readMethodFile: () => Promise.reject(new Error("nothing is read once a check refuses")),
    };
    const resolution = await resolveMethodSource(
      { files: [{ content: 'domain = "a"' }, { path: "/elsewhere/a.xlsx" }] },
      resolver,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({ location: { field: "files[1].path" }, domain: "input" }),
    ]);
    expect(resolution.faults[0]?.message).toContain("Beside an inline item");
  });

  it("gives an inline item another name when a { path } item takes its uri's", async () => {
    const resolution = await resolveMethodSource(
      {
        files: [{ path: "main.mthds" }, { content: 'domain = "x"', uri: "elsewhere/MAIN.mthds" }],
      },
      fakeFileResolver({ "main.mthds": 'domain = "m"' }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.tree?.files.map((file) => file.treePath)).toEqual([
      "bundle.mthds",
      "main.mthds",
    ]);
  });

  it("refuses path items instructively when no resolver is provided (hosted)", async () => {
    const resolution = await resolveMethodSource(
      { files: [{ content: 'domain = "demo"' }, { path: "methods/bundle.mthds" }] },
      undefined,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toHaveLength(1);
    const error = resolution.faults[0];
    expect(error?.code).toBe("client.argument_invalid");
    expect(error?.domain).toBe("input");
    expect(error?.params).toEqual({ argument: "files[1].path", reason: "not_readable_here" });
    expect(error?.location?.field).toBe("files[1].path");
    expect(error?.message).toMatch(
      /^This deployment cannot read files from disk; submit the file contents instead\. /,
    );
    expect(error?.message).toContain("{ content, uri? }");
    expect(error?.message).toContain("npx @pipelex/mcp");
    expect(error?.retry).toBe("no");
  });

  it("refuses a blank path, an empty content and a blank uri, before the resolver runs", async () => {
    const resolver = fakeFileResolver({});
    const resolution = await resolveMethodSource(
      { files: [{ path: "  " }, { content: " " }, { content: "x", uri: "" }] },
      resolver,
      "run_source",
      limitsReader(),
    );

    expect(
      resolution.faults.map((error) => [
        error.location?.field,
        error.params?.reason,
        error.message,
      ]),
    ).toEqual([
      ["files[0].path", "empty", expect.stringMatching(/^File path must not be empty\. /)],
      ["files[1].content", "empty", expect.stringMatching(/^File content must not be empty\. /)],
      [
        "files[2].uri",
        "empty",
        expect.stringMatching(/^File uri must not be empty when supplied\. /),
      ],
    ]);
    expect(resolver.stats).toEqual([]);
    expect(resolver.reads).toEqual([]);
    expect(resolution.tree).toBeUndefined();
  });

  it("maps resolver failures to problems at the item's path, reading nothing", async () => {
    const resolver = fakeFileResolver({ "present.mthds": 'domain = "p"' });
    const limits = limitsReader();
    const resolution = await resolveMethodSource(
      {
        files: [
          { path: "present.mthds" },
          { path: "missing.mthds" },
          { path: "also-missing.mthds" },
        ],
      },
      resolver,
      "one_selector",
      limits,
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({
        code: "client.argument_invalid",
        domain: "input",
        location: { field: "files[1].path" },
        message: "File not found: missing.mthds Check the path.",
        retry: "no",
      }),
      expect.objectContaining({ location: { field: "files[2].path" } }),
    ]);
    // Every item was checked, and no byte read nor limit asked before they all passed.
    expect(resolver.stats).toEqual(["present.mthds", "missing.mthds", "also-missing.mthds"]);
    expect(resolver.reads).toEqual([]);
    expect(limits.calls).toBe(0);
  });

  it("refuses a name no tree holds, and two names that collide, at their items", async () => {
    const hidden = await resolveMethodSource(
      { files: [{ path: "m/main.mthds" }, { path: "m/.drafts/old.mthds" }] },
      fakeFileResolver({ "m/main.mthds": "a", "m/.drafts/old.mthds": "b" }),
      "one_selector",
      limitsReader(),
    );
    expect(hidden.faults).toEqual([
      expect.objectContaining({ location: { field: "files[1].path" }, domain: "input" }),
    ]);
    expect(hidden.faults[0]?.message).toContain(".drafts/old.mthds");

    const colliding = await resolveMethodSource(
      { files: [{ path: "m/Main.mthds" }, { path: "m/main.mthds" }] },
      fakeFileResolver({ "m/Main.mthds": "a", "m/main.mthds": "b" }),
      "one_selector",
      limitsReader(),
    );
    expect(colliding.faults.map((error) => error.location?.field)).toEqual([
      "files[0].path",
      "files[1].path",
    ]);
    expect(colliding.faults[0]?.message).toContain("case-insensitive");
  });

  it("refuses two spellings of one name once Unicode-normalized, at the second", async () => {
    const decomposed = "m/cafe\u0301.mthds";
    const composed = "m/caf\u00e9.mthds";
    const resolver = fakeFileResolver({ [decomposed]: "a", [composed]: "b" });
    const resolution = await resolveMethodSource(
      { files: [{ path: decomposed }, { path: composed }] },
      resolver,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({ location: { field: "files[1].path" }, domain: "input" }),
    ]);
    expect(resolution.faults[0]?.message).toContain("two spellings of one name");
    expect(resolver.reads).toEqual([]);
  });

  it("holds the tree to the deployment's file count and total size, before reading", async () => {
    const files = { "a.mthds": "aaaa", "b.mthds": "bbbb" };
    const counting = fakeFileResolver(files);
    const counted = await resolveMethodSource(
      { files: [{ path: "a.mthds" }, { path: "b.mthds" }] },
      counting,
      "one_selector",
      limitsReader({ ...LIMITS, maxFileCount: 1 }),
    );
    expect(counted.faults).toEqual([expect.objectContaining({ location: { field: "files" } })]);
    expect(counted.faults[0]?.message).toContain("past the limit of 1");
    expect(counting.reads).toEqual([]);

    const weighing = fakeFileResolver(files);
    const weighed = await resolveMethodSource(
      { files: [{ path: "a.mthds" }, { content: "cccc" }] },
      weighing,
      "one_selector",
      limitsReader({ ...LIMITS, maxTotalSize: 7 }),
    );
    expect(weighed.faults).toEqual([expect.objectContaining({ location: { field: "files" } })]);
    expect(weighed.faults[0]?.message).toContain("more than 7 bytes in all");
    expect(weighing.reads).toEqual([]);

    const sizing = fakeFileResolver({ "a.mthds": "a".repeat(10) });
    const sized = await resolveMethodSource(
      { files: [{ path: "a.mthds" }] },
      sizing,
      "one_selector",
      limitsReader({ ...LIMITS, maxFileSize: 8 }),
    );
    expect(sized.faults).toEqual([
      expect.objectContaining({ location: { field: "files[0].path" } }),
    ]);
    expect(sized.faults[0]?.message).toContain("10 bytes, past the limit of 8 bytes");
    expect(sizing.reads).toEqual([]);
  });

  it("stops reading at the total when a file grew between its stat and its read", async () => {
    const resolver = fakeFileResolver(
      { "a.mthds": "aaaa", "b.mthds": "bbbb", "c.mthds": "cccc" },
      { grown: { "a.mthds": "a".repeat(12) } },
    );
    const resolution = await resolveMethodSource(
      { files: [{ path: "a.mthds" }, { path: "b.mthds" }, { path: "c.mthds" }] },
      resolver,
      "one_selector",
      limitsReader({ ...LIMITS, maxTotalSize: 14 }),
    );

    expect(resolution.faults).toEqual([expect.objectContaining({ location: { field: "files" } })]);
    expect(resolution.faults[0]?.message).toContain("more than 14 bytes in all");
    expect(resolver.reads.map((read) => read.path)).toEqual(["a.mthds", "b.mthds"]);
  });

  it("refuses a file holding what looks like a secret at its item, quoting nothing of it", async () => {
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const resolution = await resolveMethodSource(
      {
        files: [
          { path: "m/main.mthds" },
          { path: "m/templates/notes.html" },
          { content: `api_key = "${key}"` },
        ],
      },
      fakeFileResolver({ "m/main.mthds": 'domain = "m"', "m/templates/notes.html": key }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults.map((error) => error.location?.field)).toEqual([
      "files[1].path",
      "files[2].content",
    ]);
    expect(resolution.faults[0]?.message).toContain(
      "m/templates/notes.html (it holds an AWS access key id)",
    );
    // A listed file is kept out by leaving it off the list, not by a folder's rule.
    expect(resolution.faults[0]?.message).toContain("leave the file off the list of files");
    expect(resolution.faults[0]?.message).not.toContain(".gitignore");
    expect(resolution.faults[0]?.message).toContain("call the tool again");
    for (const error of resolution.faults) {
      expect(JSON.stringify(error)).not.toContain(key);
    }
    expect(resolution.tree).toBeUndefined();
  });
});

/** A folder resolver over in-memory files, recording the limits each read was held to. */
function fakeFolderResolver(
  files: Record<string, string | Uint8Array>,
  overrides: Partial<FileResolver> = {},
): FileResolver & { limits: ListingLimits[] } {
  const limits: ListingLimits[] = [];
  return {
    limits,
    resolve: () => Promise.reject(new Error("a folder is not read file by file")),
    locateMethodDir: (methodDir) =>
      Promise.resolve({ ok: true, folder: `/w/${methodDir}`, methodDir }),
    readMethodTree: (_location, options) => {
      limits.push(options.limits);
      const bytes = new Map(
        Object.entries(files).map(([path, content]) => [
          path,
          typeof content === "string" ? encode(content) : content,
        ]),
      );
      const listing = [...bytes].map(([path, read]) => ({
        path,
        size: read.byteLength,
        sha256: sha256Hex(read),
      }));
      return Promise.resolve({ ok: true, files: listing, digest: treeDigest(listing), bytes });
    },
    ...overrides,
  };
}

describe("resolveMethodSource on method_dir", () => {
  const FOLDER = { "main.mthds": 'domain = "demo"', "templates/a.html": "<p>{{ x }}</p>" };

  it("resolves nothing when the method is named by a selector", async () => {
    const limits = limitsReader();
    const resolution = await resolveMethodSource(
      { method_ref: "github.com/acme/methods/invoice" },
      fakeFolderResolver(FOLDER),
      "one_selector",
      limits,
    );

    expect(resolution).toEqual({ faults: [] });
    expect(limits.calls).toBe(0);
  });

  it("sends the folder's whole tree under the deployment's limits, each file shown under method_dir", async () => {
    const resolver = fakeFolderResolver(FOLDER);
    const resolution = await resolveMethodSource(
      { method_dir: "m" },
      resolver,
      "run_source",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([]);
    expect(resolution.tree?.fromFolder).toBe(true);
    expect(resolution.tree?.files.map(({ treePath, shown }) => ({ treePath, shown }))).toEqual([
      { treePath: "main.mthds", shown: "m/main.mthds" },
      { treePath: "templates/a.html", shown: "m/templates/a.html" },
    ]);
    expect(resolution.tree?.source.files.map((file) => file.path)).toEqual([
      "main.mthds",
      "templates/a.html",
    ]);
    expect(resolver.limits).toEqual([LIMITS]);
  });

  it("refuses an empty .mthds file before anything is sent, naming it, and keeps an empty file of another kind", async () => {
    const refused = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver({ ...FOLDER, "steps/blank.mthds": "  \n" }),
      "one_selector",
      limitsReader(),
    );
    expect(refused.faults).toEqual([
      expect.objectContaining({
        domain: "input",
        location: { field: "method_dir" },
        message: expect.stringContaining(`${path.join("m", "steps", "blank.mthds")} is empty.`),
      }),
    ]);
    expect(refused.tree).toBeUndefined();

    const kept = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver({ ...FOLDER, "notes.md": "" }),
      "one_selector",
      limitsReader(),
    );
    expect(kept.faults).toEqual([]);
  });

  it("refuses a blank folder before reading anything", async () => {
    const resolver = fakeFolderResolver(FOLDER);
    const resolution = await resolveMethodSource(
      { method_dir: "  " },
      resolver,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({
        domain: "input",
        location: { field: "method_dir" },
        params: { argument: "method_dir", reason: "empty" },
        message: expect.stringContaining("method_dir must not be empty when supplied."),
      }),
    ]);
    expect(resolver.limits).toEqual([]);
  });

  it("refuses a folder beside files or an address on every tool, at the second field", async () => {
    for (const rule of ["one_selector", "run_source"] as const) {
      const resolution = await resolveMethodSource(
        {
          method_dir: "m",
          files: [{ content: 'domain = "demo"' }],
          method_ref: "github.com/acme/methods/invoice",
        },
        fakeFolderResolver(FOLDER),
        rule,
        limitsReader(),
      );

      expect(resolution.faults.map((error) => error.location?.field)).toEqual([
        "method_dir",
        "method_ref",
      ]);
      expect(resolution.faults[0]?.message).toContain(
        "method_dir and files are mutually exclusive",
      );
      expect(resolution.tree).toBeUndefined();
    }
  });

  it("refuses a folder beside a method_id on the tooling tools, and pairs them on a run", async () => {
    const tooling = await resolveMethodSource(
      { method_dir: "m", method_id: "mt_abc123" },
      fakeFolderResolver(FOLDER),
      "one_selector",
      limitsReader(),
    );
    expect(tooling.faults).toEqual([
      expect.objectContaining({ location: { field: "method_id" }, retry: "no" }),
    ]);

    const run = await resolveMethodSource(
      { method_dir: "m", method_id: "mt_abc123" },
      fakeFolderResolver(FOLDER),
      "run_source",
      limitsReader(),
    );
    expect(run.faults).toEqual([]);
    expect(run.tree?.files).toHaveLength(2);
  });

  it("says when a deployment cannot read a folder", async () => {
    const resolution = await resolveMethodSource(
      { method_dir: "m" },
      undefined,
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toEqual([
      expect.objectContaining({
        domain: "input",
        location: { field: "method_dir" },
        message: expect.stringContaining(
          "This deployment cannot read a folder from disk; submit the method's files instead.",
        ),
      }),
    ]);
  });

  it("locates every refusal of the folder at method_dir, the locating and the reading", async () => {
    const unlocated = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver(FOLDER, {
        locateMethodDir: () =>
          Promise.resolve({
            ok: false,
            refusals: [{ message: "first", remedy: "one", reason: "not_found", unreadable: "m" }],
          }),
      }),
      "one_selector",
      limitsReader(),
    );
    const unread = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver(FOLDER, {
        readMethodTree: () =>
          Promise.resolve({
            ok: false,
            refusals: [
              { message: "second", remedy: "two" },
              { message: "third", remedy: "three" },
            ],
          }),
      }),
      "one_selector",
      limitsReader(),
    );

    expect([...unlocated.faults, ...unread.faults]).toEqual(
      [
        ["client.file_unreadable", "first one"],
        ["client.argument_invalid", "second two"],
        ["client.argument_invalid", "third three"],
      ].map(([code, message]) =>
        expect.objectContaining({
          code,
          domain: "input",
          location: { field: "method_dir" },
          message,
          retry: "no",
        }),
      ),
    );
    expect(unlocated.faults[0]?.params).toEqual({ path: "m", reason: "not_found" });
  });

  it("refuses a folder holding what looks like a secret, naming each file under method_dir", async () => {
    const resolution = await resolveMethodSource(
      { method_dir: "m" },
      fakeFolderResolver({
        ...FOLDER,
        "keys/deploy.key": "not a zip",
        "notes.md": "token ghp_" + "a".repeat(36),
      }),
      "one_selector",
      limitsReader(),
    );

    expect(resolution.faults).toHaveLength(1);
    expect(resolution.faults[0]).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "method_dir", reason: "secret_suspected" },
      location: { field: "method_dir" },
    });
    expect(resolution.faults[0]?.message).toContain(
      "m/keys/deploy.key (it is named like a key file",
    );
    expect(resolution.faults[0]?.message).toContain("m/notes.md (it holds a GitHub token)");
    expect(resolution.tree).toBeUndefined();
  });
});

describe("withFilesSent", () => {
  const problem = argumentProblem("files", "refused", "m", "h");

  async function treeOf(source: MethodSourceInput, resolver?: FileResolver) {
    const resolution = await resolveMethodSource(source, resolver, "one_selector", limitsReader());
    return resolution.tree!;
  }

  it("returns a result that sent no tree unchanged", () => {
    const result = { structuredContent: { status: "error", problem } };

    expect(withFilesSent(result, undefined)).toBe(result);
  });

  it("lists a folder's files and leaves the problem as the API stated it", async () => {
    const result: {
      structuredContent: { status: string; problem?: Problem; files_sent?: string[] };
    } = { structuredContent: { status: "error", problem } };

    const listed = withFilesSent(
      result,
      await treeOf({ method_dir: "m" }, fakeFolderResolver({ "main.mthds": "x" })),
    );

    expect(listed.structuredContent.files_sent).toEqual(["m/main.mthds"]);
    expect(listed.structuredContent.problem).toBe(problem);
  });

  it("lists the files given, an inline item under the name it was sent as", async () => {
    const result: {
      structuredContent: { status: string; problem?: Problem; files_sent?: string[] };
    } = { structuredContent: { status: "error", problem } };

    const listed = withFilesSent(
      result,
      await treeOf(
        { files: [{ path: "m/main.mthds" }, { content: "y" }] },
        fakeFileResolver({ "m/main.mthds": "x" }),
      ),
    );

    expect(listed.structuredContent.files_sent).toEqual(["bundle.mthds", "m/main.mthds"]);
    expect(listed.structuredContent.problem?.location?.field).toBe("files");
  });

  it("lists no file on a result marked unsent", async () => {
    const result: {
      structuredContent: { status: string; problem?: Problem; files_sent?: string[] };
    } = markUnsent({ structuredContent: { status: "error", problem } });

    const bare = withFilesSent(
      result,
      await treeOf({ method_dir: "m" }, fakeFolderResolver({ "main.mthds": "x" })),
    );

    expect(bare.structuredContent).not.toHaveProperty("files_sent");
    expect(bare).toBe(result);
  });

  it("reads only the SDK's refusal of an argument as a failure before sending", () => {
    expect(failedBeforeSending(new RequestArgumentError("bad base URL"))).toBe(true);
    expect(
      failedBeforeSending(new ApiUnreachableError("reset", DEFAULT_API_URL, "ECONNRESET")),
    ).toBe(false);
    expect(failedBeforeSending(new Error("anything else"))).toBe(false);
  });

  it("lists the files sent on a produced verdict", async () => {
    const result: { structuredContent: { status: string; files_sent?: string[] } } = {
      structuredContent: { status: "ok" },
    };

    const listed = withFilesSent(
      result,
      await treeOf({ method_dir: "m" }, fakeFolderResolver({ "main.mthds": "x" })),
    );

    expect(listed.structuredContent).toEqual({ status: "ok", files_sent: ["m/main.mthds"] });
  });
});

describe("toolResultContent", () => {
  it("returns just the summary when no tree was sent", () => {
    expect(toolResultContent("# Validation passed")).toEqual([
      { type: "text", text: "# Validation passed" },
    ]);
    expect(toolResultContent("Done.", [])[0].text).toBe("Done.");
  });

  it("closes a problem's summary with every file a tree sent", () => {
    const summary = problemSummary(argumentProblem("method_dir", "refused", "m", "h"));

    const [content] = toolResultContent(summary, ["m/main.mthds", "m/templates/a `b`.html"]);

    expect(content.text).toBe(
      [
        summary,
        "",
        "## Files sent",
        "",
        "The method's tree, every file this call sent and nothing else:",
        "",
        "- `m/main.mthds`",
        // A backtick in a path cannot close the span it is shown in.
        "- ``m/templates/a `b`.html``",
      ].join("\n"),
    );
  });

  it("keeps a crafted sentence on one line, so it cannot open a heading or end a list", () => {
    const problem = faultsProblem([
      argumentProblem(
        "files[0].path",
        "not_found",
        "File not found: a\n\n## b.mthds",
        "Check\nthe path.",
      ),
      argumentProblem("method_id", "empty", "method_id must not be empty."),
    ]);

    const [content] = toolResultContent(problemSummary(problem));

    expect(problem.errors?.[0]?.detail).toBe("File not found: a ## b.mthds Check the path.");
    expect(content.text).not.toMatch(/^## b\.mthds/m);
    expect(content.text).toContain(
      "- `client.argument_invalid`: File not found: a ## b.mthds Check the path. (field 'files[0].path')",
    );
  });
});

describe("validateMethodSelectorRequest", () => {
  // Whether `method_dir` or `files` resolved into a tree.
  const files = true;
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  it("accepts each selector alone, under both rules", () => {
    for (const rule of ["one_selector", "run_source"] as const) {
      expect(validateMethodSelectorRequest(files, {}, { rule })).toEqual([]);
      expect(validateMethodSelectorRequest(false, { method_ref: ADDRESS }, { rule })).toEqual([]);
      expect(validateMethodSelectorRequest(false, { method_id: "mt_abc123" }, { rule })).toEqual(
        [],
      );
    }
  });

  it("rejects a request with no selector at all, naming the accepted forms", () => {
    const errors = validateMethodSelectorRequest(false, {}, { rule: "one_selector" });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.domain).toBe("input");
    expect(errors[0]?.location?.field).toBe("files");
    expect(errors[0]?.message).toMatch(
      /^Provide a method folder, MTHDS files, a method_ref address, or a method_id\. /,
    );
    expect(errors[0]?.params).toEqual({ argument: "files", reason: "missing" });
    expect(errors[0]?.message).toContain("github.com/");
  });

  it("rejects a blank method_id at method_id, with or without files", () => {
    for (const presentFiles of [false, files]) {
      const errors = validateMethodSelectorRequest(
        presentFiles,
        { method_id: "  " },
        { rule: "run_source" },
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.domain).toBe("input");
      expect(errors[0]?.location?.field).toBe("method_id");
      expect(errors[0]?.retry).toBe("no");
    }
  });

  it("rejects a blank method_ref at method_ref", () => {
    const errors = validateMethodSelectorRequest(
      false,
      { method_ref: "  " },
      { rule: "one_selector" },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.domain).toBe("input");
    expect(errors[0]?.location?.field).toBe("method_ref");
  });

  it("accepts any non-blank selector — format stays server-owned", () => {
    expect(
      validateMethodSelectorRequest(false, { method_id: "not-an-mt-id" }, { rule: "one_selector" }),
    ).toEqual([]);
    expect(
      validateMethodSelectorRequest(
        false,
        { method_ref: "not-an-address" },
        { rule: "one_selector" },
      ),
    ).toEqual([]);
  });

  it("one_selector: rejects every pairing, each at the extra selector", () => {
    const filesAndId = validateMethodSelectorRequest(
      files,
      { method_id: "mt_abc123" },
      { rule: "one_selector" },
    );
    expect(filesAndId).toHaveLength(1);
    expect(filesAndId[0]?.location?.field).toBe("method_id");
    expect(filesAndId[0]?.message).toContain("mutually exclusive");

    const filesAndRef = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS },
      { rule: "one_selector" },
    );
    expect(filesAndRef).toHaveLength(1);
    expect(filesAndRef[0]?.location?.field).toBe("method_ref");

    const refAndId = validateMethodSelectorRequest(
      false,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "one_selector" },
    );
    expect(refAndId).toHaveLength(1);
    expect(refAndId[0]?.location?.field).toBe("method_id");
  });

  it("run_source: files + method_id is the legal linkage pair", () => {
    expect(
      validateMethodSelectorRequest(files, { method_id: "mt_abc123" }, { rule: "run_source" }),
    ).toEqual([]);
  });

  it("run_source: method_ref pairs with nothing", () => {
    const filesAndRef = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS },
      { rule: "run_source" },
    );
    expect(filesAndRef).toHaveLength(1);
    expect(filesAndRef[0]?.location?.field).toBe("method_ref");

    const refAndId = validateMethodSelectorRequest(
      false,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "run_source" },
    );
    expect(refAndId).toHaveLength(1);
    expect(refAndId[0]?.location?.field).toBe("method_id");
    expect(refAndId[0]?.message).toContain("provenance");
  });

  it("all three selectors report each illegal pairing", () => {
    const errors = validateMethodSelectorRequest(
      files,
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      { rule: "one_selector" },
    );

    expect(errors.map((error) => error.location?.field).sort()).toEqual([
      "method_id",
      "method_id",
      "method_ref",
    ]);
  });

  it("a blank selector earns its own error, not a pairing error", () => {
    // The blank method_ref is invalid on its own; it must not also produce
    // an exclusivity error against the files.
    const errors = validateMethodSelectorRequest(
      files,
      { method_ref: "  " },
      { rule: "run_source" },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("must not be empty");
  });
});

describe("validateRunIdRequest", () => {
  it("rejects an empty or whitespace-only run id", () => {
    for (const runId of ["", "   ", "\n\t"]) {
      const errors = validateRunIdRequest(runId);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.domain).toBe("input");
      expect(errors[0]?.location?.field).toBe("run_id");
    }
  });

  it("accepts a normal run id", () => {
    expect(validateRunIdRequest("01JRUN0000000000000000TEST")).toEqual([]);
  });
});

/**
 * What the SDK throws when the API refuses a request: the real client, reading
 * a stubbed answer, so the verdict on the error is the one the SDK decides from
 * the problem document it parsed. `problem` is the document's members; a
 * string is sent as the raw body, as a bare runner or a gateway answers.
 */
async function refused(
  status: number,
  problem: Record<string, unknown> | string = {},
): Promise<ApiResponseError> {
  const body = typeof problem === "string" ? problem : JSON.stringify({ status, ...problem });
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: { "content-type": "application/problem+json" },
      }),
    ),
  );
  try {
    await createPipelexApiClient({ baseUrl: DEFAULT_API_URL }).getMethod("mt_test");
  } catch (err) {
    if (err instanceof ApiResponseError) return err;
    throw err;
  }
  throw new Error("the client did not refuse");
}

/** What the SDK throws when nothing answers: an `ApiUnreachableError` carrying the network code. */
async function unreachable(code: string): Promise<unknown> {
  vi.stubGlobal("fetch", () =>
    Promise.reject(
      new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) }),
    ),
  );
  return createPipelexApiClient({ baseUrl: DEFAULT_API_URL })
    .getMethod("mt_test")
    .then(
      () => undefined,
      (err: unknown) => err,
    );
}

describe("problemOf", () => {
  it("relays the problem document the API answered, as it came, with its request id", async () => {
    const err = await refused(409, {
      type: "https://docs.pipelex.com/errors/pipelex.catalog.update_conflict",
      title: "The method changed since it was read",
      detail: "The method 'mt_test' changed after it was read, so the update was not applied.",
      code: "pipelex.catalog.update_conflict",
      domain: "input",
      retry: "no",
      next_step: { kind: "change_input", detail: "Read the method again." },
      params: { method_id: "mt_test" },
      location: { field: "expected_updated_at" },
      request_id: "req_123",
      limit: { name: "kept as received" },
    });

    const problem = problemOf(err);

    expect(problem).toMatchObject({
      code: "pipelex.catalog.update_conflict",
      domain: "input",
      retry: "no",
      status: 409,
      next_step: { kind: "change_input", detail: "Read the method again." },
      params: { method_id: "mt_test" },
      location: { field: "expected_updated_at" },
      request_id: "req_123",
      limit: { name: "kept as received" },
    });
    expect(problemSchema.safeParse(problem).success).toBe(true);
  });

  it("drops the operator's diagnostics, which the caller never sees", async () => {
    const err = await refused(500, {
      type: "https://mthds.ai/errors/runtime.unexpected",
      title: "An unexpected error occurred",
      detail: "The runtime met an unexpected error.",
      code: "runtime.unexpected",
      domain: "runtime",
      retry: "no",
      next_step: { kind: "report", detail: "Report this." },
      diagnostics: { traceback: "Traceback (most recent call last): …" },
    });

    const problem = problemOf(err);

    expect(problem.code).toBe("runtime.unexpected");
    expect(problem).not.toHaveProperty("diagnostics");
  });

  it("takes the SDK's own problem for an error it raised before or without an answer", async () => {
    expect(problemOf(await unreachable("ECONNREFUSED"))).toMatchObject({
      code: "client.unreachable",
      domain: "runtime",
      retry: "yes",
    });
    expect(
      problemOf(new RunLifecycleUnavailableError("no run lifecycle", DEFAULT_API_URL)),
    ).toMatchObject({
      code: "runtime.unsupported",
    });
    // A status alone, as a gateway answers it, reads by the edge's rule.
    expect(problemOf(await refused(401, "Unauthorized"))).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
    });
  });

  it("reads any other failure as runtime.unexpected, carrying its message", () => {
    expect(problemOf(new Error("socket hang up"))).toMatchObject({
      code: "runtime.unexpected",
      domain: "runtime",
      retry: "no",
      message: "socket hang up",
    });
    expect(problemOf("not an error")).not.toHaveProperty("message");
  });
});

describe("the problems of the workshop's own refusals", () => {
  it("builds a refused argument with its path, reason and sentence", () => {
    const problem = argumentProblem(
      "files[1].path",
      "empty",
      "File path must not be empty.",
      "Submit a file path.",
    );

    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "files[1].path", reason: "empty" },
      location: { field: "files[1].path" },
      message: "File path must not be empty. Submit a file path.",
    });
    expect(problem.next_step.kind).toBe("change_input");
    expect(problemSchema.safeParse(problem).success).toBe(true);
  });

  it("reads a resolver's refusal as an unreadable file, a busy one or a refused argument", () => {
    expect(
      refusalProblem("files[0].path", {
        message: "Could not read file a.mthds: EACCES",
        remedy: "Check its permissions.",
        reason: "EACCES",
        unreadable: "a.mthds",
      }),
    ).toMatchObject({
      code: "client.file_unreadable",
      params: { path: "a.mthds", reason: "EACCES" },
      location: { field: "files[0].path" },
    });
    expect(
      refusalProblem("files[0].path", {
        message: "a.mthds changed while it was read.",
        remedy: "Send it again.",
        busy: "a.mthds",
      }),
    ).toMatchObject({ code: "client.workspace_busy", retry: "yes", params: { path: "a.mthds" } });
    expect(
      refusalProblem("method_dir", {
        message: "Outside.",
        remedy: "Move it.",
        reason: "outside_workspace",
      }),
    ).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_dir", reason: "outside_workspace" },
    });
  });

  it("makes several faults one client.argument_invalid listing each as an item", () => {
    const empty = argumentProblem(
      "method_id",
      "empty",
      "method_id must not be empty.",
      "Pass one.",
    );
    const exclusive = argumentProblem(
      "method_ref",
      "mutually_exclusive",
      "files and method_ref are mutually exclusive.",
    );

    expect(faultsProblem([empty])).toBe(empty);
    const problem = faultsProblem([empty, exclusive]);

    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_id", reason: "several_faults" },
      location: { field: "method_id" },
    });
    expect(problem.errors).toEqual([
      {
        code: "client.argument_invalid",
        detail: "method_id must not be empty. Pass one.",
        params: { argument: "method_id", reason: "empty" },
        location: { field: "method_id" },
      },
      {
        code: "client.argument_invalid",
        detail: "files and method_ref are mutually exclusive.",
        params: { argument: "method_ref", reason: "mutually_exclusive" },
        location: { field: "method_ref" },
      },
    ]);
    expect(problemSchema.safeParse(problem).success).toBe(true);
    expect(() => faultsProblem([])).toThrow();
  });

  it("reports a fault a retry can clear on its own, so its retry verdict is kept", () => {
    const missing = argumentProblem(
      "inputs_path",
      "missing",
      "Supply the filled inputs, as inputs or as inputs_path.",
    );
    const busy = refusalProblem("method_dir", {
      message: "bundle.mthds changed while it was read.",
      remedy: "Save the file, then call again.",
      reason: "changed_while_read",
      busy: "methods/demo/bundle.mthds",
    });
    expect(busy.retry).toBe("yes");

    const unreadable = refusalProblem("files[1].path", {
      message: "notes.md could not be read.",
      remedy: "Make it readable, then call again.",
      reason: "unreadable",
      unreadable: "methods/demo/notes.md",
    });

    const problem = faultsProblem([missing, busy, unreadable]);

    expect(problem).toMatchObject({
      code: "client.workspace_busy",
      retry: "yes",
      params: { path: "methods/demo/bundle.mthds" },
      location: { field: "method_dir" },
    });
    expect(problem.errors).toBeUndefined();
    expect(problem.message).toContain("bundle.mthds changed while it was read.");
    // The other faults are named by code and place, so none is lost.
    expect(problem.message).toContain(
      "Other faults were found in this call too: client.argument_invalid at inputs_path; client.file_unreadable at files[1].path.",
    );
    expect(problemSchema.safeParse(problem).success).toBe(true);
  });
});

describe("problemSummary", () => {
  it("renders the title, detail, message, next step, code and request id", async () => {
    const problem = {
      ...problemOf(await refused(422, { detail: "Bad field." })),
      request_id: "req_abc",
    };

    const text = problemSummary(problem);

    expect(text).toContain(`## ${problem.title}`);
    expect(text).toContain(problem.detail);
    expect(text).toContain(
      `**Next step** (\`${problem.next_step.kind}\`): ${problem.next_step.detail}`,
    );
    expect(text).toContain(`Code: \`${problem.code}\``);
    expect(text).toContain("Request id: `req_abc`");
  });

  it("renders the workshop's sentence and each fault of several", () => {
    const text = problemSummary(
      faultsProblem([
        argumentProblem("method_id", "empty", "method_id must not be empty."),
        argumentProblem("run_id", "empty", "run_id must not be empty."),
      ]),
    );

    expect(text).toContain("Several arguments were refused");
    expect(text).toContain("### Errors");
    expect(text).toContain(
      "- `client.argument_invalid`: method_id must not be empty. (field 'method_id')",
    );
    expect(text).toContain(
      "- `client.argument_invalid`: run_id must not be empty. (field 'run_id')",
    );
  });

  it("closes a refused credential with where the key and the API came from", async () => {
    const problem = problemOf(await refused(401, "Unauthorized"));
    const notes = {
      apiKey: "The key saved in ~/.pipelex/.env was refused.",
      baseUrl: "The API is dev.",
    };

    const text = problemSummary(problem, notes);

    expect(text.endsWith(`${notes.apiKey}\n\n${notes.baseUrl}`)).toBe(true);
    // A context without notes names the variables.
    expect(problemSummary(problem)).toContain("PIPELEX_API_KEY");
    expect(problemSummary(problem)).toContain("PIPELEX_BASE_URL");
  });

  it("names the API alone where the fix may be the base URL, and neither note elsewhere", async () => {
    const notes = { apiKey: "KEY NOTE", baseUrl: "BASE URL NOTE" };

    const unreached = problemSummary(problemOf(await unreachable("ENOTFOUND")), notes);
    expect(unreached).toContain("BASE URL NOTE");
    expect(unreached).not.toContain("KEY NOTE");

    const role = problemSummary(
      problemOf(
        await refused(403, {
          type: "https://mthds.ai/errors/auth.forbidden",
          title: "The identity lacks a requirement",
          detail: "The request's identity lacks 'admin', which this operation needs.",
          code: "auth.forbidden",
          domain: "account",
          retry: "no",
          next_step: { kind: "contact_owner", detail: "Ask an admin." },
        }),
      ),
      notes,
    );
    // A role refusal is not the key's fault: neither note sends the reader to change it.
    expect(role).not.toContain("KEY NOTE");
    expect(role).not.toContain("BASE URL NOTE");

    const refusal = problemSummary(
      argumentProblem("run_id", "empty", "run_id must not be empty."),
      notes,
    );
    expect(refusal).not.toContain("NOTE");

    // One code names two settings: only the base URL's refusal names the API.
    const notConfigured = (setting: string) =>
      problemSummary(
        { ...problemOf(new Error("x")), code: "client.not_configured", params: { setting } },
        notes,
      );
    expect(notConfigured("base_url")).toContain("BASE URL NOTE");
    expect(notConfigured("working_directory")).not.toContain("NOTE");
  });
});

describe("isExecutionLocusRefusal", () => {
  it("reads the execution-locus gate by the problem's code", async () => {
    const problem = (code: string) => ({
      type: `https://docs.pipelex.com/errors/${code}`,
      title: "Refused",
      detail: "The method ships Python code.",
      code,
      domain: "operator",
      retry: "no",
      next_step: { kind: "report", detail: "Run it elsewhere." },
    });

    expect(
      isExecutionLocusRefusal(
        await refused(501, problem("pipelex.deployment.custom_code_requires_sandbox")),
      ),
    ).toBe(true);
    expect(
      isExecutionLocusRefusal(
        await refused(422, problem("pipelex.deployment.python_structures_refused")),
      ),
    ).toBe(true);
    expect(isExecutionLocusRefusal(await refused(501, { detail: "Not implemented" }))).toBe(false);
    expect(
      isExecutionLocusRefusal(new Error("pipelex.deployment.custom_code_requires_sandbox")),
    ).toBe(false);
  });
});

describe("the plain-http rule", () => {
  it("accepts plain http exactly when the configured API is itself plain http", () => {
    expect(allowsPlainHttp({ baseUrl: "http://localhost:8081" })).toBe(true);
    expect(allowsPlainHttp({ baseUrl: DEFAULT_API_URL })).toBe(false);
    // A malformed base URL refuses; the client constructor reports it as config.
    expect(allowsPlainHttp({ baseUrl: "not a url" })).toBe(false);
  });

  it("lets the explicit override win in both directions", () => {
    expect(allowsPlainHttp({ baseUrl: DEFAULT_API_URL, allowHttp: true })).toBe(true);
    expect(allowsPlainHttp({ baseUrl: "http://localhost:8081", allowHttp: false })).toBe(false);
  });

  it("reads the override from the environment, failing closed on an unrecognized value", () => {
    expect(parseAllowHttpOverride(undefined)).toBeUndefined();
    expect(parseAllowHttpOverride("  ")).toBeUndefined();
    expect(parseAllowHttpOverride("true")).toBe(true);
    expect(parseAllowHttpOverride(" TRUE ")).toBe(true);
    expect(parseAllowHttpOverride("1")).toBe(true);
    expect(parseAllowHttpOverride("false")).toBe(false);
    expect(parseAllowHttpOverride("0")).toBe(false);
    expect(parseAllowHttpOverride("yes")).toBe(false);

    expect(buildArtifactFetchConfig({ [ALLOW_HTTP_ENV]: "true" }).allowHttp).toBe(true);
    expect(buildArtifactFetchConfig({})).not.toHaveProperty("allowHttp");
    expect(buildArtifactFetchConfig({}).baseUrl).toBe(DEFAULT_API_URL);
  });
});

describe("fetchItemProblem", () => {
  const uri = "pipelex-storage://org/run/out.png";

  it("reads the fetch boundary's codes as the SDK does, the item's detail as its message", () => {
    expect(
      fetchItemProblem({ code: "not_found", detail: "The object is gone." }, uri),
    ).toMatchObject({
      code: "input.reference_not_found",
      params: { input: uri },
      message: "The object is gone.",
    });
    expect(fetchItemProblem({ code: "plain_http_refused", detail: "" }, uri)).toMatchObject({
      code: "client.link_refused",
      params: { reason: "plain_http" },
    });
    expect(fetchItemProblem({ code: "redirect_refused", detail: "x" }, uri).params).toEqual({
      reason: "redirect",
    });
    expect(fetchItemProblem({ code: "store_error", detail: "x" }, uri)).toMatchObject({
      code: "runtime.unavailable",
      retry: "yes",
    });
  });

  it("keeps a valid problem whatever the wire relays", () => {
    for (const code of ["constructor", "toString", "", "brand_new_code"]) {
      const problem = fetchItemProblem({ code, detail: "x" }, uri);
      expect(problem.code).toBe("runtime.unexpected");
      expect(problemSchema.safeParse(problem).success).toBe(true);
    }
    const wire = { code: 42, detail: null } as unknown as { code: string; detail: string };
    const problem = fetchItemProblem(wire, uri);
    expect(problemSchema.safeParse(problem).success).toBe(true);
    expect(problem).not.toHaveProperty("message");
  });
});

describe("the image-candidate prefilter", () => {
  const PICTURE = "pipelex-storage://runs/01JRUN/outputs/illustration.png";
  const REPORT = "pipelex-storage://runs/01JRUN/outputs/report.pdf";
  const UNTYPED = "pipelex-storage://runs/01JRUN/outputs/blob";

  it("reads a reference's storage key as everything after the scheme", () => {
    expect(storageKeyOf(PICTURE)).toBe("runs/01JRUN/outputs/illustration.png");
    // Not a reference at all: answered as-is rather than silently truncated.
    expect(storageKeyOf("illustration.png")).toBe("illustration.png");
  });

  it("takes every known image extension, in any case", () => {
    for (const extension of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".PNG", ".JPeG"]) {
      expect(looksLikeImageKey(`runs/01JRUN/outputs/picture${extension}`)).toBe(true);
    }
  });

  it("takes a key with no extension, because only the fetched type can settle it", () => {
    expect(looksLikeImageKey("runs/01JRUN/outputs/blob")).toBe(true);
    // A leading dot is not an extension.
    expect(looksLikeImageKey("runs/01JRUN/outputs/.hidden")).toBe(true);
  });

  it("refuses an extension that is plainly not an image", () => {
    for (const key of ["out/report.pdf", "out/data.json", "out/notes.txt", "out/logo.svg"]) {
      expect(looksLikeImageKey(key)).toBe(false);
    }
  });

  it("ignores a query- or fragment-looking tail on the key", () => {
    expect(looksLikeImageKey("out/picture.png?v=2")).toBe(true);
    expect(looksLikeImageKey("out/report.pdf?v=2")).toBe(false);
  });

  it("walks a whole output and keeps only the candidates, in discovery order", () => {
    const mainStuff = {
      cover: { url: PICTURE, public_url: "https://store.example/x" },
      attachments: [{ url: REPORT }, { url: UNTYPED }],
    };

    expect(imageCandidatesOf(mainStuff)).toEqual([
      { uri: PICTURE, key: "runs/01JRUN/outputs/illustration.png" },
      { uri: UNTYPED, key: "runs/01JRUN/outputs/blob" },
    ]);
  });

  it("answers nothing for an output that references no stored file", () => {
    expect(imageCandidatesOf({ text: "no files here" })).toEqual([]);
  });
});

describe("blueprintMainPipeRefOf", () => {
  it("qualifies a bare main_pipe with the blueprint's domain", () => {
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "main" })).toBe("demo.main");
  });

  it("leaves an already-qualified main_pipe alone", () => {
    // The regression this function exists to hold: prefixing unconditionally
    // turned a cross-domain main_pipe into `demo.other.shout`, a ref that keys
    // neither pipe_io_contracts nor input_form, so the signature went missing
    // rather than being found.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "other.shout" })).toBe(
      "other.shout",
    );
  });

  it("answers nothing for a blueprint that declares no usable main pipe", () => {
    expect(blueprintMainPipeRefOf({ domain: "demo" })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "" })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: 7 })).toBeUndefined();
    // A bare main_pipe with no domain to qualify it cannot key either map.
    expect(blueprintMainPipeRefOf({ main_pipe: "main" })).toBeUndefined();
  });

  it("trims both members, as the SDK does", () => {
    // Load-bearing, not cosmetic: the SDK reads both through its own
    // `nonEmptyString`, and `mthds_prepare_inputs` delegates to the SDK.
    // Untrimmed, a padded `main_pipe` keyed nothing here and `demo.main` there.
    // Nothing upstream strips it: `DomainBlueprint.main_pipe` is a bare `str`
    // with no validator.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "  main  " })).toBe("demo.main");
    expect(blueprintMainPipeRefOf({ domain: "  demo  ", main_pipe: "main" })).toBe("demo.main");
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "  other.shout  " })).toBe(
      "other.shout",
    );
    // Whitespace-only is still empty, on both members.
    expect(blueprintMainPipeRefOf({ domain: "demo", main_pipe: "   " })).toBeUndefined();
    expect(blueprintMainPipeRefOf({ domain: "   ", main_pipe: "main" })).toBeUndefined();
  });

  it("treats a blueprint that is not an object as declaring nothing", () => {
    for (const blueprint of [undefined, null, "demo.main", 7, ["demo.main"]]) {
      expect(blueprintMainPipeRefOf(blueprint)).toBeUndefined();
    }
  });
});

describe("createPipelexApiClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The `Authorization` header a client built by the factory sends. */
  async function sentAuthorization(apiKey: string | undefined): Promise<string | null> {
    let seen: string | null = null;
    vi.stubGlobal("fetch", (_url: string, init?: { headers?: HeadersInit }) => {
      seen = new Headers(init?.headers).get("authorization");
      return Promise.resolve(Response.json({}));
    });
    await createPipelexApiClient({ baseUrl: "https://api.test", apiKey }).health();
    return seen;
  }

  it("sends the config's key, and no key at all when the config has none", async () => {
    // The SDK falls back to the process's own PIPELEX_API_KEY when it is handed
    // no key, which would put an ambient key on a call the workshop resolved as
    // keyless; the config's key is the whole decision.
    vi.stubEnv("PIPELEX_API_KEY", "plx_sk_ambient");

    expect(await sentAuthorization("plx_sk_config")).toBe("Bearer plx_sk_config");
    expect(await sentAuthorization(undefined)).toBeNull();
  });
});
