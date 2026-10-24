import { afterEach, describe, expect, it, vi } from "vitest";

import { INLINE_TREE_MAX_BYTES, buildProblem } from "@pipelex/sdk";
import type { PipeIOValidReport } from "@pipelex/sdk";
import { sha256Hex } from "mthds";

import { recordedTsZodReport } from "./codegen-fixture.js";
import { generateMthdsCode } from "./codegen.js";
import { buildMthdsInputs } from "./inputs.js";
import { bytesOf, fakeMethodResolver } from "./method-tree-fixtures.js";
import { prepareMthdsInputs } from "./prepare.js";
import { startMthdsRun } from "./run.js";
import { validateMthds } from "./validate.js";

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

/**
 * A blob gone missing between its upload and the request, refused under the
 * MTHDS standard's `request.blobs_missing`. The SDK sends once more when the
 * refusal names blobs of a tree it sent by hash, then hands a second such
 * answer back unchanged, so every tool that sends a tree relays it alike: the
 * receiver's problem as it came, with no location of the workshop's own and
 * none of a route's own wording.
 */
describe("a blob gone missing, on every route that sends a tree", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const INLINE = { files: [{ content: BUNDLE }] };

  const ROUTES = [
    {
      tool: "mthds_validate",
      route: "/v1/validate",
      call: (baseUrl: string) => validateMthds({ ...INLINE, graph_page: false }, { baseUrl }),
    },
    {
      tool: "mthds_run",
      route: "/v1/start",
      call: (baseUrl: string) => startMthdsRun(INLINE, { baseUrl }),
    },
    {
      tool: "mthds_codegen",
      route: "/v1/codegen",
      call: (baseUrl: string) => generateMthdsCode({ ...INLINE, target: "ts-zod" }, { baseUrl }),
    },
    {
      tool: "mthds_inputs_template",
      route: "/v1/pipe-io",
      call: (baseUrl: string) => buildMthdsInputs(INLINE, { baseUrl }),
    },
    {
      tool: "mthds_prepare_inputs",
      route: "/v1/pipe-io",
      call: (baseUrl: string) => prepareMthdsInputs({ ...INLINE, inputs: {} }, { baseUrl }),
    },
  ] as const;

  const REFUSAL = buildProblem("request.blobs_missing", { missing_blobs: ["a".repeat(64)] });

  for (const { tool, route, call } of ROUTES) {
    it(`${tool} relays request.blobs_missing as the receiver sent it`, async () => {
      const posted: string[] = [];
      vi.stubGlobal("fetch", (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/v1/version") {
          return Promise.resolve(Response.json({ version: "1.0.0", blob_store: false }));
        }
        posted.push(url.pathname);
        return Promise.resolve(
          new Response(JSON.stringify({ ...REFUSAL, status: 422 }), {
            status: 422,
            headers: { "content-type": "application/problem+json" },
          }),
        );
      });

      const result = await call(`https://blobs.${tool}.example`);

      expect(posted).toContain(route);
      expect(result.structuredContent.status).toBe("error");
      const problem = result.structuredContent.problem;
      expect(problem).toMatchObject({
        code: "request.blobs_missing",
        domain: "input",
        retry: "no",
        params: { missing_blobs: ["a".repeat(64)] },
      });
      expect(problem).not.toHaveProperty("location");
      expect(result.summary).toContain(REFUSAL.next_step.detail);
    });
  }
});

/**
 * A request refused as too large, a `413` the gateway answers with no
 * problem document. Neither the answer nor the SDK says which part of the
 * request made it so, so the workshop adds what it can tell to the problem's
 * `message`, from the route the SDK names in its error and from how the tree
 * travelled, which the handshake decides as the SDK decided it: a refusal of
 * the tree's preparation is the tree's alone, a tree that rode the request
 * inline is named with its weight, and on a start a tree shown not to have
 * ridden the request leaves the inputs to blame.
 */
describe("a request refused as too large", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A deployment answering `route` with a bare `413`, keeping a blob store or
   * not, its handshake announcing `maxInlineBytes` when given. The blob route
   * answers that the organization holds every blob, unless it is `route`.
   */
  function stubTooLarge(route: string, blobStore: boolean, maxInlineBytes?: number): void {
    const limits =
      maxInlineBytes === undefined
        ? {}
        : { limits: { method_tree: { max_inline_bytes: maxInlineBytes } } };
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === route) {
        return Promise.resolve(new Response("Request Entity Too Large", { status: 413 }));
      }
      if (url.pathname === "/v1/version") {
        return Promise.resolve(
          Response.json({ version: "1.0.0", blob_store: blobStore, ...limits }),
        );
      }
      if (url.pathname === "/v1/blobs/missing") {
        return Promise.resolve(Response.json({ missing: [] }));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
  }

  const HEAVY = folderSource(HEAVY_FOLDER);
  const SMALL = folderSource(FOLDER);

  const ROUTES = [
    {
      tool: "mthds_validate",
      route: "/v1/validate",
      call: (baseUrl: string, sent = HEAVY) =>
        validateMthds({ ...sent.source, graph_page: false }, { baseUrl, resolver: sent.resolver }),
    },
    {
      tool: "mthds_run",
      route: "/v1/start",
      call: (baseUrl: string, sent = HEAVY) =>
        startMthdsRun(sent.source, { baseUrl, resolver: sent.resolver }),
    },
    {
      tool: "mthds_codegen",
      route: "/v1/codegen",
      call: (baseUrl: string, sent = HEAVY) =>
        generateMthdsCode(
          { ...sent.source, target: "ts-zod" },
          { baseUrl, resolver: sent.resolver },
        ),
    },
    {
      tool: "mthds_inputs_template",
      route: "/v1/pipe-io",
      call: (baseUrl: string, sent = HEAVY) =>
        buildMthdsInputs(sent.source, { baseUrl, resolver: sent.resolver }),
    },
    {
      tool: "mthds_prepare_inputs",
      route: "/v1/pipe-io",
      call: (baseUrl: string, sent = HEAVY) =>
        prepareMthdsInputs({ ...sent.source, inputs: {} }, { baseUrl, resolver: sent.resolver }),
    },
  ] as const;

  for (const { tool, route, call } of ROUTES) {
    it(`${tool} says a tree sent inline to a deployment with no blob store made the request too large`, async () => {
      stubTooLarge(route, false);

      const result = await call(`https://large.${tool}.example`);

      expect(result.structuredContent.status).toBe("error");
      const message = result.structuredContent.problem?.message;
      expect(message).toContain("The method's files travelled inline in this request");
      expect(message).toMatch(
        /inline in this request, [\d.]+ KiB of them, the deployment keeping no blob store/,
      );
      expect(message).toContain(".gitignore");
      expect(message).not.toContain("mthds_prepare_inputs");
      expect(result.summary).toContain("travelled inline");
    });

    it(`${tool} adds nothing to a 413 when the tree went by hash and nothing else rode the request`, async () => {
      stubTooLarge(route, true);

      const result = await call(`https://large.hash.${tool}.example`);

      expect(result.structuredContent.status).toBe("error");
      const message = result.structuredContent.problem?.message ?? "";
      expect(message).not.toContain("method's files");
      expect(message).not.toContain("mthds_prepare_inputs");
    });

    it(`${tool} says the method's files, not its inputs, were refused when the blob route answered the 413`, async () => {
      stubTooLarge("/v1/blobs/missing", true);

      const result = await call(`https://large.blobs.${tool}.example`);

      expect(result.structuredContent.status).toBe("error");
      const message = result.structuredContent.problem?.message;
      expect(message).toContain(
        "refused POST /v1/blobs/missing as too large while the method's files were prepared",
      );
      expect(message).toContain("no input played a part");
      expect(message).not.toContain("mthds_prepare_inputs");
    });
  }

  it("names a small tree a validation carried inline with its weight, as the only part of any size", async () => {
    stubTooLarge("/v1/validate", false);

    const result = await validateMthds(
      { ...SMALL.source, graph_page: false },
      { baseUrl: "https://large.small.example", resolver: SMALL.resolver },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem?.message).toMatch(
      /travelled inline in this request, \d+ bytes of them, the deployment keeping no blob store/,
    );
  });

  it("blames a start's inputs when the tree went by hash", async () => {
    stubTooLarge("/v1/start", true);

    const result = await startMthdsRun(
      { ...HEAVY.source, inputs: { text: "x".repeat(2048) } },
      { baseUrl: "https://large.inputs.example", resolver: HEAVY.resolver },
    );

    const message = result.structuredContent.problem?.message;
    expect(message).toContain(
      "The run's inputs are what made its request too large, 2.0 KiB of them as JSON",
    );
    expect(message).toContain("the method's files having gone by hash");
    expect(message).toContain("mthds_prepare_inputs");
    expect(message).not.toContain("travelled inline in this request");
  });

  it("never blames a start's inputs when the blob route answered the 413", async () => {
    stubTooLarge("/v1/blobs/missing", true);

    const result = await startMthdsRun(
      { ...HEAVY.source, inputs: { text: "x".repeat(2048) } },
      { baseUrl: "https://large.blobs.inputs.example", resolver: HEAVY.resolver },
    );

    const message = result.structuredContent.problem?.message;
    expect(message).toContain("while the method's files were prepared");
    expect(message).not.toContain("The run's inputs");
    expect(message).not.toContain("mthds_prepare_inputs");
  });

  it("names both causes, with what it measured, when inputs rode a start beside a heavy inline tree", async () => {
    stubTooLarge("/v1/start", false);

    const result = await startMthdsRun(
      { ...HEAVY.source, inputs: { text: "x".repeat(2048) } },
      { baseUrl: "https://large.both.example", resolver: HEAVY.resolver },
    );

    const message = result.structuredContent.problem?.message;
    expect(message).toContain("cannot be told from here");
    expect(message).toContain("which travelled inline, the deployment keeping no blob store");
    expect(message).toMatch(/the method's files weigh [\d.]+ KiB inline/);
    expect(message).toContain("its inputs weigh 2.0 KiB as JSON");
  });

  it("reads a deployment's max_inline_bytes below the SDK's threshold, which sends a small tree by hash", async () => {
    // The tree is far under INLINE_TREE_MAX_BYTES but over the 64 bytes this
    // deployment announces, so the SDK sent it by hash and the inputs alone
    // rode the start.
    stubTooLarge("/v1/start", true, 64);

    const result = await startMthdsRun(
      { ...SMALL.source, inputs: { text: "x".repeat(2048) } },
      { baseUrl: "https://large.announced.example", resolver: SMALL.resolver },
    );

    const message = result.structuredContent.problem?.message;
    expect(message).toContain("The run's inputs are what made its request too large");
    expect(message).toContain("the method's files having gone by hash");
  });

  it("names a tree within a deployment's announced inline limit as having travelled inline", async () => {
    stubTooLarge("/v1/codegen", true, 4096);

    const result = await generateMthdsCode(
      { ...SMALL.source, target: "ts-zod" },
      { baseUrl: "https://large.within.example", resolver: SMALL.resolver },
    );

    expect(result.structuredContent.problem?.message).toContain(
      "within the 4.0 KiB a tree may weigh to travel inline",
    );
  });
});
