import { describe, expect, it } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  InputPreparationError,
  InvalidLocalSourceError,
  RejectedAssetError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
} from "@pipelex/sdk";
import type { MthdsFileItem, PrepareInputsRequest, PreparedInputs } from "@pipelex/sdk";

import {
  prepareInputsResult,
  prepareInputsToolResult,
  prepareMthdsInputs,
  validatePrepareInputsRequest,
} from "./prepare.js";
import { DEFAULT_API_URL } from "./shared.js";

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
      structuredContent: { status: "error", is_valid: false, errors: [] },
      summary: "nope",
    });

    expect(toolResult.isError).toBe(true);
  });
});

describe("validatePrepareInputsRequest", () => {
  it("inherits the shared one-selector checks", () => {
    expect(validatePrepareInputsRequest({ files: [], inputs: {} })).toHaveLength(1);
  });

  it("rejects a blank pipe_ref", () => {
    const errors = validatePrepareInputsRequest({ files, pipe_ref: "  ", inputs: {} });
    expect(errors.map((error) => error.location)).toEqual(["pipe_ref"]);
  });

  it("rejects a blank method_id", () => {
    const errors = validatePrepareInputsRequest({ files: [], method_id: " ", inputs: {} });
    expect(errors.map((error) => error.location)).toEqual(["method_id"]);
  });

  it("accepts each selector on its own", () => {
    expect(validatePrepareInputsRequest({ files, inputs: {} })).toEqual([]);
    expect(
      validatePrepareInputsRequest({
        files: [],
        method_ref: PUBLISHED_REF,
        inputs: {},
      }),
    ).toEqual([]);
    expect(validatePrepareInputsRequest({ files: [], method_id: "mt_123", inputs: {} })).toEqual(
      [],
    );
  });

  it("rejects a second selector at the extra field", () => {
    const beside = validatePrepareInputsRequest({
      files,
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      inputs: {},
    });
    expect(beside.map((error) => error.location)).toEqual(["method_ref"]);

    const both = validatePrepareInputsRequest({
      files: [],
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      method_id: "mt_123",
      inputs: {},
    });
    expect(both.map((error) => error.location)).toEqual(["method_id"]);
  });
});

describe("prepareMthdsInputs — the SDK upload walk", () => {
  it("hands the SDK the files selector as given, expanding nothing itself", async () => {
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

    expect(captured).toEqual({
      files: [{ content: 'domain = "demo"' }],
      pipe_ref: "demo.main",
      inputs: { photo: "/tmp/a.png" },
    });
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

  it("maps a rejected asset (413) to input_domain at inputs, naming the real ceiling", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/big.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new RejectedAssetError("too big", "big.png", 413);
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("MiB");
  });

  it("maps an invalid local source to input_domain at inputs", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/nope.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new InvalidLocalSourceError("cannot read", "/nope.png");
        }),
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
        client: uploadWith(async () => {
          throw new UnsupportedUploadCapabilityError("no upload route");
        }),
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
        authError: { location: "authorization", hint: "reconnect the connector" },
        client: uploadWith(async () => {
          throw new UploadAuthenticationError("rejected", 401);
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("authorization");
    expect(result.structuredContent.errors?.[0]?.hint).toBe("reconnect the connector");
  });

  it("maps an upload transport fault to runtime (retryable)", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new UploadTransportError("upstream died");
        }),
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
        client: uploadWith(async () => {
          throw new InputPreparationError("the method signature did not resolve — boom");
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("validation_errors");
  });
});
describe("prepareMthdsInputs — selector-shaped classification", () => {
  function apiError(status: number, code: string, errorDomain: string): ApiResponseError {
    return new ApiResponseError(
      `HTTP ${status}`,
      `${DEFAULT_API_URL}/v1/validate`,
      status,
      "Error",
      "{}",
      code,
      "message",
      undefined,
      errorDomain,
    );
  }

  it("locates an address the runner refuses at method_ref", async () => {
    const result = await prepareMthdsInputs(
      { method_ref: "github.com/Pipelex/methods/nope@v9", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw apiError(404, "not_found", "not_found");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("locates a malformed address at method_ref with the grammar in the hint", async () => {
    const result = await prepareMthdsInputs(
      { method_ref: "not-an-address", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw apiError(422, "invalid_request", "input_domain");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("github.com/");
  });

  it("locates an unknown method id at method_id", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_missing", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw apiError(404, "not_found", "not_found");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("locates a source-less stored method at method_id (the route's 422)", async () => {
    // The fail-fast EmptyMethodSourceError went out with the client-side
    // expansion; a source-less method now surfaces from the route itself.
    const result = await prepareMthdsInputs(
      { method_id: "mt_empty", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw apiError(422, "invalid_request", "input_domain");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("no MTHDS source");
  });

  it("locates a client-side signature failure at pipe_ref even on a by-ref request", async () => {
    // The SDK refuses an unknown pipe before any request, so the address is not
    // the problem and must not be named as one — the distinction `preparation`
    // draws against `badRequest`.
    const result = await prepareMthdsInputs(
      { method_ref: PUBLISHED_REF, pipe_ref: "demo.nope", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new InputPreparationError('the method declares no pipe "demo.nope"');
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("domain.pipe_code");
  });

  it("locates a client-side signature failure at pipe_ref even on a by-id request", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new InputPreparationError("the method declares no single default pipe");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
  });

  it("locates the sandbox refusal (403) at method_ref, never at the credential", async () => {
    const result = await prepareMthdsInputs(
      { method_ref: PUBLISHED_REF, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw apiError(403, "CustomCodeRequiresSandbox", "forbidden");
        }),
      },
    );

    // A by-address prepare reads its signature from /v1/validate and therefore
    // travels the execution-locus gate, which the two tooling routes do not.
    // The generic 401/403 arm used to tell the caller their key was rejected
    // and send them to mint a new one, for a package that is perfectly fine on
    // a sandbox-hosted deployment.
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/sandbox-hosted/);
    expect(result.structuredContent.errors?.[0]?.hint).not.toMatch(/PIPELEX_API_KEY/);
  });

  it("headlines a paywall (402) as a plan limit, not as connectivity", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw apiError(402, "subscription_required", "forbidden");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    // A headline-only host shows just this line, so it must name the plan
    // rather than the connectivity headline every other `config` error gets.
    expect(result.summary).toBe(
      "Inputs could not be prepared: the organization's Pipelex plan does not cover this call.",
    );
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
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    // The teaching text now names all three, because the tool takes all three.
    expect(result.structuredContent.errors?.[0]?.message).toContain("method_ref");
  });

  it("rejects files beside method_id without calling any client leg", async () => {
    const result = await prepareMthdsInputs(
      { files, method_id: "mt_123", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: noClientLeg },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("rejects { path } items instructively without a resolver", async () => {
    const result = await prepareMthdsInputs(
      { files: [{ path: "bundle.mthds" }], inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: noClientLeg },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
  });

  it("resolves { path } closure items through the resolver, keeping the path as provenance", async () => {
    let captured: PrepareInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }], inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: {
          async resolve() {
            return { ok: true, content: 'domain = "demo"' };
          },
        },
        client: uploadWith(async (request) => {
          captured = request;
          return { inputs: {}, uploads: [] };
        }),
      },
    );

    expect(captured).toMatchObject({
      files: [{ content: 'domain = "demo"', source: "methods/bundle.mthds" }],
    });
    expect(result.structuredContent.status).toBe("ok");
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
        }),
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
// Type-only: the fixture must satisfy the SDK's own file item type.
const _typedFiles: MthdsFileItem[] = files;
void _typedFiles;
