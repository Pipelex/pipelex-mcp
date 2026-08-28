import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, EmptyMethodSourceError } from "@pipelex/sdk";
import type {
  InputForm,
  MthdsFile,
  MthdsFileItem,
  PipeIOContracts,
  PipelexInvalidReport,
  PipelexValidationReport,
  PipelexValidationResult,
  ValidateFilesOptions,
} from "@pipelex/sdk";

import { DEFAULT_API_URL } from "./shared.js";
import type { FileResolver } from "./shared.js";
import { toolResult, validateMthds, validationResult } from "./validate.js";

/** Fake getMethodClosure arm for tests whose request must never fetch a method. */
const getMethodClosureNotCalled = {
  async getMethodClosure(): Promise<MthdsFileItem[]> {
    throw new Error("getMethodClosure must not be called in this test");
  },
};

/** Fake validateFiles arm for tests whose request must never reach the validate route. */
const validateFilesNotCalled = {
  async validateFiles(): Promise<PipelexValidationResult> {
    throw new Error("validateFiles must not be called in this test");
  },
};

// Since sdk 0.15.0 both per-pipe artifacts are the standard's own types, so the
// fixtures state real minimal shapes rather than placeholders. The two are the
// sibling pair the form needs: the contract (what the run gate validates on)
// and the descriptor (what the kernel derives the fields from).
const demoContracts: PipeIOContracts = {
  "demo.main": {
    inputs: {
      topic: {
        concept_ref: "native.Text",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: { type: "string" },
      },
    },
    output: {
      concept_ref: "native.Text",
      multiplicity: "single",
      item_count: null,
      optional: false,
    },
  },
};

const demoInputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "topic",
        kind: "prose",
        concept_ref: "native.Text",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
};

const validReport: PipelexValidationReport = {
  is_valid: true,
  bundle_blueprint: { main_pipe: "main" },
  pipe_io_contracts: demoContracts,
  input_form: demoInputForm,
  graph_spec: { nodes: [{ id: "demo.main" }] },
  validated_pipes: [],
  pending_signatures: [],
  liftable_pipes: [],
  warnings: [],
  is_runnable: true,
  message: "ok",
  rendered_markdown: "# Valid",
};

const pendingReport: PipelexValidationReport = {
  ...validReport,
  pending_signatures: ["demo.todo"],
  is_runnable: false,
};

// Appended to the API's rendered markdown whenever a view is available. Kept
// in sync with `viewsNote` in validate.ts: a runnable verdict advertises the
// graph and the input form, a pending-signature one the graph alone.
const VIEWS_NOTE =
  "\n\n## Views\n\nThe validation result includes a graph view of the method (dry run) and an input form the user can fill in to run it.";
const VIEWS_NOTE_GRAPH_ONLY =
  "\n\n## Views\n\nThe validation result includes a graph view of the method (dry run).";
const VIEWS_NOTE_FORM_ONLY =
  "\n\n## Views\n\nThe validation result includes an input form the user can fill in to run the method.";

const invalidReport: PipelexInvalidReport = {
  is_valid: false,
  is_runnable: false,
  pending_signatures: [],
  message: "invalid",
  validation_errors: [
    {
      category: "blueprint_validation",
      message: "Unknown pipe type",
      source: "bundle.mthds",
    },
  ],
  rendered_markdown: "# Invalid",
};

describe("validationResult", () => {
  it("projects runnable valid reports and carries the graph off structuredContent", () => {
    const result = validationResult(validReport, true);

    expect(result.structuredContent.status).toBe("ok");
    // The summary is the API markdown plus the appended Views note.
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE);
    // The graph rides the view-only `graphSpec` field (delivered on `_meta`),
    // never `structuredContent` — the model reads the lean verdict only.
    expect(result.graphSpec).toEqual(validReport.graph_spec);
    // ...but the model still learns the views are available via this list.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    // The IO contracts and their descriptor ride beside the graph, same
    // channel, same discipline.
    expect(result.pipeIoContracts).toEqual(validReport.pipe_io_contracts);
    expect(result.inputForm).toEqual(validReport.input_form);
    expect(result.mainPipeRef).toBe("main");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
  });

  it("omits graph when requested", () => {
    const result = validationResult(validReport, false);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.graphSpec).toBeUndefined();
    // No graph produced → no graph view advertised; the form does not depend on it.
    expect(result.structuredContent.available_view_specs).toEqual(["input_form"]);
    expect(result.pipeIoContracts).toEqual(validReport.pipe_io_contracts);
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE_FORM_ONLY);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
  });

  it("namespaces the main pipe ref with the blueprint's domain", () => {
    const report: PipelexValidationReport = {
      ...validReport,
      bundle_blueprint: { domain: "demo", main_pipe: "main" },
    };
    const result = validationResult(report, true);

    expect(result.mainPipeRef).toBe("demo.main");
  });

  it("does not advertise a form when the report carries no contracts", () => {
    const report: PipelexValidationReport = { ...validReport, pipe_io_contracts: {} };
    const result = validationResult(report, true);

    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.inputForm).toBeUndefined();
    expect(result.mainPipeRef).toBeUndefined();
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE_GRAPH_ONLY);
  });

  it("does not advertise a form when the report carries no descriptor", () => {
    // A runner that ignores the `views` token (or predates it) returns no
    // `input_form`. The kernel derives the fields from the descriptor, so
    // without it the panel would render an empty form — advertise nothing,
    // and keep the contracts off `_meta` too (their only consumer is the form).
    const report: PipelexValidationReport = { ...validReport, input_form: undefined };
    const result = validationResult(report, true);

    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.inputForm).toBeUndefined();
    expect(result.mainPipeRef).toBeUndefined();
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE_GRAPH_ONLY);
  });

  it("does not advertise or emit a graph when the invoking shell has no views", () => {
    const result = validationResult(validReport, true, false);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.graphSpec).toBeUndefined();
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.summary).toBe("# Valid");
  });

  it("projects pending signatures as valid but not runnable", () => {
    const result = validationResult(pendingReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.pending_signatures).toEqual(["demo.todo"]);
    // A pending-signature bundle is still valid and carries a graph, but it
    // cannot run, so no input form is advertised for it.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE_GRAPH_ONLY);
  });

  it("projects invalid produced verdicts as ok with validation errors", () => {
    const result = validationResult(invalidReport, true);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.validation_errors).toEqual(invalidReport.validation_errors);
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.graphSpec).toBeUndefined();
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
    expect(result.summary).toBe("# Invalid");
  });

  it("throws when rendered markdown is missing", () => {
    const report = {
      ...validReport,
      rendered_markdown: null,
    } as unknown as PipelexValidationReport;

    expect(() => validationResult(report, true)).toThrow(/did not include rendered markdown/);
  });
});

describe("toolResult", () => {
  it("delivers the graph on _meta, never on structuredContent", () => {
    const result = toolResult(validationResult(validReport, true));

    expect(result._meta.graph_spec).toEqual(validReport.graph_spec);
    expect(result._meta.pipe_io_contracts).toEqual(validReport.pipe_io_contracts);
    expect(result._meta.input_form).toEqual(validReport.input_form);
    expect(result._meta.main_pipe_ref).toBe("main");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "# Valid" + VIEWS_NOTE }]);
  });

  it("carries an undefined graph on _meta for verdicts without one", () => {
    const result = toolResult(validationResult(invalidReport, true));

    expect(result._meta.graph_spec).toBeUndefined();
    expect(result._meta.pipe_io_contracts).toBeUndefined();
    expect(result._meta.input_form).toBeUndefined();
    expect(result.isError).toBe(false);
  });
});

describe("validateMthds", () => {
  it("maps MCP input to validateFiles and projects the response", async () => {
    let capturedFiles: MthdsFile[] | undefined;
    let capturedOptions: ValidateFilesOptions | undefined;

    const result = await validateMthds(
      {
        files: [
          { content: 'domain = "demo"', uri: "bundle.mthds" },
          { content: 'main_pipe = "main"', uri: null },
        ],
        include_graph: false,
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles(files, options) {
            capturedFiles = files;
            capturedOptions = options;
            return validReport;
          },
        },
      },
    );

    expect(capturedFiles).toEqual([
      { content: 'domain = "demo"', uri: "bundle.mthds" },
      { content: 'main_pipe = "main"' },
    ]);
    // The `views` token is the descriptor opt-in — the spec keeps `input_form`
    // off the report unless the caller asks for it.
    expect(capturedOptions).toEqual({
      allowSignatures: true,
      render: ["markdown"],
      views: ["input_form"],
    });
    expect(result.structuredContent.status).toBe("ok");
    // include_graph: false drops the graph view only; the form stays.
    expect(result.structuredContent.available_view_specs).toEqual(["input_form"]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.graphSpec).toBeUndefined();
  });

  it("does not call the client when request validation fails", async () => {
    let called = false;

    const result = await validateMthds(
      {
        files: [],
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles() {
            called = true;
            return validReport;
          },
        },
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.summary).toBe("Validation was not run: request input is invalid.");
  });

  it("treats a reachable but malformed report as runtime, not unreachable", async () => {
    const malformedReport = {
      ...validReport,
      rendered_markdown: null,
    } as unknown as PipelexValidationReport;

    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles() {
            return malformedReport;
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.summary).toMatch(/malformed/i);
    expect(result.summary).not.toMatch(/unreachable/i);
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles() {
            throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toMatch(/unreachable|misconfigured/i);
  });

  it("does not claim unreachable for an auth failure", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles() {
            throw new ApiResponseError(
              "HTTP 401",
              `${DEFAULT_API_URL}/v1/validate`,
              401,
              "Unauthorized",
              "{}",
              "unauthorized",
              "Missing key",
              undefined, // validationErrors
              undefined, // code
            );
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toMatch(/misconfigured/i);
  });
});

describe("validateMthds path submissions", () => {
  const resolver: FileResolver = {
    async resolve(path) {
      if (path === "methods/bundle.mthds") {
        return { ok: true, content: 'domain = "demo"' };
      }
      return { ok: false, message: `File not found: ${path}`, hint: "Check the path." };
    },
  };

  it("resolves { path } items through the context resolver, with the path as uri", async () => {
    let capturedFiles: MthdsFile[] | undefined;

    const result = await validateMthds(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles(files) {
            capturedFiles = files;
            return validReport;
          },
        },
      },
    );

    expect(capturedFiles).toEqual([{ content: 'domain = "demo"', uri: "methods/bundle.mthds" }]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    let called = false;

    const result = await validateMthds(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles() {
            called = true;
            return validReport;
          },
        },
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("npx @pipelex/mcp");
    expect(result.summary).toBe("Validation was not run: request input is invalid.");
  });

  it("surfaces the hosted rejection message and hint into the content stream", async () => {
    // The desktop-host scenario: a { path } submission to the hosted console.
    // The instructive detail must reach the agent-facing `content`, not sit
    // only in structuredContent.errors where the agent had to guess from it.
    const result = await validateMthds(
      { files: [{ path: "methods/bundle.mthds" }] },
      { baseUrl: DEFAULT_API_URL },
    );

    const { content } = toolResult(result);
    const text = content[0]?.text ?? "";

    expect(text).toContain("Validation was not run: request input is invalid.");
    expect(text).toContain("`files[0].path`");
    expect(text).toContain("This deployment cannot read files from disk");
    expect(text).toContain("npx @pipelex/mcp");
  });

  it("does not call the client when resolution fails", async () => {
    let called = false;

    const result = await validateMthds(
      { files: [{ path: "missing.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles() {
            called = true;
            return validReport;
          },
        },
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
    expect(result.structuredContent.errors?.[0]?.message).toBe("File not found: missing.mthds");
  });
});

describe("validateMthds by method_id", () => {
  it("forwards a resolved single-file closure as one file labeled with the id", async () => {
    let capturedFiles: MthdsFile[] | undefined;
    let fetchedId: string | undefined;

    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async getMethodClosure(methodId) {
            fetchedId = methodId;
            return [{ content: 'domain = "demo"\nmain_pipe = "main"', source: "mt_123" }];
          },
          async validateFiles(files) {
            capturedFiles = files;
            return validReport;
          },
        },
      },
    );

    expect(fetchedId).toBe("mt_123");
    // The resolved closure is forwarded as validateFiles' input, each labeled
    // with the method id as `uri` provenance.
    expect(capturedFiles).toEqual([
      { content: 'domain = "demo"\nmain_pipe = "main"', uri: "mt_123" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
    // The views work the same whether the content came from files or a by-id
    // fetch — the fetch leg only supplies files upstream.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    expect(result.graphSpec).toEqual(validReport.graph_spec);
  });

  it("forwards each file of a multi-file closure", async () => {
    let capturedFiles: MthdsFile[] | undefined;

    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async getMethodClosure() {
            return [
              { content: 'domain = "demo"', source: "mt_123" },
              { content: 'main_pipe = "main"', source: "mt_123" },
            ];
          },
          async validateFiles(files) {
            capturedFiles = files;
            return validReport;
          },
        },
      },
    );

    expect(capturedFiles).toEqual([
      { content: 'domain = "demo"', uri: "mt_123" },
      { content: 'main_pipe = "main"', uri: "mt_123" },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("surfaces an unknown method id (404) at method_id without calling the validate route", async () => {
    const result = await validateMthds(
      { method_id: "mt_missing" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async getMethodClosure(): Promise<MthdsFileItem[]> {
            throw new ApiResponseError(
              "HTTP 404",
              `${DEFAULT_API_URL}/v1/methods/mt_missing`,
              404,
              "Not Found",
              "{}",
              "not_found",
              "Method not found",
              undefined, // validationErrors
              "not_found", // code
            );
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
  });

  it("reports a no-source method (EmptyMethodSourceError) at method_id without calling the validate route", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
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

  it("lets files win over method_id without fetching the method", async () => {
    let capturedFiles: MthdsFile[] | undefined;

    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...getMethodClosureNotCalled,
          async validateFiles(files) {
            capturedFiles = files;
            return validReport;
          },
        },
      },
    );

    expect(capturedFiles).toEqual([{ content: 'domain = "demo"' }]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("classifies a paywall (402) on the fetch leg as config", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async getMethodClosure(): Promise<MthdsFileItem[]> {
            throw new ApiResponseError(
              "HTTP 402",
              `${DEFAULT_API_URL}/v1/methods/mt_123`,
              402,
              "Payment Required",
              "{}",
              "forbidden",
              "Subscription required",
              undefined, // validationErrors
              "forbidden", // code
            );
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/plan|billing/i);
    // A headline-only host shows just this line, so it must name the plan
    // rather than the connectivity headline every other `config` error gets.
    expect(result.summary).toBe(
      "Validation could not start: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("classifies a malformed base URL on the fetch leg as config", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      { baseUrl: `${DEFAULT_API_URL}/v1` },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });

  it("rejects a request with neither files nor method_id", async () => {
    const result = await validateMthds(
      {},
      {
        baseUrl: DEFAULT_API_URL,
        client: { ...validateFilesNotCalled, ...getMethodClosureNotCalled },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
  });
});
