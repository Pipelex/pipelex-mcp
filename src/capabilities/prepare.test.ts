import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  InputPreparationError,
  InvalidInputValueError,
  InvalidLocalSourceError,
  MethodLoadError,
  RejectedAssetError,
  RequestArgumentError,
  TestFileRefusedError,
  UnsupportedUploadCapabilityError,
  UploadNotAllowedError,
  UploadAuthenticationError,
  UploadTransportError,
} from "@pipelex/sdk";
import type { PrepareInputsRequest, PreparedInputs } from "@pipelex/sdk";

import {
  prepareInputsResult,
  prepareInputsToolResult,
  prepareMthdsInputs,
  validatePrepareInputsRequest,
} from "./prepare.js";
import {
  LEGACY_LINK_FILE_NAME,
  LEGACY_LINK_MOVE,
  buildMethodLink,
  linkFileOf,
} from "./catalog-link.js";
import { listMthdsFiles } from "./org-files.js";
import { MAX_UPLOAD_BYTES, SizeGuardedPipelexApiClient, formatMib } from "./upload-ceiling.js";
import { comparableRequest, fakeMethodResolver } from "./method-tree-fixtures.js";
import { DEFAULT_API_URL, createPipelexApiClient, problemOf, SECRET_REASON } from "./shared.js";
import type { MethodTreeToSend } from "./shared.js";

/** A tree in hand, for the request checks, which only ask whether one is there. */
const A_TREE: MethodTreeToSend = {
  source: { files: [], digest: "", readFile: () => Promise.reject(new Error("never read")) },
  files: [],
  fromFolder: false,
};

/** Fake arm for tests whose request must never reach the SDK. */
const prepareInputsNotCalled = {
  async prepareInputs(): Promise<PreparedInputs> {
    throw new Error("prepareInputs must not be called in this test");
  },
};
/** The SDK's walk reads the signature itself, so the whole fake is its `prepareInputs`. */
function uploadWith(prepareInputs: (request: PrepareInputsRequest) => Promise<PreparedInputs>) {
  return { prepareInputs };
}

const files = [{ content: 'domain = "demo"' }];
const PUBLISHED_REF = "github.com/Pipelex/methods/documents@v0.1.0";

/** The base-URL note of a context that carries none. */
const BASE_URL_NOTE =
  "The Pipelex API in use is the one PIPELEX_BASE_URL names, else the hosted Pipelex API.";

/**
 * A refusal as the runner and the platform answer every one: a problem
 * document, which the SDK reads as it came, its request id riding the header.
 */
function refusal(
  status: number,
  problem: { code: string; title: string; detail: string; domain: string } & Record<
    string,
    unknown
  >,
): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/pipe-io`,
    status,
    "Refused",
    JSON.stringify({
      type: `https://mthds.ai/errors/${problem.code}`,
      status,
      retry: "no",
      next_step: { kind: "change_input", detail: "Correct the request, then send it again." },
      ...problem,
    }),
    { headers: { "x-request-id": `req_${status}` } },
  );
}

/** The route's refusal of a pipe selection, as the SDK's `prepareInputs` rethrows it. */
function selectionRefusal(code: string, detail: string): InputPreparationError {
  const answer = refusal(422, {
    code,
    title: "The pipe selection was refused",
    detail,
    domain: "input",
    location: { field: "pipe_ref" },
  });
  return new InputPreparationError(`Cannot prepare inputs: ${detail}`, {
    cause: answer,
    problem: answer.problem,
  });
}

describe("prepareInputsResult", () => {
  it("projects prepared inputs with the uploaded uris and echoes a supplied pipe_ref", () => {
    const result = prepareInputsResult(
      {
        inputs: { photo: { url: "pipelex-storage://abc" }, question: "hi" },
        uploads: [
          {
            uri: "pipelex-storage://abc",
            filename: "a.png",
            contentType: "image/png",
            size: 12,
          },
        ],
      },
      "demo.main",
    );

    expect(result.structuredContent).toEqual({
      status: "ok",
      is_valid: true,
      pipe_ref: "demo.main",
      inputs: { photo: { url: "pipelex-storage://abc" }, question: "hi" },
      uploads: ["pipelex-storage://abc"],
    });
    expect(result.summary).toContain("Uploaded 1 asset(s)");
    expect(result.summary).toContain("pipelex-storage://abc");
    // The resolved pipe and the fenced block are the payload the model carries
    // to `mthds_run`, which is why the summary duplicates what
    // `structuredContent` already holds. Pinned here because nothing else does.
    expect(result.summary).toContain("Resolved pipe: `demo.main`");
    expect(result.summary).toContain("```json");
  });

  it("omits pipe_ref when the caller did not supply it and notes an all-pass-through result", () => {
    const result = prepareInputsResult(
      { inputs: { photo: { url: "https://cdn.example.com/a.png" } }, uploads: [] },
      undefined,
    );

    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.summary).toContain("No assets required uploading");
    expect(result.summary).toContain("```json");
    // The default the SDK selected is deliberately NOT echoed, so the summary
    // must not claim one either.
    expect(result.summary).not.toContain("Resolved pipe");
  });
});

describe("prepareInputsToolResult", () => {
  it("carries the summary as content with no _meta channel", () => {
    const toolResult = prepareInputsToolResult(
      prepareInputsResult({ inputs: {}, uploads: [] }, undefined),
    );

    expect(toolResult.isError).toBe(false);
    expect(toolResult.content[0]?.type).toBe("text");
    expect(toolResult).not.toHaveProperty("_meta");
  });

  it("flags no-verdict results as errors", () => {
    const toolResult = prepareInputsToolResult({
      structuredContent: {
        status: "error",
        is_valid: false,
        problem: problemOf(new Error("nope")),
      },
      summary: "nope",
    });

    expect(toolResult.isError).toBe(true);
  });
});

describe("validatePrepareInputsRequest", () => {
  it("inherits the shared one-selector checks", () => {
    expect(validatePrepareInputsRequest({ inputs: {} })).toHaveLength(1);
  });

  it.each([
    ["a bare pipe_code", "extract", "not_qualified", 'got the bare "extract"'],
    [
      "a dependency package's pipe",
      "alias->docs.extract",
      "dependency_pipe",
      "names a dependency package's pipe",
    ],
  ])(
    "refuses %s at pipe_ref, as the SDK would before sending",
    (_label, pipeRef, why, sentence) => {
      const faults = validatePrepareInputsRequest({ tree: A_TREE, pipe_ref: pipeRef, inputs: {} });

      expect(faults).toEqual([
        expect.objectContaining({
          code: "client.argument_invalid",
          domain: "input",
          retry: "no",
          params: { argument: "pipe_ref", reason: why },
          location: { field: "pipe_ref" },
        }),
      ]);
      expect(faults[0]?.message).toContain(sentence);
      expect(
        validatePrepareInputsRequest({ tree: A_TREE, pipe_ref: "docs.extract", inputs: {} }),
      ).toEqual([]);
    },
  );

  it("rejects a blank pipe_ref", () => {
    const faults = validatePrepareInputsRequest({ tree: A_TREE, pipe_ref: "  ", inputs: {} });
    expect(faults.map((fault) => fault.location?.field)).toEqual(["pipe_ref"]);
    expect(faults[0]?.params).toEqual({ argument: "pipe_ref", reason: "empty" });
  });

  it("rejects a blank method_id", () => {
    const faults = validatePrepareInputsRequest({ method_id: " ", inputs: {} });
    expect(faults.map((fault) => fault.location?.field)).toEqual(["method_id"]);
  });

  it("accepts each selector on its own", () => {
    expect(validatePrepareInputsRequest({ tree: A_TREE, inputs: {} })).toEqual([]);
    expect(
      validatePrepareInputsRequest({
        method_ref: PUBLISHED_REF,
        inputs: {},
      }),
    ).toEqual([]);
    expect(validatePrepareInputsRequest({ method_id: "mt_123", inputs: {} })).toEqual([]);
  });

  it("rejects a second selector at the extra field", () => {
    const beside = validatePrepareInputsRequest({
      tree: A_TREE,
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      inputs: {},
    });
    expect(beside.map((fault) => fault.location?.field)).toEqual(["method_ref"]);

    const both = validatePrepareInputsRequest({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      method_id: "mt_123",
      inputs: {},
    });
    expect(both.map((fault) => fault.location?.field)).toEqual(["method_id"]);
  });
});

describe("prepareMthdsInputs — the SDK upload walk", () => {
  it("hands the SDK the files as one tree, expanding nothing itself", async () => {
    let captured: PrepareInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { files, pipe_ref: "demo.main", inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async (request) => {
          captured = request;
          return {
            inputs: { photo: { url: "pipelex-storage://up1" } },
            uploads: [
              {
                uri: "pipelex-storage://up1",
                filename: "a.png",
                contentType: "image/png",
                size: 3,
              },
            ],
          };
        }),
      },
    );

    expect(await comparableRequest(captured)).toEqual({
      tree: { "bundle.mthds": 'domain = "demo"' },
      pipe_ref: "demo.main",
      inputs: { photo: "/tmp/a.png" },
    });
    expect(result.structuredContent.files_sent).toEqual(["bundle.mthds"]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.uploads).toEqual(["pipelex-storage://up1"]);
    expect(result.structuredContent.inputs).toEqual({ photo: { url: "pipelex-storage://up1" } });
  });

  it("forwards a method_ref address to the SDK without touching it", async () => {
    let captured: PrepareInputsRequest | undefined;

    await prepareMthdsInputs(
      {
        method_ref: PUBLISHED_REF,
        inputs: { photo: "/tmp/a.png" },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async (request) => {
          captured = request;
          return { inputs: {}, uploads: [] };
        }),
      },
    );

    expect(captured).toEqual({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      inputs: { photo: "/tmp/a.png" },
    });
  });

  it("forwards a method_id to the SDK instead of expanding the closure itself", async () => {
    let captured: PrepareInputsRequest | undefined;

    await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        // `validateNotCalled` is doing real work here: were the capability still
        // expanding the id itself it would need a fetch leg, and this fake has none.
        client: uploadWith(async (request) => {
          captured = request;
          return { inputs: {}, uploads: [] };
        }),
      },
    );

    expect(captured).toEqual({ method_id: "mt_123", inputs: {} });
  });

  it("plans the id against the platform, and says whose signature it prepared against", async () => {
    const captured: PrepareInputsRequest[] = [];
    const onPlatform = (extensions: string[]) => {
      const client = uploadWith(async (request) => {
        captured.push(request);
        return { inputs: {}, uploads: [] };
      });
      return {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...client,
          async version() {
            return { version: "1.0.0", extensions };
          },
        },
      };
    };

    const latest = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      onPlatform(["runs", "method_versions"]),
    );
    const drafted = await prepareMthdsInputs(
      { method_id: "mt_123@draft", inputs: {} },
      onPlatform(["runs"]),
    );

    expect(captured.map((request) => request.method_id)).toEqual(["mt_123", "mt_123@draft"]);
    expect(latest.structuredContent.method_version).toBe("latest");
    expect(drafted.structuredContent.method_version).toBe("draft");
    expect(drafted.summary).toContain("the draft of `mt_123`");
  });

  it("relays the upload ceiling's refusal at inputs, naming the real ceiling", async () => {
    // The size-guarded client refuses an oversize file before the wire, as
    // the SDK's walk meets it through `uploadFile`.
    const guarded = createPipelexApiClient(
      { baseUrl: DEFAULT_API_URL },
      SizeGuardedPipelexApiClient,
    );
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/big.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          await guarded.uploadFile(new Uint8Array(9 * 1024 * 1024), { filename: "big.png" });
          throw new Error("the guard must refuse the file");
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "inputs", reason: "upload_too_large" },
      location: { field: "inputs" },
    });
    expect(result.structuredContent.problem?.message).toContain(
      `over the ${formatMib(MAX_UPLOAD_BYTES)} Pipelex upload limit`,
    );
    expect(result.summary).toContain("Shrink the file");
  });

  it("relays a refused asset with no problem of its own as the SDK reads it, unchanged", async () => {
    // A gateway's bare 413: the SDK's reading, never a texture of this server's.
    const err = new RejectedAssetError("too big", "big.png", 413);

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/big.png" } },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
  });

  it("relays an invalid local source as the SDK's input.file_unreadable", async () => {
    const err = new InvalidLocalSourceError("cannot read", "/nope.png");

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/nope.png" } },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "input.file_unreadable",
      domain: "input",
      params: { input: "/nope.png" },
    });
  });

  it("relays a missing upload capability as the SDK's runtime.unsupported, with the base URL note", async () => {
    const err = new UnsupportedUploadCapabilityError("no upload route");

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem?.code).toBe("runtime.unsupported");
    expect(result.summary).toContain(BASE_URL_NOTE);
  });

  it("relays an upload auth failure as the key, with the key note, never as an unreachable API", async () => {
    const err = new UploadAuthenticationError("rejected", 401, { credentialSent: true });

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        apiNotes: { apiKey: "The API key came from the connector's sign-in." },
        client: uploadWith(() => Promise.reject(err)),
      },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "auth.invalid_credential",
      domain: "account",
    });
    // The upload leg's refused key reads as the key, as the pipe I/O route's
    // does, never as an unreachable API.
    expect(result.summary).toContain("The API key came from the connector's sign-in.");
    expect(result.summary).not.toMatch(/unreachable/i);
  });

  it("relays an upload transport fault as the SDK's retryable runtime.unavailable", async () => {
    // Storage's 503, as the SDK's grant upload reports it.
    const err = new UploadTransportError("upstream died", { reason: "server_error", status: 503 });

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "runtime.unavailable",
      retry: "yes",
    });
  });

  it("relays a pipe refusal the SDK makes before sending as its own problem, at pipe_ref", async () => {
    const err = selectionRefusal(
      "request.pipe_not_found",
      "No pipe 'demo.summarize' in the closure.",
    );

    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem?.location?.field).toBe("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("errors");
  });

  it.each([
    ["files", { files }],
    ["method_ref", { method_ref: PUBLISHED_REF }],
    ["method_id", { method_id: "mt_123" }],
  ] as const)(
    "relays a method that does not load as the SDK's method.invalid with its items, whatever named it (%s)",
    async (_selector, selector) => {
      const err = new MethodLoadError(
        "Cannot prepare inputs: the method signature did not resolve — bad toml",
        {
          errors: [
            { code: "method.syntax", detail: "bad toml", location: { file: "bundle.mthds" } },
          ],
          serverMessage: "boom",
        },
      );

      const result = await prepareMthdsInputs(
        { ...selector, inputs: {} },
        { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem).toMatchObject({
        code: "method.invalid",
        domain: "method",
        errors: [{ code: "method.syntax", detail: "bad toml" }],
      });
      // The method's faults reach the reader, each with where it happened.
      expect(result.summary).toContain("bad toml");
      expect(result.summary).toContain("bundle.mthds");
    },
  );

  it("relays a file input value that cannot be read as a file as the SDK's input.invalid", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { document: "data:application/pdf;base64" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new InvalidInputValueError(
            "Cannot prepare inputs: the data: URL at document has no comma",
            { inputName: "document", inputPath: "document" },
          );
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "input.invalid",
      domain: "input",
      params: { input: "document" },
    });
  });
});
describe("prepareMthdsInputs — selector-shaped refusals", () => {
  it("relays an address the runner refuses as its problem, unchanged", async () => {
    const err = refusal(404, {
      code: "method.not_found",
      title: "The method was not found",
      detail: "No MTHDS package in the repository matches the address.",
      domain: "input",
    });

    const result = await prepareMthdsInputs(
      { method_ref: "github.com/Pipelex/methods/nope@v9", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "method.not_found",
      domain: "input",
      request_id: "req_404",
    });
  });

  it("relays a malformed address as the runner's request.invalid at method_ref", async () => {
    const err = refusal(422, {
      code: "request.invalid",
      title: "The request was refused",
      detail: "method_ref is not an address: not-an-address.",
      domain: "input",
      location: { field: "method_ref" },
    });

    const result = await prepareMthdsInputs(
      { method_ref: "not-an-address", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem?.location?.field).toBe("method_ref");
  });

  it("relays an unknown method id as the platform's problem, unchanged", async () => {
    const err = refusal(404, {
      code: "pipelex.catalog.not_found",
      title: "Method not found",
      detail: "No method mt_missing belongs to this organization.",
      domain: "input",
      location: { field: "method_id" },
    });

    const result = await prepareMthdsInputs(
      { method_id: "mt_missing", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.catalog.not_found",
      location: { field: "method_id" },
    });
  });

  // A runner too old to serve `/v1/pipe-io` answers a bare 404, which the SDK
  // reads as the deployment's missing route, never as the method named.
  for (const selector of [
    { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
    { method_id: "mt_123" },
  ]) {
    it(`relays a bare 404 as request.not_found, with the base URL note (${Object.keys(selector)[0]})`, async () => {
      const err = new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/pipe-io`,
        404,
        "Not Found",
        '{"detail":"Not Found"}',
      );

      const result = await prepareMthdsInputs(
        { ...selector, inputs: {} },
        { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
      );

      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem?.code).toBe("request.not_found");
      expect(result.summary).toContain(BASE_URL_NOTE);
    });
  }

  it("relays a source-less stored method as the route's 422, unchanged", async () => {
    // The fail-fast EmptyMethodSourceError went out with the client-side
    // expansion; a source-less method now surfaces from the route itself.
    const err = refusal(422, {
      code: "request.invalid",
      title: "The request was refused",
      detail: "The stored method has no MTHDS source.",
      domain: "input",
      location: { field: "method_id" },
    });

    const result = await prepareMthdsInputs(
      { method_id: "mt_empty", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.summary).toContain("The stored method has no MTHDS source.");
  });

  it("relays a pipe selection the route refuses at pipe_ref, even on a by-ref request", async () => {
    // The address is not the problem and is not named as one: the route's own
    // problem locates the refusal at pipe_ref.
    const err = selectionRefusal("request.pipe_not_found", "No pipe 'demo.nope' in the closure.");

    const result = await prepareMthdsInputs(
      { method_ref: PUBLISHED_REF, pipe_ref: "demo.nope", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "request.pipe_not_found",
      location: { field: "pipe_ref" },
    });
  });

  it("relays a pipe selection the route refuses at pipe_ref, even on a by-id request", async () => {
    const err = selectionRefusal(
      "request.pipe_ambiguous",
      "Several domains declare a main_pipe: demo, other.",
    );

    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "request.pipe_ambiguous",
      location: { field: "pipe_ref" },
    });
    expect(result.summary).toContain("Several domains declare a main_pipe");
  });

  it("relays a paywall (402) as the platform's plan problem, not as connectivity", async () => {
    const err = refusal(402, {
      code: "pipelex.billing.plan_limit",
      title: "The organization's plan does not cover this call",
      detail: "Preparing inputs for a saved method needs a plan that includes the catalog.",
      domain: "account",
      next_step: {
        kind: "contact_owner",
        detail: "Ask the organization's owner to change its plan.",
      },
    });

    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.summary).toContain("## The organization's plan does not cover this call");
    expect(result.summary).not.toMatch(/unreachable/);
  });
});
describe("prepareMthdsInputs — request shape and transport", () => {
  const noClientLeg = prepareInputsNotCalled;

  it("rejects a request with no selector at all", async () => {
    const result = await prepareMthdsInputs(
      { inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: noClientLeg },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files", reason: "missing" },
      location: { field: "files" },
    });
    // The teaching text names every selector, because the tool takes them all.
    expect(result.structuredContent.problem?.message).toContain("method_ref");
  });

  it("rejects files beside method_id without calling any client leg", async () => {
    const result = await prepareMthdsInputs(
      { files, method_id: "mt_123", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: noClientLeg },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
  });

  it("rejects { path } items instructively without a resolver", async () => {
    const result = await prepareMthdsInputs(
      { files: [{ path: "bundle.mthds" }], inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: noClientLeg },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "files[0].path", reason: "not_readable_here" },
      location: { field: "files[0].path" },
    });
    expect(result.summary).toContain("npx @pipelex/mcp");
  });

  it("reads { path } items through the resolver and sends them as one tree", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    let captured: PrepareInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      {
        files: [{ path: "methods/invoice.mthds" }, { path: "methods/templates/invoice.xlsx" }],
        inputs: {},
      },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: fakeMethodResolver({
          files: {
            "methods/invoice.mthds": 'domain = "invoice"',
            "methods/templates/invoice.xlsx": XLSX,
          },
        }),
        client: uploadWith(async (request) => {
          captured = request;
          return { inputs: {}, uploads: [] };
        }),
      },
    );

    const tree = captured !== undefined && "tree" in captured ? captured.tree : undefined;
    expect(tree?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "templates/invoice.xlsx",
    ]);
    expect(await tree?.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      files_sent: ["methods/invoice.mthds", "methods/templates/invoice.xlsx"],
    });
  });

  it("reads a method folder through the resolver and lists every file it sent", async () => {
    let captured: PrepareInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: methodFolderResolver(),
        client: uploadWith(async (request) => {
          captured = request;
          return { inputs: {}, uploads: [] };
        }),
      },
    );

    expect(await comparableRequest(captured)).toEqual({
      tree: { "invoice.mthds": 'domain = "invoice"', "templates/invoice.xlsx": "PK" },
      inputs: {},
    });
    expect(result.structuredContent.files_sent).toEqual([
      "methods/invoice.mthds",
      "methods/templates/invoice.xlsx",
    ]);
    expect(prepareInputsToolResult(result).content[0].text).toContain("## Files sent");
  });

  it("refuses a folder holding a key before anything is sent", async () => {
    const fakeKey = ["plx_sk_", "f".repeat(32)].join("");

    const result = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: fakeMethodResolver({
          folder: {
            "invoice.mthds": 'domain = "invoice"',
            "funcs/client.py": `KEY = "${fakeKey}"`,
          },
        }),
        client: noClientLeg,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_dir", reason: SECRET_REASON },
      location: { field: "method_dir" },
    });
    expect(result.structuredContent.problem?.message).toContain("nothing was sent");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("lists no file of a folder when the request never left the machine", async () => {
    const unbuilt = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {} },
      { baseUrl: "invalid-no-scheme", resolver: methodFolderResolver() },
    );
    expect(unbuilt.structuredContent.status).toBe("error");
    expect(unbuilt.structuredContent.problem?.code).toBe("client.not_configured");
    expect(unbuilt.structuredContent).not.toHaveProperty("files_sent");
    expect(prepareInputsToolResult(unbuilt).content[0].text).not.toContain("Files sent");

    const refused = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: methodFolderResolver(),
        client: uploadWith(async () => {
          throw new RequestArgumentError("refused before sending");
        }),
      },
    );
    expect(refused.structuredContent.status).toBe("error");
    expect(refused.structuredContent.problem?.code).toBe("client.argument_invalid");
    expect(refused.structuredContent).not.toHaveProperty("files_sent");
  });

  it.each([["extract"], ["alias->docs.extract"]])(
    "refuses the pipe_ref %s before the folder's files are sent, listing none",
    async (pipeRef) => {
      const prepare = vi.fn((_request: PrepareInputsRequest): Promise<PreparedInputs> => {
        throw new Error("no request expected");
      });

      const result = await prepareMthdsInputs(
        { method_dir: "methods", pipe_ref: pipeRef, inputs: {} },
        { baseUrl: DEFAULT_API_URL, resolver: methodFolderResolver(), client: uploadWith(prepare) },
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toMatchObject({
        code: "client.argument_invalid",
        location: { field: "pipe_ref" },
      });
      expect(result.structuredContent).not.toHaveProperty("files_sent");
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("relays an unreachable API as the SDK's client.unreachable, with the base URL note", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
        }),
      },
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "client.unreachable",
      retry: "yes",
      params: { base_url: DEFAULT_API_URL },
    });
    expect(result.summary).toContain(BASE_URL_NOTE);
  });

  it("reports a malformed base URL as client.not_configured instead of rejecting the handler", async () => {
    // No injected client: the real SDK constructor must run and throw inside the
    // caught path (regression guard for the client hoist).
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      { baseUrl: `${DEFAULT_API_URL}/v1` },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.not_configured",
      params: { setting: "base_url" },
    });
    expect(result.summary).toContain(BASE_URL_NOTE);
  });
});
describe("prepareMthdsInputs — what the uploads are recorded as", () => {
  const PREPARED: PreparedInputs = {
    inputs: { invoice: { url: "pipelex-storage://up1" } },
    uploads: [
      { uri: "pipelex-storage://up1", filename: "a.pdf", contentType: "application/pdf", size: 3 },
    ],
  };
  const API_HOST = new URL(DEFAULT_API_URL).host;
  const folders: string[] = [];

  afterEach(async () => {
    await Promise.all(folders.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  /**
   * A real method folder, since the link file is read from disk: `link`
   * writes its `.pipelex/method.json`, and `legacy` the `pipelex-method.json`
   * an earlier release wrote at its top.
   */
  async function methodFolder(
    link?: { apiHost: string; methodId: string } | "garbage",
    options: { legacy?: boolean } = {},
  ) {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-prepare-kind-")),
    );
    folders.push(dir);
    if (link !== undefined) {
      await fs.mkdir(path.dirname(linkFileOf(dir)), { recursive: true });
      const content =
        link === "garbage"
          ? "{ not json"
          : JSON.stringify(
              buildMethodLink({
                apiHost: link.apiHost,
                methodId: link.methodId,
                name: "Invoice extractor",
                syncedUpdatedAt: "2026-10-22T08:00:00Z",
              }),
            );
      await fs.writeFile(linkFileOf(dir), content, "utf8");
    }
    if (options.legacy === true) {
      await fs.writeFile(path.join(dir, LEGACY_LINK_FILE_NAME), "{}", "utf8");
    }
    // The fake reads the tree, and only its folder is real, for the link file.
    return {
      ...methodFolderResolver(),
      async locateMethodDir(methodDir: string) {
        return { ok: true as const, folder: dir, methodDir };
      },
    };
  }

  type Captured = PrepareInputsRequest & { upload?: unknown; allowUploads?: boolean };

  /** A fake whose walk uploads one file, as a real one does for a local path, unless uploads are disallowed. */
  function needingAnUpload() {
    const captured: Captured[] = [];
    return {
      captured,
      client: uploadWith(async (request) => {
        captured.push(request);
        if ((request as Captured).allowUploads === false) {
          throw new UploadNotAllowedError({
            inputName: "invoice",
            inputPath: "invoice",
            valueKind: "local_path",
          });
        }
        return PREPARED;
      }),
    };
  }

  /** A fake whose walk uploads nothing, as for inputs that are all addresses. */
  function allAddresses() {
    const captured: Captured[] = [];
    return {
      captured,
      client: uploadWith(async (request) => {
        captured.push(request);
        return { inputs: request.inputs, uploads: [] };
      }),
    };
  }

  it("sends nothing for the default kind, and echoes it only when supplied", async () => {
    for (const kind of [undefined, "uploaded"] as const) {
      const { captured, client } = needingAnUpload();
      const result = await prepareMthdsInputs(
        { method_id: "mt_123", inputs: {}, ...(kind === undefined ? {} : { kind }) },
        { baseUrl: DEFAULT_API_URL, client },
      );

      expect(captured[0], String(kind)).not.toHaveProperty("upload");
      expect(captured[0], String(kind)).not.toHaveProperty("allowUploads");
      expect(result.structuredContent.status).toBe("ok");
      expect(result.structuredContent.kind).toBe(kind);
      expect(result.structuredContent).not.toHaveProperty("test_method_id");
      expect(result.summary).not.toContain("test files");
    }
  });

  it("records a test upload against a bare method_id", async () => {
    const { captured, client } = needingAnUpload();
    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {}, kind: "test" },
      { baseUrl: DEFAULT_API_URL, client },
    );

    expect(captured[0]).toEqual({
      method_id: "mt_123",
      inputs: {},
      upload: { kind: "test", method_id: "mt_123" },
    });
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      kind: "test",
      test_method_id: "mt_123",
    });
    expect(result.summary).toContain("recorded as test files of `mt_123`");
  });

  it("refuses a suffixed method_id for a test upload, naming the bare id, as the files list does", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_123@draft", inputs: {}, kind: "test" },
      { baseUrl: DEFAULT_API_URL, client: prepareInputsNotCalled },
    );
    const listed = await listMthdsFiles(
      { method_id: "mt_123@draft" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async listFiles() {
            throw new Error("listFiles must not be called in this test");
          },
        },
      },
    );

    const problem = result.structuredContent.problem;
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      retry: "no",
      params: { argument: "method_id", reason: "version_suffix" },
      location: { field: "method_id" },
    });
    expect(problem?.message).toContain("files belong to the method, not to one of its versions");
    expect(problem?.message).toContain('"mt_123"');
    expect(problem?.message).toContain("method_dir");
    const listProblem =
      listed.structuredContent.status === "error" ? listed.structuredContent.problem : undefined;
    // The same refusal as the files list's, its remedy closed with this tool's own alternative.
    expect(listProblem).toMatchObject({
      code: problem?.code,
      params: problem?.params,
      location: problem?.location,
    });
    expect(String(listProblem?.message)).toContain(
      "files belong to the method, not to one of its versions",
    );
  });

  it("refuses a test upload for a method_id with no bare id, at method_id", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "@draft", inputs: {}, kind: "test" },
      { baseUrl: DEFAULT_API_URL, client: prepareInputsNotCalled },
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      retry: "no",
      params: { argument: "method_id", reason: "not_a_catalog_id" },
      location: { field: "method_id" },
    });
  });

  it("records a test upload against the saved method a method_dir is linked to", async () => {
    const { captured, client } = needingAnUpload();
    const result = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {}, kind: "test" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: await methodFolder({ apiHost: API_HOST, methodId: "mt_linked" }),
        client,
      },
    );

    expect(captured[0]?.upload).toEqual({ kind: "test", method_id: "mt_linked" });
    expect(captured[0]).not.toHaveProperty("allowUploads");
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      kind: "test",
      test_method_id: "mt_linked",
    });
  });

  it("names no test method when nothing was uploaded", async () => {
    const { client } = allAddresses();
    const result = await prepareMthdsInputs(
      { method_dir: "methods", inputs: { invoice: "pipelex-storage://up1" }, kind: "test" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: await methodFolder({ apiHost: API_HOST, methodId: "mt_linked" }),
        client,
      },
    );

    expect(result.structuredContent).toMatchObject({ status: "ok", kind: "test", uploads: [] });
    expect(result.structuredContent).not.toHaveProperty("test_method_id");
    expect(result.summary).not.toContain("test files");
  });

  it("refuses a folder still holding the old link file at once, with the command that moves it", async () => {
    const result = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {}, kind: "test" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: await methodFolder(
          { apiHost: API_HOST, methodId: "mt_linked" },
          { legacy: true },
        ),
        client: prepareInputsNotCalled,
      },
    );

    const problem = result.structuredContent.problem;
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      retry: "no",
      params: { argument: "kind", reason: "legacy_link" },
      location: { field: "kind" },
    });
    expect(problem?.message).toContain(LEGACY_LINK_FILE_NAME);
    expect(problem?.message).toContain(LEGACY_LINK_MOVE);
  });

  it.each([
    [403, "role_not_permitted"],
    [404, "method_not_found"],
    [409, "method_being_deleted"],
  ] as const)(
    "relays the platform's refusal of a test upload as the SDK reads it (%i %s)",
    async (status, reason) => {
      // No wrapped answer, so the problem is the one the SDK reads off the reason.
      const err = new TestFileRefusedError(
        `Upload of "a.pdf" as a test file was refused (${status})`,
        { status, reason, filename: "a.pdf", methodId: "mt_123" },
      );

      const result = await prepareMthdsInputs(
        { method_id: "mt_123", inputs: { invoice: "/tmp/a.pdf" }, kind: "test" },
        { baseUrl: DEFAULT_API_URL, client: uploadWith(() => Promise.reject(err)) },
      );

      const problem = result.structuredContent.problem;
      expect(problem).toEqual(problemOf(err));
      if (reason === "role_not_permitted") {
        expect(problem).toMatchObject({ code: "auth.forbidden", domain: "account", retry: "no" });
        expect(problem).not.toHaveProperty("location");
      } else {
        expect(problem).toMatchObject({
          code: "client.argument_invalid",
          retry: "no",
          params: { argument: "method_id", reason },
        });
      }
    },
  );

  /**
   * Each way of not knowing a test file's method, with what its refusal says:
   * it matters only when something is uploaded.
   */
  const UNKNOWN_METHOD = [
    [
      "a list of files",
      async () => ({ input: { files } }),
      "a list of files or a published address names none",
    ],
    [
      "a published address",
      async () => ({ input: { method_ref: PUBLISHED_REF } }),
      "a list of files or a published address names none",
    ],
    [
      "a folder with no link",
      async () => ({ input: { method_dir: "methods" }, resolver: await methodFolder() }),
      ".pipelex/method.json",
    ],
    [
      "an unreadable link file",
      async () => ({ input: { method_dir: "methods" }, resolver: await methodFolder("garbage") }),
      "cannot be read",
    ],
    [
      "a damaged link file",
      async () => ({
        input: { method_dir: "methods" },
        resolver: await methodFolder({ apiHost: API_HOST, methodId: "mt_linked@3" }),
      }),
      "is damaged",
    ],
    [
      "a link made against another API",
      async () => ({
        input: { method_dir: "methods" },
        resolver: await methodFolder({ apiHost: "api.example.test", methodId: "mt_elsewhere" }),
      }),
      "api.example.test",
    ],
  ] as const;

  it.each(UNKNOWN_METHOD)(
    "refuses a test upload from %s only when an upload is needed, at kind",
    async (_label, setUp, says) => {
      const { input, resolver } = (await setUp()) as {
        input: Record<string, unknown>;
        resolver?: Awaited<ReturnType<typeof methodFolder>>;
      };
      const { captured, client } = needingAnUpload();
      const result = await prepareMthdsInputs(
        { ...input, inputs: { invoice: "/tmp/a.pdf" }, kind: "test" },
        { baseUrl: DEFAULT_API_URL, client, ...(resolver === undefined ? {} : { resolver }) },
      );

      expect(captured[0]?.allowUploads).toBe(false);
      expect(captured[0]).not.toHaveProperty("upload");
      const problem = result.structuredContent.problem;
      expect(problem).toMatchObject({
        code: "client.argument_invalid",
        retry: "no",
        params: { argument: "kind" },
        location: { field: "kind" },
      });
      // The input that needed an upload, between the reason and its remedy.
      const message = String(problem?.message);
      const needed = message.indexOf(
        "The input invoice needs an upload, so a test file would be recorded.",
      );
      expect(message.indexOf(says)).toBeGreaterThanOrEqual(0);
      expect(needed).toBeGreaterThan(message.indexOf(says));
      expect(message.endsWith("so a test file would be recorded.")).toBe(false);
    },
  );

  it.each(UNKNOWN_METHOD)(
    "prepares inputs that need no upload from %s, with kind test and no test method",
    async (_label, setUp) => {
      const { input, resolver } = (await setUp()) as {
        input: Record<string, unknown>;
        resolver?: Awaited<ReturnType<typeof methodFolder>>;
      };
      const { captured, client } = allAddresses();
      const result = await prepareMthdsInputs(
        { ...input, inputs: { invoice: "https://cdn.example.com/a.pdf" }, kind: "test" },
        { baseUrl: DEFAULT_API_URL, client, ...(resolver === undefined ? {} : { resolver }) },
      );

      expect(captured[0]?.allowUploads).toBe(false);
      expect(result.structuredContent).toMatchObject({ status: "ok", kind: "test", uploads: [] });
      expect(result.structuredContent).not.toHaveProperty("test_method_id");
    },
  );
});

/** A resolver reading every method folder as a bundle and one template file. */
function methodFolderResolver() {
  return fakeMethodResolver({
    folder: { "invoice.mthds": 'domain = "invoice"', "templates/invoice.xlsx": "PK" },
  });
}
