import { describe, expect, it } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  EmptyMethodSourceError,
  InputPreparationError,
  InvalidLocalSourceError,
  RejectedAssetError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "@pipelex/sdk";
import type {
  BuildInputsRequest,
  BuildInputsResponse,
  MthdsFileItem,
  PrepareInputsRequest,
  PreparedInputs,
} from "@pipelex/sdk";

import {
  prepareInputsResult,
  prepareInputsToolResult,
  prepareMthdsInputs,
  validatePrepareInputsRequest,
} from "./prepare.js";
import { DEFAULT_API_URL } from "./shared.js";

/** An explicit json template with a file-bearing input (`photo`) and a text input (`question`). */
const explicitTemplate: BuildInputsResponse = {
  is_valid: true,
  pipe_ref: "demo.main",
  message: "Inputs template built.",
  format: "json",
  explicit: true,
  inputs: {
    photo: { concept: "native.Image", content: { url: "https://example.com/placeholder.png" } },
    question: { concept: "native.Text", content: "Your question here" },
  },
};

/**
 * An explicit json template for a declared-MULTIPLE file input (`Exhibit[]`). The runtime encodes
 * multiplicity structurally, not as an envelope key: the envelope stays exactly `{concept, content}`
 * (`concept` is the bare item ref, no `[]` suffix) and `content` becomes a ONE-element example list
 * (pipelex `concept.py`: `result["content"] = [result["content"]]`). That single element is the
 * element template the file-position walk reuses for every caller item.
 */
const explicitMultipleTemplate: BuildInputsResponse = {
  is_valid: true,
  pipe_ref: "demo.main",
  message: "Inputs template built.",
  format: "json",
  explicit: true,
  inputs: {
    exhibits: { concept: "demo.Exhibit", content: [{ url: "https://mock.invalid/url" }] },
  },
};

const invalidTemplate: BuildInputsResponse = {
  is_valid: false,
  message: "The closure did not validate.",
  validation_errors: [
    { category: "blueprint_validation", message: "Unknown pipe type", source: "bundle.mthds" },
  ],
};

/** Fake arms for tests whose request must never reach a given client method. */
const getMethodClosureNotCalled = {
  async getMethodClosure(): Promise<MthdsFileItem[]> {
    throw new Error("getMethodClosure must not be called in this test");
  },
};
const buildInputsNotCalled = {
  async buildInputs(): Promise<BuildInputsResponse> {
    throw new Error("buildInputs must not be called in this test");
  },
};
const prepareInputsNotCalled = {
  async prepareInputs(): Promise<PreparedInputs> {
    throw new Error("prepareInputs must not be called in this test");
  },
};

const files = [{ content: 'domain = "demo"' }];

describe("prepareInputsResult", () => {
  it("projects prepared inputs with the uploaded uris and echoes a supplied pipe_ref", () => {
    const result = prepareInputsResult(
      {
        inputs: { photo: { url: "pipelex-storage://abc" }, question: "hi" },
        uploads: [
          { uri: "pipelex-storage://abc", filename: "a.png", contentType: "image/png", size: 4 },
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
    // The prepared inputs are duplicated into the summary — the payload the
    // model must carry to mthds_run.
    expect(result.summary).toContain("Resolved pipe: `demo.main`");
    expect(result.summary).toContain("Uploaded 1 asset");
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain("pipelex-storage://abc");
  });

  it("omits pipe_ref when the caller did not supply it and notes an all-pass-through result", () => {
    const result = prepareInputsResult(
      { inputs: { photo: { url: "https://cdn.example.com/a.png" } }, uploads: [] },
      undefined,
    );

    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.summary).not.toContain("Resolved pipe");
    expect(result.summary).toContain("pass through unchanged");
  });
});

describe("prepareInputsToolResult", () => {
  it("carries the summary as content with no _meta channel", () => {
    const result = prepareInputsToolResult(
      prepareInputsResult({ inputs: {}, uploads: [] }, undefined),
    );

    expect(result.isError).toBe(false);
    expect(result).not.toHaveProperty("_meta");
    expect(result.content?.[0]).toMatchObject({ type: "text" });
  });

  it("flags no-verdict results as errors", () => {
    const result = prepareInputsToolResult({
      structuredContent: { status: "error", is_valid: false, errors: [] },
      summary: "failed",
    });

    expect(result.isError).toBe(true);
  });
});

describe("validatePrepareInputsRequest", () => {
  it("inherits the shared files-or-method_id checks", () => {
    const errors = validatePrepareInputsRequest({ files: [], inputs: {} });
    expect(errors.map((error) => error.location)).toEqual(["files"]);
  });

  it("rejects a blank pipe_ref", () => {
    const errors = validatePrepareInputsRequest({ files, pipe_ref: "  ", inputs: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.location).toBe("pipe_ref");
  });

  it("rejects a blank method_id", () => {
    const errors = validatePrepareInputsRequest({ files: [], method_id: "  ", inputs: {} });
    expect(errors.map((error) => error.location)).toContain("method_id");
  });

  it("accepts a method_id with no files", () => {
    const errors = validatePrepareInputsRequest({ files: [], method_id: "mt_1", inputs: {} });
    expect(errors).toEqual([]);
  });
});

describe("prepareMthdsInputs — workshop (allowUpload)", () => {
  it("delegates the upload walk to the SDK's prepareInputs", async () => {
    let capturedFiles: MthdsFileItem[] | undefined;

    const result = await prepareMthdsInputs(
      { files, pipe_ref: "demo.main", inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(request: PrepareInputsRequest) {
            capturedFiles = "files" in request ? request.files : undefined;
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
          },
        },
      },
    );

    expect(capturedFiles).toEqual([{ content: 'domain = "demo"' }]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.uploads).toEqual(["pipelex-storage://up1"]);
    expect(result.structuredContent.inputs).toEqual({ photo: { url: "pipelex-storage://up1" } });
  });

  it("maps a rejected asset (413) to input_domain at inputs", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/big.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(): Promise<PreparedInputs> {
            throw new RejectedAssetError("too big", "big.png", 413);
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
  });

  it("maps an invalid local source to input_domain at inputs", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/nope.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(): Promise<PreparedInputs> {
            throw new InvalidLocalSourceError("cannot read", "/nope.png");
          },
        },
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
  });

  it("maps a missing upload capability (404) to config", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(): Promise<PreparedInputs> {
            throw new UnsupportedUploadCapabilityError("no upload route");
          },
        },
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });

  it("maps an upload auth failure to config with the auth texture", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        authError: { location: "api_key", hint: "bring your own key" },
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(): Promise<PreparedInputs> {
            throw new UploadAuthenticationError("unauthorized", 401);
          },
        },
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("api_key");
    expect(result.structuredContent.errors?.[0]?.hint).toBe("bring your own key");
  });

  it("maps an upload transport fault to runtime (retryable)", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(): Promise<PreparedInputs> {
            throw new UploadTransportError("5xx");
          },
        },
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(true);
  });

  it("surfaces an unresolvable closure thrown by the SDK as a no-verdict input_domain at pipe_ref", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...getMethodClosureNotCalled,
          ...buildInputsNotCalled,
          async prepareInputs(): Promise<PreparedInputs> {
            throw new InputPreparationError(
              "Cannot prepare inputs: the method signature did not resolve — bad",
            );
          },
        },
      },
    );

    // No produced-invalid arm: is_valid stays false and status is "error".
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
  });
});

describe("prepareMthdsInputs — console (pass-through only)", () => {
  it("rewrites an http(s) URL at a file position and uploads nothing", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "https://cdn.example.com/a.png", question: "hi" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs(request) {
            capturedRequest = request;
            return explicitTemplate;
          },
        },
      },
    );

    // The console resolves the signature itself (explicit json), never uploads.
    expect(capturedRequest).toMatchObject({ format: "json", explicit: true });
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.structuredContent.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
      question: "hi",
    });
  });

  it("accepts the filled explicit {concept, content} envelope and re-wraps it", async () => {
    const result = await prepareMthdsInputs(
      {
        files,
        inputs: {
          photo: { concept: "native.Image", content: { url: "https://cdn.example.com/a.png" } },
          question: { concept: "native.Text", content: "hi" },
        },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitTemplate;
          },
        },
      },
    );

    // The envelope survives: `concept` rides through, only the inner content is rewritten.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.structuredContent.inputs).toEqual({
      photo: { concept: "native.Image", content: { url: "https://cdn.example.com/a.png" } },
      question: { concept: "native.Text", content: "hi" },
    });
  });

  it("still refuses an upload-needing value nested inside an envelope", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: { concept: "native.Image", content: "./local/a.png" } } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "inputs",
    });
  });

  it("does not misread a structured concept that merely has concept+content fields", async () => {
    // Exactly-two-keys is the envelope rule; a third key means it is ordinary structured content.
    const result = await prepareMthdsInputs(
      {
        files,
        inputs: { question: { concept: "x", content: "y", extra: 1 } },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({
      question: { concept: "x", content: "y", extra: 1 },
    });
  });

  // Multiplicity rides in the template's SHAPE (a one-element content list), never as an envelope
  // key — so the array arm of the walk, reusing content[0] as the element template, is the whole
  // multiplicity story. These pin that arm for both filled forms.
  it("walks every element of a declared-multiple file input inside an envelope", async () => {
    const result = await prepareMthdsInputs(
      {
        files,
        inputs: {
          exhibits: {
            concept: "demo.Exhibit",
            content: ["https://cdn.example.com/a.pdf", "pipelex-storage://kept"],
          },
        },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitMultipleTemplate;
          },
        },
      },
    );

    // Every element is rewritten to canonical {url} content; the envelope survives.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.structuredContent.inputs).toEqual({
      exhibits: {
        concept: "demo.Exhibit",
        content: [{ url: "https://cdn.example.com/a.pdf" }, { url: "pipelex-storage://kept" }],
      },
    });
  });

  it("walks every element of a declared-multiple file input filled compactly", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { exhibits: ["https://cdn.example.com/a.pdf"] } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitMultipleTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({
      exhibits: [{ url: "https://cdn.example.com/a.pdf" }],
    });
  });

  it("refuses an upload-needing element nested in a declared-multiple list", async () => {
    const result = await prepareMthdsInputs(
      {
        files,
        inputs: {
          exhibits: {
            concept: "demo.Exhibit",
            content: ["https://cdn.example.com/a.pdf", "./local/b.pdf"],
          },
        },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitMultipleTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "inputs",
    });
  });

  it("passes an existing pipelex-storage:// reference through", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "pipelex-storage://existing" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({
      photo: { url: "pipelex-storage://existing" },
    });
    expect(result.structuredContent.uploads).toEqual([]);
  });

  it("refuses a data: URL up front with an instructive input_domain at inputs", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "data:image/png;base64,AAAA" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("npx @pipelex/mcp");
  });

  it("refuses a bare local path up front", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return explicitTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
    expect(result.structuredContent.errors?.[0]?.message).toContain("local file path");
  });

  it("surfaces an invalid closure as a no-verdict input_domain at pipe_ref (no produced-invalid arm)", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs() {
            return invalidTemplate;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("validation_errors");
  });
});

describe("prepareMthdsInputs — by method_id (fetch-and-forward)", () => {
  it("forwards a resolved closure as the signature files (console path)", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: { photo: "https://cdn.example.com/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...prepareInputsNotCalled,
          async getMethodClosure() {
            return [{ content: 'domain = "demo"\nmain_pipe = "main"', source: "mt_123" }];
          },
          async buildInputs(request) {
            capturedRequest = request;
            return explicitTemplate;
          },
        },
      },
    );

    expect(capturedRequest?.files).toEqual([
      { content: 'domain = "demo"\nmain_pipe = "main"', source: "mt_123" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("forwards a resolved closure to the SDK prepareInputs (workshop path)", async () => {
    let capturedFiles: MthdsFileItem[] | undefined;

    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
        client: {
          ...buildInputsNotCalled,
          async getMethodClosure() {
            return [{ content: 'domain = "demo"', source: "mt_123" }];
          },
          async prepareInputs(request: PrepareInputsRequest) {
            capturedFiles = "files" in request ? request.files : undefined;
            return { inputs: { photo: { url: "pipelex-storage://x" } }, uploads: [] };
          },
        },
      },
    );

    expect(capturedFiles).toEqual([{ content: 'domain = "demo"', source: "mt_123" }]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("reports a no-source method (EmptyMethodSourceError) at method_id without preparing", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...buildInputsNotCalled,
          ...prepareInputsNotCalled,
          async getMethodClosure(): Promise<MthdsFileItem[]> {
            throw new EmptyMethodSourceError("mt_123");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.summary).toContain("no MTHDS source");
  });

  it("surfaces an unknown method id (404) at method_id", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_missing", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...buildInputsNotCalled,
          ...prepareInputsNotCalled,
          async getMethodClosure(): Promise<MthdsFileItem[]> {
            throw new ApiResponseError(
              "HTTP 404",
              `${DEFAULT_API_URL}/v1/methods/mt_missing`,
              404,
              "Not Found",
              "{}",
              "not_found",
              "Method not found",
              undefined,
              "not_found",
            );
          },
        },
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("lets files win over method_id without fetching the method", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { files, method_id: "mt_123", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs(request) {
            capturedRequest = request;
            return explicitTemplate;
          },
        },
      },
    );

    expect(capturedRequest?.files).toEqual([{ content: 'domain = "demo"' }]);
    expect(result.structuredContent.status).toBe("ok");
  });
});

describe("prepareMthdsInputs — request shape and transport", () => {
  it("rejects a request with neither files nor method_id", async () => {
    const result = await prepareMthdsInputs(
      { inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...buildInputsNotCalled,
          ...prepareInputsNotCalled,
          ...getMethodClosureNotCalled,
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await prepareMthdsInputs(
      { files: [{ path: "bundle.mthds" }], inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...buildInputsNotCalled,
          ...prepareInputsNotCalled,
          ...getMethodClosureNotCalled,
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
  });

  it("resolves { path } closure items through the resolver", async () => {
    let capturedRequest: BuildInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }], inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: {
          async resolve() {
            return { ok: true, content: 'domain = "demo"' };
          },
        },
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs(request) {
            capturedRequest = request;
            return explicitTemplate;
          },
        },
      },
    );

    expect(capturedRequest?.files).toEqual([
      { content: 'domain = "demo"', source: "methods/bundle.mthds" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          ...prepareInputsNotCalled,
          async buildInputs(): Promise<BuildInputsResponse> {
            throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
          },
        },
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
  });

  it("classifies a malformed base URL as config instead of rejecting the handler", async () => {
    // No injected client: the real SDK constructor must run and throw inside the
    // caught path (regression guard for the client hoist).
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      { baseUrl: `${DEFAULT_API_URL}/v1` },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });
});
