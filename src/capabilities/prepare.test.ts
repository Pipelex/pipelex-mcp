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
import type {
  InputForm,
  MthdsFileItem,
  PipelexValidationReport,
  PipelexValidationResult,
  PrepareInputsRequest,
  PreparedInputs,
  ValidateMethodSelector,
} from "@pipelex/sdk";

import {
  prepareInputsResult,
  prepareInputsToolResult,
  prepareMthdsInputs,
  validatePrepareInputsRequest,
} from "./prepare.js";
import { DEFAULT_API_URL } from "./shared.js";

/**
 * The input-form descriptor for a pipe with a file-bearing input (`photo`, an
 * image) and a text input (`question`).
 *
 * **The descriptor is the classifier, never the value's shape** — which is the
 * whole reason the console walk moved onto it. A `text` node merely NAMED `url`
 * is not a file position, and an OPTIONAL nested image field is one; both were
 * misread while the signature came from the rendered inputs template, whose
 * file signal was a `url`-bearing dict. `question` here is a `prose` node, and
 * nothing about a caller value can promote it to a file.
 */
const demoInputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "photo",
        kind: "image",
        concept_ref: "native.Image",
        required: true,
        presence: "plain",
        gating: true,
      },
      {
        name: "question",
        kind: "prose",
        concept_ref: "native.Text",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
};

/**
 * A descriptor for a declared-MULTIPLE file input (`Exhibit[]`). Multiplicity is
 * a `list` node whose `item` is the element descriptor — the plurality is stated
 * structurally, and the walk reuses `item` for every caller element.
 */
const multipleInputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "exhibits",
        kind: "list",
        concept_ref: "demo.Exhibit",
        required: true,
        presence: "plain",
        gating: true,
        item: { kind: "document", concept_ref: "demo.Exhibit", required: true },
      },
    ],
  },
};

/** A descriptor whose only file position is OPTIONAL and nested inside a structure. */
const nestedOptionalInputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "dossier",
        kind: "object",
        concept_ref: "demo.Dossier",
        required: true,
        presence: "plain",
        gating: true,
        fields: [
          { name: "title", kind: "text", required: true },
          { name: "scan", kind: "document", concept_ref: "native.Document", required: false },
        ],
      },
    ],
  },
};

/** A descriptor with a `text` field merely NAMED `url` — never a file position. */
const urlNamedTextInputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "url",
        kind: "text",
        concept_ref: "native.Text",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
};

function reportWith(
  inputForm: InputForm | undefined,
  overrides: Partial<PipelexValidationReport> = {},
): PipelexValidationReport {
  return {
    is_valid: true,
    bundle_blueprint: { domain: "demo", main_pipe: "main" },
    pipe_io_contracts: {},
    ...(inputForm === undefined ? {} : { input_form: inputForm }),
    graph_spec: {},
    validated_pipes: [],
    pending_signatures: [],
    liftable_pipes: [],
    warnings: [],
    is_runnable: true,
    message: "ok",
    rendered_markdown: "# Valid",
    ...overrides,
  };
}

const invalidReport: PipelexValidationResult = {
  is_valid: false,
  message: "The closure did not validate.",
  validation_errors: [
    { category: "blueprint_validation", message: "Unknown pipe type", source: "bundle.mthds" },
  ],
  pending_signatures: [],
  is_runnable: false,
};

/** The console arm's fake: `validate` answers a report, `prepareInputs` must never run. */
function validateWith(
  report: PipelexValidationResult,
  capture?: (source: string[] | ValidateMethodSelector, views?: string[]) => void,
) {
  return {
    async validate(
      source: string[] | ValidateMethodSelector,
      _allowSignatures?: boolean,
      _mthdsSources?: string[],
      _render?: string[],
      views?: string[],
    ): Promise<PipelexValidationResult> {
      capture?.(source, views);
      return report;
    },
    ...prepareInputsNotCalled,
  };
}

/** Fake arms for tests whose request must never reach a given client method. */
const validateNotCalled = {
  async validate(): Promise<PipelexValidationResult> {
    throw new Error("validate must not be called in this test");
  },
};
const prepareInputsNotCalled = {
  async prepareInputs(): Promise<PreparedInputs> {
    throw new Error("prepareInputs must not be called in this test");
  },
};
/** The workshop arm never resolves a signature itself — the SDK's walk owns that. */
function uploadWith(prepareInputs: (request: PrepareInputsRequest) => Promise<PreparedInputs>) {
  return { ...validateNotCalled, prepareInputs };
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
  });

  it("omits pipe_ref when the caller did not supply it and notes an all-pass-through result", () => {
    const result = prepareInputsResult(
      { inputs: { photo: { url: "https://cdn.example.com/a.png" } }, uploads: [] },
      undefined,
    );

    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.summary).toContain("No assets required uploading");
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
    expect(errors.some((error) => error.location === "pipe_ref")).toBe(true);
  });

  it("rejects a blank method_id", () => {
    const errors = validatePrepareInputsRequest({ files: [], method_id: " ", inputs: {} });
    expect(errors.some((error) => error.location === "method_id")).toBe(true);
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
    expect(beside.some((error) => error.location === "method_ref")).toBe(true);

    const both = validatePrepareInputsRequest({
      files: [],
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      method_id: "mt_123",
      inputs: {},
    });
    expect(both).not.toHaveLength(0);
  });
});

describe("prepareMthdsInputs — workshop (allowUpload)", () => {
  it("hands the SDK the files selector as given, expanding nothing itself", async () => {
    let captured: PrepareInputsRequest | undefined;

    const result = await prepareMthdsInputs(
      { files, pipe_ref: "demo.main", inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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

describe("prepareMthdsInputs — console (pass-through only)", () => {
  it("reads the signature from validate with the input_form view and uploads nothing", async () => {
    let capturedSource: string[] | ValidateMethodSelector | undefined;
    let capturedViews: string[] | undefined;

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "https://cdn.example.com/a.png", question: "hi" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: validateWith(reportWith(demoInputForm), (source, views) => {
          capturedSource = source;
          capturedViews = views;
        }),
      },
    );

    // The console resolves the signature itself, from the descriptor — never
    // from the rendered inputs template, and never by uploading.
    expect(capturedSource).toEqual(['domain = "demo"']);
    expect(capturedViews).toEqual(["input_form"]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.uploads).toEqual([]);
    expect(result.structuredContent.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
      question: "hi",
    });
  });

  it("forwards a method_ref address to validate as the selector", async () => {
    let capturedSource: string[] | ValidateMethodSelector | undefined;

    const result = await prepareMthdsInputs(
      {
        method_ref: PUBLISHED_REF,
        inputs: { photo: "https://cdn.example.com/a.png" },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: validateWith(reportWith(demoInputForm), (source) => {
          capturedSource = source;
        }),
      },
    );

    expect(capturedSource).toEqual({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
    });
    expect(result.structuredContent.status).toBe("ok");
  });

  it("forwards a method_id to validate as the selector", async () => {
    let capturedSource: string[] | ValidateMethodSelector | undefined;

    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: { photo: "https://cdn.example.com/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: validateWith(reportWith(demoInputForm), (source) => {
          capturedSource = source;
        }),
      },
    );

    expect(capturedSource).toEqual({ method_id: "mt_123" });
    expect(result.structuredContent.status).toBe("ok");
  });

  it("labels every content once any submitted file names a source", async () => {
    let capturedSources: string[] | undefined;

    await prepareMthdsInputs(
      {
        files: [{ content: 'domain = "demo"', uri: "a.mthds" }, { content: "# more" }],
        inputs: {},
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async validate(
            _source: string[] | ValidateMethodSelector,
            _allowSignatures?: boolean,
            mthdsSources?: string[],
          ): Promise<PipelexValidationResult> {
            capturedSources = mthdsSources;
            return reportWith(demoInputForm);
          },
          ...prepareInputsNotCalled,
        },
      },
    );

    // A length-mismatched mthds_sources array is a server 422, so the unnamed
    // file gets a deterministic inline label rather than being left out.
    expect(capturedSources).toEqual(["a.mthds", "inline://file-2.mthds"]);
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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
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
      { files, inputs: { question: { concept: "x", content: "y", extra: 1 } } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({
      question: { concept: "x", content: "y", extra: 1 },
    });
  });

  it("leaves a text field merely NAMED url untouched", async () => {
    // One of the two misclassifications the descriptor fixes: the old
    // template-guided walk read a `url`-bearing dict as the file signal, so a
    // text input called `url` was rewritten to canonical file content — and on
    // this arm, a plain sentence in it was refused as "a local file path".
    const result = await prepareMthdsInputs(
      { files, inputs: { url: "not a link, just prose" } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(urlNamedTextInputForm)) },
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({ url: "not a link, just prose" });
  });

  it("walks an OPTIONAL file field nested inside a structure", async () => {
    // The other misclassification: an optional nested file field prepares
    // exactly like a required one, because the descriptor states the kind at
    // every depth and `required` is a layout fact, not a preparation one.
    const result = await prepareMthdsInputs(
      {
        files,
        inputs: { dossier: { title: "Case 7", scan: "https://cdn.example.com/scan.pdf" } },
      },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(nestedOptionalInputForm)) },
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.inputs).toEqual({
      dossier: { title: "Case 7", scan: { url: "https://cdn.example.com/scan.pdf" } },
    });
  });

  it("refuses an upload-needing value at an optional nested file field", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { dossier: { title: "Case 7", scan: "./local/scan.pdf" } } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(nestedOptionalInputForm)) },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
  });

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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(multipleInputForm)) },
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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(multipleInputForm)) },
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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(multipleInputForm)) },
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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
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
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("npx @pipelex/mcp");
  });

  it("refuses a bare local path up front", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("inputs");
    expect(result.structuredContent.errors?.[0]?.message).toContain("local file path");
  });

  it("surfaces an invalid closure as a no-verdict input_domain at pipe_ref (no produced-invalid arm)", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: validateWith(invalidReport) },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("validation_errors");
  });

  it("refuses a report with no input_form rather than degrading to no refusals", async () => {
    // Without the descriptor every value would pass through unchecked, which on
    // this arm means an upload refusal that never fires — the failure mode the
    // whole boundary exists to prevent.
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "/tmp/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(undefined)) },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.message).toContain("input_form");
  });
});

describe("prepareMthdsInputs — console pipe selection (SDK parity)", () => {
  const twoPipes: InputForm = {
    "demo.main": demoInputForm["demo.main"],
    "demo.other": { fields: [] },
  };

  it("refuses a bare pipe_ref, naming the declared pipes", async () => {
    const result = await prepareMthdsInputs(
      { files, pipe_ref: "main", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent.errors?.[0]?.message).toContain("qualified");
  });

  it("refuses a pipe_ref the method does not declare", async () => {
    const result = await prepareMthdsInputs(
      { files, pipe_ref: "demo.nope", inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(demoInputForm)) },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent.errors?.[0]?.message).toContain("demo.main");
  });

  it("prefers the runner's stated default_pipe_ref over the blueprint", async () => {
    const report = reportWith(
      { "demo.other": demoInputForm["demo.main"], "demo.main": { fields: [] } },
      { default_pipe_ref: "demo.other" },
    );

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "https://cdn.example.com/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(report) },
    );

    // Walked against `demo.other`'s descriptor — the blueprint names `demo.main`,
    // whose descriptor declares no fields and would have left the value alone.
    expect(result.structuredContent.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
    });
  });

  it("falls back to the blueprint's main_pipe when no default is stated", async () => {
    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "https://cdn.example.com/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(reportWith(twoPipes)) },
    );

    expect(result.structuredContent.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
    });
  });

  it("requires pipe_ref when the closure settles no single default pipe", async () => {
    const report = reportWith(twoPipes, { bundle_blueprint: { domain: "demo" } });

    const result = await prepareMthdsInputs(
      { files, inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: validateWith(report) },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(result.structuredContent.errors?.[0]?.message).toContain("no single default pipe");
  });

  it("takes the one declared pipe when nothing names a default", async () => {
    const report = reportWith(demoInputForm, { bundle_blueprint: {} });

    const result = await prepareMthdsInputs(
      { files, inputs: { photo: "https://cdn.example.com/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: validateWith(report) },
    );

    expect(result.structuredContent.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
    });
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
        client: {
          ...prepareInputsNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(404, "not_found", "not_found");
          },
        },
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
        client: {
          ...prepareInputsNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(422, "invalid_request", "input_domain");
          },
        },
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
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
        allowUpload: true,
        client: uploadWith(async () => {
          throw new InputPreparationError("the method declares no single default pipe");
        }),
      },
    );

    expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
  });

  it("headlines a paywall (402) as a plan limit, not as connectivity", async () => {
    const result = await prepareMthdsInputs(
      { method_id: "mt_123", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        allowUpload: true,
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
  const noClientLeg = { ...validateNotCalled, ...prepareInputsNotCalled };

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

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
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
        allowUpload: true,
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
        client: {
          ...prepareInputsNotCalled,
          async validate(): Promise<PipelexValidationResult> {
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

// Type-only: the fixtures must satisfy the SDK's own descriptor types, so a
// standard change that reshapes a node fails here rather than drifting.
const _typedFixtures: InputForm[] = [
  demoInputForm,
  multipleInputForm,
  nestedOptionalInputForm,
  urlNamedTextInputForm,
];
void _typedFixtures;
const _typedFiles: MthdsFileItem[] = files;
void _typedFiles;
