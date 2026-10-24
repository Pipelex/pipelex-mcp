import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, RequestArgumentError } from "@pipelex/sdk";
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
import { comparableRequest, contentsOf, fakeMethodResolver } from "./method-tree-fixtures.js";
import { DEFAULT_API_URL, problemOf, SECRET_REASON } from "./shared.js";
import type { MethodTreeToSend } from "./shared.js";

/** A tree in hand, for the request checks, which only ask whether one is there. */
const A_TREE: MethodTreeToSend = {
  source: { files: [], digest: "", readFile: () => Promise.reject(new Error("never read")) },
  files: [],
  fromFolder: false,
};

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
  errors: [
    {
      code: "method.pipe_type_invalid",
      detail: "Unknown pipe type",
      location: { file: "bundle.mthds" },
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

/** An answer with no problem body, which the SDK reads by its status. */
function bareAnswer(status: number, body: string): ApiResponseError {
  return new ApiResponseError(`HTTP ${status}`, `${DEFAULT_API_URL}/v1/pipe-io`, status, "", body);
}

/** A runner's answer for a route it does not serve: Starlette's bare `{"detail":"Not Found"}`. */
const routeMissing = () => bareAnswer(404, '{"detail":"Not Found"}');

/** The base-URL note of a context that carries none. */
const BASE_URL_NOTE =
  "The Pipelex API in use is the one PIPELEX_BASE_URL names, else the hosted Pipelex API.";

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

  it("projects invalid produced verdicts as ok with their problem items", () => {
    const result = inputsResult(invalidReport, EXPLICIT_JSON);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.errors).toEqual(invalidReport.errors);
    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("Inputs template not produced");
    expect(result.summary).toContain("The closure did not validate.");
    expect(result.summary).toContain("Unknown pipe type");
    expect(result.summary).toContain("bundle.mthds");
    expect(result.summary).toContain("method.pipe_type_invalid");
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
      structuredContent: { status: "error", is_valid: false, problem: problemOf(new Error("x")) },
      summary: "failed",
    });

    expect(result.isError).toBe(true);
  });
});

describe("validateInputsRequest", () => {
  it("inherits the shared selector checks", () => {
    const faults = validateInputsRequest({});

    expect(faults.map((fault) => fault.location?.field)).toEqual(["files"]);
  });

  it("rejects a blank pipe_ref", () => {
    const faults = validateInputsRequest({ tree: A_TREE, pipe_ref: "  " });

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "pipe_ref", reason: "empty" },
      location: { field: "pipe_ref" },
    });
    expect(faults[0]?.message).toContain("pipe_ref must not be empty when supplied.");
  });

  it("accepts a qualified pipe_ref", () => {
    const faults = validateInputsRequest({ tree: A_TREE, pipe_ref: "demo.main" });

    expect(faults).toEqual([]);
  });

  it("accepts a method_id with no tree", () => {
    const faults = validateInputsRequest({ method_id: "mt_123" });

    expect(faults).toEqual([]);
  });

  it("rejects a blank method_id", () => {
    const faults = validateInputsRequest({ method_id: "  " });

    expect(faults.map((fault) => fault.location?.field)).toContain("method_id");
  });
});

describe("buildMthdsInputs by files", () => {
  it("posts the files to pipe-io as one tree, and projects the template", async () => {
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

    // One call, with the files as a tree: the first under its uri's name, the
    // second under the next free one. No pipe_ref, so the route's selection
    // chain decides, and nothing template-shaped travels: the projection is
    // client-side.
    expect(requests).toHaveLength(1);
    expect(await comparableRequest(requests[0])).toEqual({
      tree: { "bundle.mthds": 'domain = "demo"', "bundle-2.mthds": 'main_pipe = "main"' },
    });
    expect(result.structuredContent.files_sent).toEqual(["bundle-2.mthds", "bundle.mthds"]);
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

    expect(await comparableRequest(requests[0])).toEqual({
      tree: { "bundle.mthds": 'domain = "demo"' },
      pipe_ref: "demo.main",
    });
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
    expect(result.structuredContent.errors).toEqual(invalidReport.errors);
  });

  it("does not call the client when request validation fails", async () => {
    const result = await buildMthdsInputs({ files: [] }, contextNeverCalled());

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files", reason: "missing" },
      location: { field: "files" },
    });
    // The summary is the problem rendered: its title, the workshop's sentence and the code.
    expect(result.summary).toContain("## An argument was refused before sending");
    expect(result.summary).toContain("Provide a method folder");
    expect(result.summary).toContain("`client.argument_invalid`");
  });

  it("relays a request-shape 422 as the runner's problem, unchanged", async () => {
    const err = refusal(422, {
      code: "request.invalid",
      title: "The request was refused",
      detail: "Too many files.",
      domain: "input",
      location: { field: "tree" },
    });

    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(err),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "request.invalid",
      domain: "input",
      retry: "no",
      location: { field: "tree" },
      request_id: "req_422",
    });
    expect(result.summary).toContain("Too many files.");
    expect(result.summary).toContain("req_422");
  });

  it("relays an unreachable API as the SDK's client.unreachable, with the base URL note", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED")),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.unreachable",
      retry: "yes",
      params: { base_url: DEFAULT_API_URL },
    });
    expect(result.summary).toContain(BASE_URL_NOTE);
  });

  it("relays a missing-route 404 as the SDK's request.not_found, with the base URL note", async () => {
    const err = routeMissing();

    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(err),
    );

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem?.code).toBe("request.not_found");
    expect(result.summary).toContain(BASE_URL_NOTE);
  });

  it("reports a malformed base URL as client.not_configured instead of rejecting the handler", async () => {
    // No injected client: the real SDK constructor must run — it throws
    // PipelineRequestError on a path-carrying base URL, and that throw has to
    // land in the caught path.
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      { baseUrl: `${DEFAULT_API_URL}/v1` },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.not_configured",
      params: { setting: "base_url" },
    });
    expect(result.summary).toContain(BASE_URL_NOTE);
  });

  it("treats a reachable but malformed answer as an unreadable answer, not unreachable", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith(reportWith({ "demo.main": { fields: "nope" } } as unknown as InputForm)),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      retry: "no",
      params: { status: 200 },
    });
    expect(result.structuredContent.problem?.message).toContain("The API answered");
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

    it(`relays an unknown pipe_ref as the route's own problem at pipe_ref (${shape})`, async () => {
      const err = refusal(422, {
        code: "request.pipe_not_found",
        title: "The selected pipe is not in the method",
        detail: "No pipe 'demo.missing' in the closure.",
        domain: "input",
        location: { field: "pipe_ref" },
      });

      const result = await buildMthdsInputs(
        { ...selector, pipe_ref: "demo.missing" },
        contextWith(err),
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem).toMatchObject({
        code: "request.pipe_not_found",
        domain: "input",
        retry: "no",
        location: { field: "pipe_ref" },
        detail: "No pipe 'demo.missing' in the closure.",
      });
    });

    it(`relays several entry pipes as the route's own problem at pipe_ref (${shape})`, async () => {
      const err = refusal(422, {
        code: "request.pipe_ambiguous",
        title: "The pipe selection matches several pipes",
        detail: "Several domains declare a main_pipe: a, b.",
        domain: "input",
        location: { field: "pipe_ref" },
      });

      const result = await buildMthdsInputs(selector, contextWith(err));

      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem?.location?.field).toBe("pipe_ref");
      expect(result.summary).toContain("Several domains");
    });
  }
});

describe("buildMthdsInputs path submissions", () => {
  it("reads { path } items through the context resolver and sends them as one tree", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      { files: [{ path: "methods/invoice.mthds" }, { path: "methods/templates/invoice.xlsx" }] },
      {
        ...contextWith(validReport, requests),
        resolver: fakeMethodResolver({
          files: {
            "methods/invoice.mthds": 'domain = "invoice"',
            "methods/templates/invoice.xlsx": XLSX,
          },
        }),
      },
    );

    // Each file under its path from the deepest directory holding them all,
    // which is where the step's template_file leads.
    expect(requests[0]?.tree?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "templates/invoice.xlsx",
    ]);
    expect(await requests[0]?.tree?.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      files_sent: ["methods/invoice.mthds", "methods/templates/invoice.xlsx"],
    });
  });

  it("reads a method folder through the resolver and lists every file it sent", async () => {
    const requests: PipeIORequest[] = [];

    const result = await buildMthdsInputs(
      { method_dir: "methods" },
      { ...contextWith(validReport, requests), resolver: methodFolderResolver() },
    );

    expect(await contentsOf(requests[0]?.tree)).toEqual({
      "invoice.mthds": 'domain = "invoice"',
      "templates/invoice.xlsx": "PK",
    });
    expect(result.structuredContent.files_sent).toEqual([
      "methods/invoice.mthds",
      "methods/templates/invoice.xlsx",
    ]);
    expect(inputsToolResult(result).content[0].text).toContain("- `methods/invoice.mthds`");
  });

  it("refuses a folder holding a key before anything is sent", async () => {
    const fakeKey = ["plx_sk_", "f".repeat(32)].join("");

    const result = await buildMthdsInputs(
      { method_dir: "methods" },
      {
        ...contextNeverCalled(),
        resolver: fakeMethodResolver({
          folder: {
            "invoice.mthds": 'domain = "invoice"',
            "funcs/client.py": `KEY = "${fakeKey}"`,
          },
        }),
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
    // The client refuses the base URL as it is built.
    const unbuilt = await buildMthdsInputs(
      { method_dir: "methods" },
      { baseUrl: "invalid-no-scheme", resolver: methodFolderResolver() },
    );
    expect(unbuilt.structuredContent.status).toBe("error");
    expect(unbuilt.structuredContent.problem?.code).toBe("client.not_configured");
    expect(unbuilt.structuredContent).not.toHaveProperty("files_sent");
    expect(inputsToolResult(unbuilt).content[0].text).not.toContain("Files sent");

    // The SDK refuses an argument before sending.
    const refused = await buildMthdsInputs({ method_dir: "methods" }, {
      baseUrl: DEFAULT_API_URL,
      resolver: methodFolderResolver(),
      client: { pipeIo: () => Promise.reject(new RequestArgumentError("refused before sending")) },
    } as InputsContext);
    expect(refused.structuredContent.status).toBe("error");
    expect(refused.structuredContent.problem?.code).toBe("client.argument_invalid");
    expect(refused.structuredContent).not.toHaveProperty("files_sent");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await buildMthdsInputs(
      { files: [{ path: "methods/bundle.mthds" }] },
      contextNeverCalled(),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files[0].path", reason: "not_readable_here" },
      location: { field: "files[0].path" },
    });
    expect(result.summary).toContain("This deployment cannot read files from disk");
    expect(result.summary).toContain("npx @pipelex/mcp");
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

  it("relays an unknown method id (404) as the platform's problem, unchanged", async () => {
    const err = refusal(404, {
      code: "pipelex.catalog.not_found",
      title: "Method not found",
      detail: "No method mt_missing belongs to this organization.",
      domain: "input",
      location: { field: "method_id" },
    });

    const result = await buildMthdsInputs({ method_id: "mt_missing" }, contextWith(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.catalog.not_found",
      domain: "input",
      retry: "no",
      location: { field: "method_id" },
    });
  });

  it("relays a stored method with no source (422) as the platform's problem, unchanged", async () => {
    const err = refusal(422, {
      code: "request.invalid",
      title: "The request was refused",
      detail: "The stored method has no MTHDS source.",
      domain: "input",
      location: { field: "method_id" },
    });

    const result = await buildMthdsInputs({ method_id: "mt_123" }, contextWith(err));

    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem?.location?.field).toBe("method_id");
    expect(result.summary).toContain("The stored method has no MTHDS source.");
  });

  it("rejects files beside method_id without calling the client", async () => {
    const result = await buildMthdsInputs(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_123" },
      contextNeverCalled(),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
  });

  it("relays a paywall (402) as the platform's plan problem, unchanged", async () => {
    const err = refusal(402, {
      code: "pipelex.billing.plan_limit",
      title: "The organization's plan does not cover this call",
      detail: "Reading a saved method's inputs needs a plan that includes the catalog.",
      domain: "account",
      next_step: {
        kind: "contact_owner",
        detail: "Ask the organization's owner to change its plan.",
      },
    });

    const result = await buildMthdsInputs({ method_id: "mt_123" }, contextWith(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({ domain: "account", retry: "no" });
    // The plan, never the network.
    expect(result.summary).toContain("## The organization's plan does not cover this call");
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("relays a refused key (401) as the key, with the key note, not as connectivity", async () => {
    const result = await buildMthdsInputs(
      { method_id: "mt_123" },
      {
        ...contextWith(bareAnswer(401, "{}")),
        apiNotes: { apiKey: "The API key came from the host's PIPELEX_API_KEY." },
      },
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
    });
    expect(result.summary).toContain("The API key came from the host's PIPELEX_API_KEY.");
    expect(result.summary).not.toMatch(/unreachable/);
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
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "method_ref", reason: "mutually_exclusive" },
      location: { field: "method_ref" },
    });
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
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
  });

  it("relays a no-matching-package 404, a fetch 422 and the registry form's refusal as the runner's problems, unchanged", async () => {
    for (const err of [
      refusal(404, {
        code: "method.not_found",
        title: "The method was not found",
        detail: "No MTHDS package found.",
        domain: "input",
      }),
      refusal(422, {
        code: "method.fetch_failed",
        title: "The method could not be fetched",
        detail: "Could not fetch the repository.",
        domain: "input",
      }),
      refusal(422, {
        code: "request.unsupported",
        title: "The request asks for something this runtime does not support",
        detail: "A registry-form method_ref is reserved; no registry here resolves it.",
        domain: "input",
        params: { reason: "registry_form_method_ref" },
        location: { field: "method_ref" },
      }),
    ]) {
      const result = await buildMthdsInputs(
        { method_ref: "github.com/Pipelex/methods/missing@v0.1.0" },
        contextWith(err),
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem).toMatchObject({ domain: "input", retry: "no" });
    }
  });
});

describe("buildMthdsInputs on a deployment without the route", () => {
  // A runner too old to serve `/v1/pipe-io` answers a bare 404, which the SDK
  // reads as the deployment's missing route and never as the caller's
  // selector, whatever named the method.
  for (const selector of [
    { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
    { method_id: "mt_123" },
  ]) {
    it(`relays a bare 404 as request.not_found, with the base URL note (${Object.keys(selector)[0]})`, async () => {
      const err = routeMissing();

      const result = await buildMthdsInputs(selector, contextWith(err));

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem?.code).toBe("request.not_found");
      expect(result.structuredContent.problem?.location).toBeUndefined();
      expect(result.summary).toContain(BASE_URL_NOTE);
    });
  }
});

describe("buildMthdsInputs request shape", () => {
  it("rejects a request with no selector", async () => {
    const result = await buildMthdsInputs({}, contextNeverCalled());

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "files", reason: "missing" },
      location: { field: "files" },
    });
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

  it("says a bare id read the draft where they do not, and sends @draft as given", async () => {
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
    expect(requests.map((request) => request.method_id)).toEqual(["mt_123", "mt_123@draft"]);
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

/** A resolver reading every method folder as a bundle and one template file. */
function methodFolderResolver() {
  return fakeMethodResolver({
    folder: { "invoice.mthds": 'domain = "invoice"', "templates/invoice.xlsx": "PK" },
  });
}
