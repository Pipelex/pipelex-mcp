import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  CrateInvalidReport,
  InputForm,
  PipeIORequest,
  PipeIOResponse,
  PipeIOValidReport,
} from "@pipelex/sdk";

import {
  buildMthdsInputs,
  inputsResult,
  inputsToolResult,
  validateInputsRequest,
} from "./inputs.js";
import type { InputsContext } from "./inputs.js";
import { DEFAULT_API_URL } from "./shared.js";

/** One declared input, a `Text` named `question`, on the pipe the route selected. */
const demoInputForm: InputForm = {
  "demo.main": {
    fields: [
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
 * A single-pipe pipe I/O answer: the route selected `demo.main` (or whatever
 * `overrides.pipe_ref` says) and keyed the maps by it.
 */
function reportWith(
  inputForm: InputForm | undefined,
  overrides: Partial<PipeIOValidReport> = {},
): PipeIOValidReport {
  return {
    is_valid: true,
    pipe_ref: "demo.main",
    pipe_io_contracts: {},
    ...(inputForm === undefined ? {} : { input_form: inputForm }),
    output_form: {},
    default_pipe_ref: "demo.main",
    pending_signatures: [],
    is_runnable: true,
    ...overrides,
  } as PipeIOValidReport;
}

const validReport = reportWith(demoInputForm);

const invalidReport: CrateInvalidReport = {
  is_valid: false,
  message: "The closure did not validate.",
  validation_errors: [
    {
      category: "blueprint_validation",
      message: "Unknown pipe type",
      source: "bundle.mthds",
    },
  ],
};

const EXPLICIT_JSON = { explicit: true, format: "json" } as const;

/** A context whose `pipeIo` answers `report` (or throws it) and records every request. */
function contextWith(
  answer: PipeIOResponse | Error,
  requests: PipeIORequest[] = [],
): InputsContext {
  return {
    baseUrl: DEFAULT_API_URL,
    client: {
      async pipeIo(request: PipeIORequest): Promise<PipeIOResponse> {
        requests.push(request);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

/** A context whose client must never be called: the request is refused before it. */
function contextNeverCalled(): InputsContext {
  return {
    baseUrl: DEFAULT_API_URL,
    client: {
      async pipeIo(): Promise<PipeIOResponse> {
        throw new Error("pipeIo must not be called in this test");
      },
    },
  };
}

/**
 * A non-2xx answer as the SDK throws it. A runner's problem carries an
 * `errorType`, the platform's a `code`, and a runner's answer for a route it
 * does not serve carries neither.
 */
function apiError(
  status: number,
  errorType: string | undefined,
  serverMessage: string,
  code?: string,
): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/pipe-io`,
    status,
    "",
    "{}",
    errorType,
    serverMessage,
    undefined, // validationErrors
    code,
  );
}

/** A runner's answer for a route it does not serve: Starlette's bare `{"detail":"Not Found"}`. */
const routeMissing = () => apiError(404, undefined, "Not Found");

describe("inputsResult", () => {
  it("projects the explicit json template from the resolved pipe's descriptor", () => {
    const result = inputsResult(validReport, EXPLICIT_JSON);

    expect(result.structuredContent).toEqual({
      status: "ok",
      is_valid: true,
      pipe_ref: "demo.main",
      format: "json",
      explicit: true,
      inputs: { question: { concept: "native.Text", content: { text: "text_value" } } },
    });
    expect(result.structuredContent).not.toHaveProperty("inputs_toml");
    // The summary deliberately duplicates the template: it is the payload the
    // model must read, unlike validation's large view-only graph.
    expect(result.summary).toContain("Resolved pipe: `demo.main`");
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain('"concept": "native.Text"');
    // The next step rides the result, where the model has the template in
    // hand, and after the template so the payload stays first.
    expect(result.summary).toContain("`mthds_prepare_inputs`");
    expect(result.summary.indexOf("`mthds_prepare_inputs`")).toBeGreaterThan(
      result.summary.indexOf("```json"),
    );
  });

  it("projects the light shape when explicit is false", () => {
    const result = inputsResult(validReport, { explicit: false, format: "json" });

    expect(result.structuredContent.explicit).toBe(false);
    expect(result.structuredContent.inputs).toEqual({ question: "text_value" });
  });

  it("projects a toml template as raw text", () => {
    const result = inputsResult(validReport, { explicit: false, format: "toml" });

    expect(result.structuredContent.format).toBe("toml");
    expect(result.structuredContent.explicit).toBe(false);
    expect(result.structuredContent.inputs_toml).toBe(
      '# concept: native.Text\nquestion = "text_value"\n',
    );
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("```toml");
    expect(result.summary).toContain('question = "text_value"');
    // Both next tools take `inputs` as a JSON object, so the TOML arm's next
    // step says to convert it — the text itself would be refused.
    expect(result.summary).toContain("convert it to a JSON object for `inputs`");
    expect(result.summary.indexOf("`mthds_prepare_inputs`")).toBeGreaterThan(
      result.summary.indexOf("```toml"),
    );
  });

  it("projects the pipe the route resolved, not the method's entry pipe", () => {
    const report = reportWith(
      { "demo.other": demoInputForm["demo.main"] },
      { pipe_ref: "demo.other", default_pipe_ref: "demo.main" },
    );

    const result = inputsResult(report, EXPLICIT_JSON);

    expect(result.structuredContent.pipe_ref).toBe("demo.other");
    expect(Object.keys(result.structuredContent.inputs ?? {})).toEqual(["question"]);
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const result = inputsResult(invalidReport, EXPLICIT_JSON);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(invalidReport.validation_errors);
    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("Inputs template not produced");
    expect(result.summary).toContain("The closure did not validate.");
    expect(result.summary).toContain("Unknown pipe type");
    expect(result.summary).toContain("bundle.mthds");
  });

  it("throws when the valid arm resolved no pipe", () => {
    expect(() =>
      inputsResult(reportWith(demoInputForm, { pipe_ref: null }), EXPLICIT_JSON),
    ).toThrow(/resolved no pipe_ref/);
  });

  it("throws when the valid arm carries no descriptor for the resolved pipe", () => {
    expect(() => inputsResult(reportWith({}), EXPLICIT_JSON)).toThrow(
      /no input-form descriptor .* for "demo\.main"/,
    );
    expect(() => inputsResult(reportWith(undefined), EXPLICIT_JSON)).toThrow(
      /no input-form descriptor/,
    );
  });
});

describe("inputsToolResult", () => {
  it("carries the summary as content with no _meta channel", () => {
    const result = inputsToolResult(inputsResult(validReport, EXPLICIT_JSON));

    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: inputsResult(validReport, EXPLICIT_JSON).summary },
    ]);
    expect(result.isError).toBe(false);
    expect(result).not.toHaveProperty("_meta");
  });

  it("flags no-verdict results as errors", () => {
    const result = inputsToolResult({
      structuredContent: { status: "error", is_valid: false, errors: [] },
      summary: "failed",
    });

    expect(result.isError).toBe(true);
  });
});

describe("validateInputsRequest", () => {
  it("inherits the shared files checks", () => {
    const errors = validateInputsRequest({ files: [] });

    expect(errors.map((error) => error.location)).toEqual(["files"]);
  });

  it("rejects a blank pipe_ref", () => {
    const errors = validateInputsRequest({
      files: [{ content: 'domain = "demo"' }],
      pipe_ref: "  ",
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("pipe_ref");
  });

  it("accepts a qualified pipe_ref", () => {
    const errors = validateInputsRequest({
      files: [{ content: 'domain = "demo"' }],
      pipe_ref: "demo.main",
    });

    expect(errors).toEqual([]);
  });

  it("accepts a method_id with no files", () => {
    const errors = validateInputsRequest({ files: [], method_id: "mt_123" });

    expect(errors).toEqual([]);
  });

  it("rejects a blank method_id", () => {
    const errors = validateInputsRequest({ files: [], method_id: "  " });

    expect(errors.map((error) => error.location)).toContain("method_id");
  });
});

describe("buildMthdsInputs by files", () => {
  it("posts the files to pipe-io, adapting uri to source, and projects the template", async () => {
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      {
        files: [
          { content: 'domain = "demo"', uri: "bundle.mthds" },
          { content: 'main_pipe = "main"', uri: null },
        ],
      },
      contextWith(validReport, requests),
    );

    // One call. The MCP surface spells provenance `uri`; the crate envelope
    // spells it `source`. No pipe_ref, so the route's selection chain decides,
    // and nothing template-shaped travels: the projection is client-side.
    expect(requests).toEqual([
      {
        files: [
          { content: 'domain = "demo"', source: "bundle.mthds" },
          { content: 'main_pipe = "main"' },
        ],
      },
    ]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.format).toBe("json");
    expect(result.structuredContent.explicit).toBe(true);
    expect(result.structuredContent.inputs).toEqual({
      question: { concept: "native.Text", content: { text: "text_value" } },
    });
  });

  it("forwards pipe_ref and honours format and explicit client-side", async () => {
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      {
        files: [{ content: 'domain = "demo"' }],
        pipe_ref: "demo.main",
        format: "toml",
        explicit: false,
      },
      contextWith(validReport, requests),
    );

    expect(requests).toEqual([{ files: [{ content: 'domain = "demo"' }], pipe_ref: "demo.main" }]);
    expect(result.structuredContent.format).toBe("toml");
    expect(result.structuredContent.explicit).toBe(false);
    expect(result.structuredContent.inputs_toml).toContain('question = "text_value"');
  });

  it("passes an invalid closure's verdict through as a produced verdict", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(invalidReport),
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(invalidReport.validation_errors);
  });

  it("does not call the client when request validation fails", async () => {
    const result = await buildMthdsInputs({ files: [] }, contextNeverCalled());

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.summary).toBe("Inputs template was not run: request input is invalid.");
  });

  it("locates a request-shape 422 at files", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(apiError(422, "ValidationError", "Too many files.")),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.summary).toMatch(/rejected/i);
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED")),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toMatch(/unreachable|misconfigured/i);
  });

  it("names pipe-io in the hint of a missing-route 404", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(routeMissing()),
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("/v1/pipe-io");
  });

  it("classifies a malformed base URL as config instead of rejecting the handler", async () => {
    // No injected client: the real SDK constructor must run — it throws
    // PipelineRequestError on a path-carrying base URL, and that throw has to
    // land in the caught path.
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      { baseUrl: `${DEFAULT_API_URL}/v1` },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });

  it("treats a reachable but malformed answer as runtime, not unreachable", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(reportWith({ "demo.main": { fields: "nope" } } as unknown as InputForm)),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
    expect(result.summary).toMatch(/malformed/i);
    expect(result.summary).not.toMatch(/unreachable/i);
  });
});

describe("buildMthdsInputs refused pipe selections", () => {
  const selectors = [
    { files: [{ content: 'domain = "demo"' }] },
    { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
    { method_id: "mt_123" },
  ];

  for (const selector of selectors) {
    const shape = Object.keys(selector)[0];

    it(`locates an unknown pipe_ref at pipe_ref with the route's reason (${shape})`, async () => {
      const result = await buildMthdsInputs(
        { ...selector, pipe_ref: "demo.missing" },
        contextWith(
          apiError(422, "EntryPipeNotFoundError", "No pipe 'demo.missing' in the closure."),
        ),
      );

      expect(result.structuredContent.status).toBe("error");
      const error = result.structuredContent.errors?.[0];
      expect(error?.class).toBe("input_domain");
      expect(error?.location).toBe("pipe_ref");
      expect(error?.message).toBe("No pipe 'demo.missing' in the closure.");
      expect(error?.retryable).toBe(false);
    });

    it(`locates several entry pipes at pipe_ref (${shape})`, async () => {
      const result = await buildMthdsInputs(
        selector,
        contextWith(
          apiError(422, "EntryPipeAmbiguousError", "Several domains declare a main_pipe: a, b."),
        ),
      );

      expect(result.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
      expect(result.structuredContent.errors?.[0]?.message).toContain("Several domains");
    });
  }
});

describe("buildMthdsInputs path submissions", () => {
  it("resolves { path } items through the context resolver, with the path as source", async () => {
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        ...contextWith(validReport, requests),
        resolver: {
          async resolve(path) {
            return { ok: true, content: 'domain = "demo"' + `\n# ${path}` };
          },
        },
      },
    );

    // The resolved uri (= the submitted path) crosses into the crate
    // envelope's `source` label, so diagnostics locate to the real file.
    expect(requests[0]?.files).toEqual([
      { content: 'domain = "demo"\n# methods/bundle.mthds', source: "methods/bundle.mthds" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await buildMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }] },
      contextNeverCalled(),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
    expect(result.summary).toBe("Inputs template was not run: request input is invalid.");
  });
});

describe("buildMthdsInputs by method_id (server pass-through)", () => {
  it("forwards method_id to pipe-io without fetching the method", async () => {
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      { method_id: "mt_123", pipe_ref: "demo.main" },
      contextWith(validReport, requests),
    );

    // Nothing is expanded client-side: the hosted platform resolves the id.
    expect(requests).toEqual([{ method_id: "mt_123", pipe_ref: "demo.main" }]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.pipe_ref).toBe("demo.main");
  });

  it("locates an unknown method id (404) at method_id", async () => {
    const result = await buildMthdsInputs(
      { method_id: "mt_missing" },
      contextWith(apiError(404, undefined, "The requested resource does not exist.", "not_found")),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
  });

  it("locates a stored method with no source (422) at method_id", async () => {
    const result = await buildMthdsInputs(
      { method_id: "mt_123" },
      contextWith(apiError(422, "ValidationError", "The stored method has no MTHDS source.")),
    );

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/no MTHDS source/);
  });

  it("rejects files beside method_id without calling the client", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_123" },
      contextNeverCalled(),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("classifies a paywall (402) as config with the plan headline", async () => {
    const result = await buildMthdsInputs(
      { method_id: "mt_123" },
      contextWith(apiError(402, "SubscriptionRequiredError", "Subscription required")),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
    // A headline-only host shows just this line, so it must name the plan
    // rather than the connectivity headline every other `config` error gets.
    expect(result.summary).toBe(
      "Inputs template could not start: the organization's Pipelex plan does not cover this call.",
    );
  });
});

describe("buildMthdsInputs by method_ref (server pass-through)", () => {
  it("forwards method_ref to pipe-io without fetching anything", async () => {
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
      contextWith(validReport, requests),
    );

    expect(requests).toEqual([{ method_ref: "github.com/Pipelex/methods/documents@v0.1.0" }]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects files beside method_ref without calling the client", async () => {
    const result = await buildMthdsInputs(
      {
        files: [{ content: 'domain = "demo"' }],
        method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
      },
      contextNeverCalled(),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("rejects method_ref beside method_id without calling the client", async () => {
    const result = await buildMthdsInputs(
      {
        method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
        method_id: "mt_123",
      },
      contextNeverCalled(),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("locates a no-matching-package 404, a bad ref 422 and the registry form 501 at method_ref", async () => {
    for (const error of [
      apiError(404, "MethodPackageNotFoundError", "No MTHDS package found"),
      apiError(422, "MethodRefFetchError", "Could not fetch the repository"),
      apiError(501, "MethodRefNotSupported", "Registry references are reserved"),
    ]) {
      const result = await buildMthdsInputs(
        { method_ref: "github.com/Pipelex/methods/missing@v0.1.0" },
        contextWith(error),
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
      expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    }
  });
});

describe("buildMthdsInputs on a deployment without the route", () => {
  // The by-address and by-id textures take a 404 only when it names what was
  // not found; a runner too old to serve `/v1/pipe-io` answers a bare 404,
  // which is the deployment and never the caller's selector.
  for (const selector of [
    { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
    { method_id: "mt_123" },
  ]) {
    it(`reports a bare 404 as config at PIPELEX_BASE_URL (${Object.keys(selector)[0]})`, async () => {
      const result = await buildMthdsInputs(selector, contextWith(routeMissing()));

      expect(result.structuredContent.status).toBe("error");
      const error = result.structuredContent.errors?.[0];
      expect(error?.class).toBe("config");
      expect(error?.location).toBe("PIPELEX_BASE_URL");
      expect(error?.hint).toContain("/v1/pipe-io");
      expect(result.summary).toMatch(/unreachable|misconfigured/i);
    });
  }
});

describe("buildMthdsInputs request shape", () => {
  it("rejects a request with no selector", async () => {
    const result = await buildMthdsInputs({}, contextNeverCalled());

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
  });
});

describe("buildMthdsInputs by method_id, on both platforms", () => {
  /** A context whose platform answers `extensions` to `GET /v1/version`. */
  function onPlatform(extensions: string[], requests: PipeIORequest[]): InputsContext {
    const context = contextWith(validReport, requests);
    return {
      ...context,
      client: {
        ...context.client!,
        async version() {
          return { version: "1.0.0", extensions };
        },
      },
    };
  }

  it("says a bare id read the latest published version where versions resolve", async () => {
    const requests: PipeIORequest[] = [];
    const result = await buildMthdsInputs(
      { method_id: "mt_123", pipe_ref: "demo.main" },
      onPlatform(["runs", "method_versions"], requests),
    );

    expect(requests[0]?.method_id).toBe("mt_123");
    expect(result.structuredContent.method_version).toBe("latest");
    expect(result.summary).toContain("the latest published version of `mt_123`");
  });

  it("says a bare id read the draft, and sends @draft bare, where they do not", async () => {
    const requests: PipeIORequest[] = [];
    const bare = await buildMthdsInputs(
      { method_id: "mt_123", pipe_ref: "demo.main" },
      onPlatform(["runs"], requests),
    );
    expect(bare.structuredContent.method_version).toBe("draft");

    const drafted = await buildMthdsInputs(
      { method_id: "mt_123@draft", pipe_ref: "demo.main" },
      onPlatform(["runs"], requests),
    );
    expect(requests.map((request) => request.method_id)).toEqual(["mt_123", "mt_123"]);
    expect(drafted.structuredContent.method_version).toBe("draft");
  });

  it("says it could not tell when the platform does not answer", async () => {
    const result = await buildMthdsInputs(
      { method_id: "mt_123", pipe_ref: "demo.main" },
      contextWith(validReport),
    );

    expect(result.structuredContent).not.toHaveProperty("method_version");
    expect(result.summary).toContain("could not ask the platform");
  });
});
