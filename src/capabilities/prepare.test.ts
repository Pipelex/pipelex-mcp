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
import { comparableRequest, fakeMethodResolver } from "./method-tree-fixtures.js";
import { DEFAULT_API_URL } from "./shared.js";
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
    expect(validatePrepareInputsRequest({ inputs: {} })).toHaveLength(1);
  });

  it.each([
    ["a bare pipe_code", "extract", 'got the bare "extract"'],
    ["a dependency package's pipe", "alias->docs.extract", "names a dependency package's pipe"],
  ])("refuses %s at pipe_ref, as the SDK would before sending", (_label, pipeRef, reason) => {
    const errors = validatePrepareInputsRequest({ tree: A_TREE, pipe_ref: pipeRef, inputs: {} });

    expect(errors).toEqual([
      expect.objectContaining({ class: "input_domain", location: "pipe_ref", retryable: false }),
    ]);
    expect(errors[0]?.message).toContain(reason);
    expect(
      validatePrepareInputsRequest({ tree: A_TREE, pipe_ref: "docs.extract", inputs: {} }),
    ).toEqual([]);
  });

  it("rejects a blank pipe_ref", () => {
    const errors = validatePrepareInputsRequest({ tree: A_TREE, pipe_ref: "  ", inputs: {} });
    expect(errors.map((error) => error.location)).toEqual(["pipe_ref"]);
  });

  it("rejects a blank method_id", () => {
    const errors = validatePrepareInputsRequest({ method_id: " ", inputs: {} });
    expect(errors.map((error) => error.location)).toEqual(["method_id"]);
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
    expect(beside.map((error) => error.location)).toEqual(["method_ref"]);

    const both = validatePrepareInputsRequest({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      method_id: "mt_123",
      inputs: {},
    });
    expect(both.map((error) => error.location)).toEqual(["method_id"]);
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
    expect(result.structuredContent.errors?.[0]?.kind).toBe("auth");
    expect(result.structuredContent.errors?.[0]?.location).toBe("authorization");
    expect(result.structuredContent.errors?.[0]?.hint).toBe("reconnect the connector");
    // The upload leg's refused key headlines as the key, as the pipe I/O
    // route's does, never as an unreachable API.
    expect(result.summary).toBe(
      "Inputs could not be prepared: the Pipelex API key is missing or was refused.",
    );
  });

  it("maps an upload transport fault to runtime (retryable)", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          // Storage's 503, as the SDK's grant upload reports it.
          throw new UploadTransportError("upstream died", { code: "server_error", status: 503 });
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(true);
  });

  it("surfaces a pipe refusal thrown by the SDK as a no-verdict input_domain at pipe_ref", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new InputPreparationError(
            'Cannot prepare inputs: pipe_ref "summarize" is not qualified',
          );
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("validation_errors");
  });

  it.each([
    ["files", { files }],
    ["method_ref", { method_ref: PUBLISHED_REF }],
    ["method_id", { method_id: "mt_123" }],
  ] as const)(
    "locates a method that does not load at %s, the selector that named it",
    async (location, selector) => {
      const result = await prepareMthdsInputs(
        { ...selector, inputs: {} },
        {
          baseUrl: DEFAULT_API_URL,
          client: uploadWith(async () => {
            throw new MethodLoadError(
              "Cannot prepare inputs: the method signature did not resolve — boom",
              { validationErrors: [], serverMessage: "boom" },
            );
          }),
        },
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
      expect(result.structuredContent.errors?.[0]?.location).toBe(location);
      expect(result.structuredContent.errors?.[0]?.hint).toContain("mthds_validate");
    },
  );

  it("locates a file input value that cannot be read as a file at inputs", async () => {
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
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
  });
});
describe("prepareMthdsInputs — selector-shaped classification", () => {
  function apiError(status: number, code: string, errorDomain: string): ApiResponseError {
    return new ApiResponseError(
      `HTTP ${status}`,
      `${DEFAULT_API_URL}/v1/pipe-io`,
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

  // A runner too old to serve `/v1/pipe-io` answers a bare 404, with neither an
  // error type nor a code: that is the deployment, never the method named.
  for (const selector of [
    { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
    { method_id: "mt_123" },
  ]) {
    it(`reports a bare 404 as config at PIPELEX_BASE_URL (${Object.keys(selector)[0]})`, async () => {
      const result = await prepareMthdsInputs(
        { ...selector, inputs: {} },
        {
          baseUrl: DEFAULT_API_URL,
          client: uploadWith(async () => {
            throw new ApiResponseError(
              "HTTP 404",
              `${DEFAULT_API_URL}/v1/pipe-io`,
              404,
              "Not Found",
              '{"detail":"Not Found"}',
              undefined, // errorType
              "Not Found",
              undefined, // validationErrors
              undefined, // code
            );
          }),
        },
      );

      const error = result.structuredContent.errors?.[0];
      expect(error?.class).toBe("config");
      expect(error?.location).toBe("PIPELEX_BASE_URL");
      expect(error?.hint).toContain("/v1/pipe-io");
    });
  }

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

  it("locates a pipe selection the route refuses at pipe_ref, even on a by-id request", async () => {
    // The SDK turns the route's typed 422 into an InputPreparationError
    // carrying the server's reason.
    const result = await prepareMthdsInputs(
      { method_id: "mt_123", pipe_ref: "demo.nope", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: uploadWith(async () => {
          throw new InputPreparationError(
            "Cannot prepare inputs: Pipe 'demo.nope' not found in the submitted closure",
          );
        }),
      },
    );

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("pipe_ref");
    expect(error?.message).toContain("demo.nope");
    expect(error?.hint).toContain("qualified domain.pipe_code the method declares");
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
    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "method_dir",
    });
    expect(result.structuredContent.errors?.[0]?.message).toContain("nothing was sent");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("lists no file of a folder when the request never left the machine", async () => {
    const unbuilt = await prepareMthdsInputs(
      { method_dir: "methods", inputs: {} },
      { baseUrl: "invalid-no-scheme", resolver: methodFolderResolver() },
    );
    expect(unbuilt.structuredContent.status).toBe("error");
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
      expect(result.structuredContent.errors?.[0]).toMatchObject({
        class: "input_domain",
        location: "pipe_ref",
      });
      expect(result.structuredContent).not.toHaveProperty("files_sent");
      expect(prepare).not.toHaveBeenCalled();
    },
  );

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

    const error = result.structuredContent.errors?.[0];
    expect(error).toMatchObject({ class: "input_domain", location: "method_id", retryable: false });
    expect(error?.message).toContain("files belong to the method, not to one of its versions");
    expect(error?.hint).toContain('"mt_123"');
    expect(error?.hint).toContain("method_dir");
    const listError =
      listed.structuredContent.status === "error" ? listed.structuredContent.errors[0] : undefined;
    expect(listError?.message).toBe(error?.message);
  });

  it("refuses a test upload for a method_id with no bare id, at method_id", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "@draft", inputs: {}, kind: "test" },
      { baseUrl: DEFAULT_API_URL, client: prepareInputsNotCalled },
    );

    expect(result.structuredContent.errors?.[0]).toMatchObject({
      class: "input_domain",
      location: "method_id",
      retryable: false,
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

    const error = result.structuredContent.errors?.[0];
    expect(error).toMatchObject({ class: "input_domain", location: "kind", retryable: false });
    expect(error?.message).toContain(LEGACY_LINK_FILE_NAME);
    expect(error?.hint).toContain(LEGACY_LINK_MOVE);
  });

  it.each([
    [403, "role_not_permitted"],
    [404, "method_not_found"],
    [409, "method_being_deleted"],
  ] as const)(
    "classifies the platform's refusal of a test upload (%i %s)",
    async (status, code) => {
      const result = await prepareMthdsInputs(
        { method_id: "mt_123", inputs: { invoice: "/tmp/a.pdf" }, kind: "test" },
        {
          baseUrl: DEFAULT_API_URL,
          client: uploadWith(async () => {
            // No wrapped answer, so the verdict is the one the SDK reads off the code.
            throw new TestFileRefusedError(
              `Upload of "a.pdf" as a test file was refused (${status})`,
              { status, code, filename: "a.pdf", methodId: "mt_123" },
            );
          }),
        },
      );

      const error = result.structuredContent.errors?.[0];
      if (code === "role_not_permitted") {
        expect(error).toMatchObject({ class: "config", kind: "role", retryable: false });
        expect(error).not.toHaveProperty("location");
        expect(result.summary).toContain("your role in this organization does not allow this");
      } else {
        expect(error).toMatchObject({ class: "input_domain", location: "kind", retryable: false });
        expect(error?.hint).toContain("omit kind");
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
      const error = result.structuredContent.errors?.[0];
      expect(error).toMatchObject({ class: "input_domain", location: "kind", retryable: false });
      expect(error?.message).toContain(says);
      expect(error?.message).toContain("The input invoice needs an upload");
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
