import { afterEach, describe, expect, it, vi } from "vitest";

import { INLINE_TREE_MAX_BYTES } from "@pipelex/sdk";
import type { PipeIOValidReport } from "@pipelex/sdk";
import { sha256Hex } from "mthds";

import { recordedTsZodReport } from "./codegen-fixture.js";
import { generateMthdsCode } from "./codegen.js";
import { buildMthdsInputs } from "./inputs.js";
import { bytesOf, fakeMethodResolver } from "./method-tree-fixtures.js";
import { prepareMthdsInputs } from "./prepare.js";

/**
 * The wire a method's tree leaves on, for the routes the workshop reaches
 * through the SDK's crate calls: `mthds_codegen` on `POST /v1/codegen`, and
 * `mthds_inputs_template` and `mthds_prepare_inputs` on `POST /v1/pipe-io`.
 * Every other test of these tools fakes the client and so sees only the tree
 * the workshop hands the SDK; these run the real `PipelexApiClient` over a
 * stubbed `fetch`, so they prove the body the platform receives: the MTHDS
 * protocol's `files` map from tree path to file entry, a file that is not
 * UTF-8 text as base64 when the tree travels inline, every file by hash once
 * it is too heavy for that, and never the old list of `{ content, source }`
 * items nor the `resources` the template files once rode.
 */

const recordedReport = await recordedTsZodReport();

const BUNDLE = 'domain = "invoice"';
/** A template's bytes, which are not UTF-8 text, so they travel inline as base64. */
const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x01]);

const FOLDER = { "invoice.mthds": BUNDLE, "templates/invoice.xlsx": XLSX };

/** The same folder with a data file that makes the tree too heavy to travel inline. */
const HEAVY_FOLDER = {
  ...FOLDER,
  "data/sample.bin": new Uint8Array(INLINE_TREE_MAX_BYTES + 1).fill(0xff),
};

/** A pipe I/O answer for a pipe declaring no input, which both pipe-io tools read. */
const PIPE_IO_REPORT = {
  is_valid: true,
  pipe_ref: "invoice.main",
  pipe_io_contracts: {},
  input_form: { "invoice.main": { fields: [] } },
  output_form: {},
  default_pipe_ref: "invoice.main",
  pending_signatures: [],
  is_runnable: true,
} as unknown as PipeIOValidReport;

interface SentRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Stub `fetch` as a Pipelex deployment that does or does not keep a blob
 * store, holding every blob it is asked about, and answering each route of
 * `answers` with its JSON. Every request is recorded with its parsed body.
 */
function stubDeployment(options: {
  blobStore: boolean;
  answers: Record<string, unknown>;
}): SentRequest[] {
  const sent: SentRequest[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    sent.push({ method, path: url.pathname, body });
    if (url.pathname === "/v1/version") {
      return Promise.resolve(Response.json({ version: "1.0.0", blob_store: options.blobStore }));
    }
    if (url.pathname === "/v1/blobs/missing") {
      return Promise.resolve(Response.json({ missing: [] }));
    }
    const answer = options.answers[url.pathname];
    return Promise.resolve(
      answer === undefined ? new Response("", { status: 404 }) : Response.json(answer),
    );
  });
  return sent;
}

/** The body of the one request sent to `route`. */
function bodyOf(sent: SentRequest[], route: string): Record<string, unknown> | undefined {
  const posted = sent.filter((request) => request.method === "POST" && request.path === route);
  expect(posted).toHaveLength(1);
  return posted[0]?.body;
}

/** The `files` map of a tree sent inline: each file as its text, or its base64 when it is not UTF-8. */
const INLINE_FILES = {
  "invoice.mthds": BUNDLE,
  "templates/invoice.xlsx": { base64: Buffer.from(XLSX).toString("base64") },
};

/** The `files` map of a tree sent by hash: each file as its hash and size. */
function hashFiles(folder: Record<string, string | Uint8Array>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(folder).map(([treePath, content]) => {
      const bytes = bytesOf(content);
      return [treePath, { sha256: sha256Hex(bytes), size: bytes.byteLength }];
    }),
  );
}

/**
 * How a test names the method: a folder at `methods`, or a list of files, an
 * inline `.mthds` item beside a template file read from the working directory.
 */
type MethodSource =
  | { method_dir: string }
  | { files: ({ content: string; uri?: string } | { path: string })[] };

/** The folder at `methods` holding `folder`. */
function folderSource(folder: Record<string, string | Uint8Array>) {
  return {
    source: { method_dir: "methods" } satisfies MethodSource,
    resolver: fakeMethodResolver({ folder }),
  };
}

/** The same method as a list of files: the bundle inline, the template by its path. */
function filesSource() {
  return {
    source: {
      files: [{ content: BUNDLE, uri: "invoice.mthds" }, { path: "templates/invoice.xlsx" }],
    } satisfies MethodSource,
    resolver: fakeMethodResolver({ files: { "templates/invoice.xlsx": XLSX } }),
  };
}

type Named = ReturnType<typeof folderSource> | ReturnType<typeof filesSource>;

/** The three tools, each called on the method `named` names against `baseUrl`. */
const TOOLS = [
  {
    tool: "mthds_codegen",
    route: "/v1/codegen",
    answer: recordedReport,
    call: (baseUrl: string, { source, resolver }: Named) =>
      generateMthdsCode({ ...source, target: "ts-zod" }, { baseUrl, resolver }),
  },
  {
    tool: "mthds_inputs_template",
    route: "/v1/pipe-io",
    answer: PIPE_IO_REPORT,
    call: (baseUrl: string, { source, resolver }: Named) =>
      buildMthdsInputs(source, { baseUrl, resolver }),
  },
  {
    tool: "mthds_prepare_inputs",
    route: "/v1/pipe-io",
    answer: PIPE_IO_REPORT,
    call: (baseUrl: string, { source, resolver }: Named) =>
      prepareMthdsInputs({ ...source, inputs: {} }, { baseUrl, resolver }),
  },
] as const;

describe("the tree on the wire of the crate routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const { tool, route, answer, call } of TOOLS) {
    it(`${tool} sends a small tree inline as the files map, a binary file as base64`, async () => {
      const sent = stubDeployment({ blobStore: true, answers: { [route]: answer } });

      const result = await call(`https://inline.${tool}.example`, folderSource(FOLDER));

      expect(result.structuredContent.status).toBe("ok");
      const body = bodyOf(sent, route);
      expect(body?.files).toEqual(INLINE_FILES);
      expect(body).not.toHaveProperty("resources");
      expect(body).not.toHaveProperty("tree");
      expect(sent.some((request) => request.path === "/v1/blobs/missing")).toBe(false);
    });

    it(`${tool} sends a tree too heavy to travel inline by hash, every file`, async () => {
      const sent = stubDeployment({ blobStore: true, answers: { [route]: answer } });

      const result = await call(`https://hash.${tool}.example`, folderSource(HEAVY_FOLDER));

      expect(result.structuredContent.status).toBe("ok");
      expect(bodyOf(sent, "/v1/blobs/missing")).toHaveProperty("digest");
      const body = bodyOf(sent, route);
      expect(body?.files).toEqual(hashFiles(HEAVY_FOLDER));
      expect(body).not.toHaveProperty("resources");
    });

    it(`${tool} sends a list of files as the same files map, each file under its tree path`, async () => {
      const sent = stubDeployment({ blobStore: false, answers: { [route]: answer } });

      const result = await call(`https://files.${tool}.example`, filesSource());

      expect(result.structuredContent.status).toBe("ok");
      const body = bodyOf(sent, route);
      expect(body?.files).toEqual(INLINE_FILES);
      expect(body).not.toHaveProperty("resources");
      expect(result.structuredContent.files_sent).toEqual([
        "invoice.mthds",
        "templates/invoice.xlsx",
      ]);
    });
  }
});
