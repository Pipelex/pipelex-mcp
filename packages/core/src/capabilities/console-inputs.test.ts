import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  CrateInvalidReport,
  InputForm,
  MthdsFileItem,
  PipeIORequest,
  PipeIOResponse,
  PipeIOValidReport,
} from "@pipelex/sdk";

import { prepareConsoleInputs } from "./console-inputs.js";
import type { ConsoleInputsClient, ConsoleInputsSelector } from "./console-inputs.js";
import { DEFAULT_API_URL } from "./shared.js";

/**
 * The input-form descriptor for a pipe with a file-bearing input (`photo`, an
 * image) and a text input (`question`).
 *
 * **The descriptor is the classifier, never the value's shape** — which is the
 * whole reason the walk moved onto it. A `text` node merely NAMED `url`
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

/**
 * A single-pipe pipe I/O answer: the route selected `demo.main` (or whatever
 * `overrides.pipe_ref` says) and keyed the maps by it. `undefined` for the
 * descriptor drops the key, which a well-formed answer never does.
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

const invalidReport: CrateInvalidReport = {
  is_valid: false,
  message: "The closure did not validate.",
  validation_errors: [
    { category: "blueprint_validation", message: "Unknown pipe type", source: "bundle.mthds" },
  ],
};

/** The walk's fake: `pipeIo` answers a report and records what it was asked. */
function pipeIoWith(
  report: PipeIOResponse,
  capture?: (request: PipeIORequest) => void,
): ConsoleInputsClient {
  return {
    async pipeIo(request: PipeIORequest): Promise<PipeIOResponse> {
      capture?.(request);
      return report;
    },
  };
}

const files = [{ content: 'domain = "demo"' }];
const PUBLISHED_REF = "github.com/Pipelex/methods/documents@v0.1.0";

interface WalkRequest {
  files?: Array<{ content: string; uri?: string }>;
  method_ref?: string;
  method_id?: string;
  pipe_ref?: string;
  inputs: Record<string, unknown>;
}

/**
 * Run the walk the way `pipelex_run` does, over whichever selector the request
 * names, and flatten its outcome for the assertions. The second argument keeps
 * the shape of a capability context so each test reads as a request and the
 * client it meets; only the client is used.
 */
async function walk(
  request: WalkRequest,
  context: { baseUrl?: string; client: ConsoleInputsClient },
) {
  const selector: ConsoleInputsSelector =
    request.method_ref !== undefined
      ? { method_ref: request.method_ref }
      : request.method_id !== undefined
        ? { method_id: request.method_id }
        : {
            files: (request.files ?? (files as WalkRequest["files"]) ?? []).map((file) =>
              file.uri === undefined
                ? { content: file.content }
                : { content: file.content, source: file.uri },
            ),
          };
  const outcome = await prepareConsoleInputs(context.client, {
    selector,
    ...(request.pipe_ref === undefined ? {} : { pipe_ref: request.pipe_ref }),
    inputs: request.inputs,
  });
  return outcome.ok
    ? { status: "ok" as const, inputs: outcome.inputs, error: undefined }
    : { status: "error" as const, inputs: undefined, error: outcome.error };
}

describe("prepareConsoleInputs — the pass-through walk", () => {
  it("reads the signature from one pipe I/O call and uploads nothing", async () => {
    const requests: PipeIORequest[] = [];

    const result = await walk(
      { files, inputs: { photo: "https://cdn.example.com/a.png", question: "hi" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith(demoInputForm), (request) => requests.push(request)),
      },
    );

    // The console resolves the signature itself, from the descriptor — never
    // from the rendered inputs template, and never by uploading. With no
    // pipe named, the route picks the entry pipe, so none is sent.
    expect(requests).toEqual([{ files: [{ content: 'domain = "demo"' }] }]);
    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
      question: "hi",
    });
  });

  it("forwards a method_ref address as the selector", async () => {
    const requests: PipeIORequest[] = [];

    const result = await walk(
      {
        method_ref: PUBLISHED_REF,
        inputs: { photo: "https://cdn.example.com/a.png" },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith(demoInputForm), (request) => requests.push(request)),
      },
    );

    expect(requests).toEqual([{ method_ref: "github.com/Pipelex/methods/documents@v0.1.0" }]);
    expect(result.status).toBe("ok");
  });

  it("forwards a method_id as the selector, and a named pipe beside it", async () => {
    const requests: PipeIORequest[] = [];

    const result = await walk(
      {
        method_id: "mt_123",
        pipe_ref: " demo.main ",
        inputs: { photo: "https://cdn.example.com/a.png" },
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith(demoInputForm), (request) => requests.push(request)),
      },
    );

    // Trimmed, and never with `all_pipes`: the walk needs one pipe's signature.
    expect(requests).toEqual([{ method_id: "mt_123", pipe_ref: "demo.main" }]);
    expect(result.status).toBe("ok");
  });

  it("forwards inline files as given, their names included", async () => {
    const requests: PipeIORequest[] = [];

    await walk(
      {
        files: [{ content: 'domain = "demo"', uri: "a.mthds" }, { content: "# more" }],
        inputs: {},
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith(demoInputForm), (request) => requests.push(request)),
      },
    );

    // The route takes the `files[]` envelope itself, so there is no parallel
    // `mthds_sources` array to keep the same length.
    expect(requests).toEqual([
      { files: [{ content: 'domain = "demo"', source: "a.mthds" }, { content: "# more" }] },
    ]);
  });

  it("accepts the filled explicit {concept, content} envelope and re-wraps it", async () => {
    const result = await walk(
      {
        files,
        inputs: {
          photo: { concept: "native.Image", content: { url: "https://cdn.example.com/a.png" } },
          question: { concept: "native.Text", content: "hi" },
        },
      },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    // The envelope survives: `concept` rides through, only the inner content is rewritten.
    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      photo: { concept: "native.Image", content: { url: "https://cdn.example.com/a.png" } },
      question: { concept: "native.Text", content: "hi" },
    });
  });

  it("still refuses an upload-needing value nested inside an envelope", async () => {
    const result = await walk(
      { files, inputs: { photo: { concept: "native.Image", content: "./local/a.png" } } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      class: "input_domain",
      location: "inputs",
    });
  });

  it("does not misread a structured concept that merely has concept+content fields", async () => {
    // Exactly-two-keys is the envelope rule; a third key means it is ordinary structured content.
    const result = await walk(
      { files, inputs: { question: { concept: "x", content: "y", extra: 1 } } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      question: { concept: "x", content: "y", extra: 1 },
    });
  });

  it("leaves a text field merely NAMED url untouched", async () => {
    // One of the two misclassifications the descriptor fixes: the old
    // template-guided walk read a `url`-bearing dict as the file signal, so a
    // text input called `url` was rewritten to canonical file content — and on
    // this arm, a plain sentence in it was refused as "a local file path".
    const result = await walk(
      { files, inputs: { url: "not a link, just prose" } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(urlNamedTextInputForm)) },
    );

    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({ url: "not a link, just prose" });
  });

  it("walks an OPTIONAL file field nested inside a structure", async () => {
    // The other misclassification: an optional nested file field prepares
    // exactly like a required one, because the descriptor states the kind at
    // every depth and `required` is a layout fact, not a preparation one.
    const result = await walk(
      {
        files,
        inputs: { dossier: { title: "Case 7", scan: "https://cdn.example.com/scan.pdf" } },
      },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(nestedOptionalInputForm)) },
    );

    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      dossier: { title: "Case 7", scan: { url: "https://cdn.example.com/scan.pdf" } },
    });
  });

  it("refuses an upload-needing value at an optional nested file field", async () => {
    const result = await walk(
      { files, inputs: { dossier: { title: "Case 7", scan: "./local/scan.pdf" } } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(nestedOptionalInputForm)) },
    );

    expect(result.status).toBe("error");
    expect(result.error?.location).toBe("inputs");
  });

  it("walks every element of a declared-multiple file input inside an envelope", async () => {
    const result = await walk(
      {
        files,
        inputs: {
          exhibits: {
            concept: "demo.Exhibit",
            content: ["https://cdn.example.com/a.pdf", "pipelex-storage://kept"],
          },
        },
      },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(multipleInputForm)) },
    );

    // Every element is rewritten to canonical {url} content; the envelope survives.
    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      exhibits: {
        concept: "demo.Exhibit",
        content: [{ url: "https://cdn.example.com/a.pdf" }, { url: "pipelex-storage://kept" }],
      },
    });
  });

  it("walks every element of a declared-multiple file input filled compactly", async () => {
    const result = await walk(
      { files, inputs: { exhibits: ["https://cdn.example.com/a.pdf"] } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(multipleInputForm)) },
    );

    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      exhibits: [{ url: "https://cdn.example.com/a.pdf" }],
    });
  });

  it("refuses an upload-needing element nested in a declared-multiple list", async () => {
    const result = await walk(
      {
        files,
        inputs: {
          exhibits: {
            concept: "demo.Exhibit",
            content: ["https://cdn.example.com/a.pdf", "./local/b.pdf"],
          },
        },
      },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(multipleInputForm)) },
    );

    expect(result.status).toBe("error");
    expect(result.error).toMatchObject({
      class: "input_domain",
      location: "inputs",
    });
  });

  it("passes an existing pipelex-storage:// reference through", async () => {
    const result = await walk(
      { files, inputs: { photo: "pipelex-storage://existing" } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      photo: { url: "pipelex-storage://existing" },
    });
  });

  it("refuses a data: URL up front with an instructive input_domain at inputs", async () => {
    const result = await walk(
      { files, inputs: { photo: "data:image/png;base64,AAAA" } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.status).toBe("error");
    expect(result.error?.class).toBe("input_domain");
    expect(result.error?.location).toBe("inputs");
    expect(result.error?.hint).toContain("pipelex_upload_attachments");
  });

  it("refuses a bare local path up front", async () => {
    const result = await walk(
      { files, inputs: { photo: "/tmp/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.status).toBe("error");
    expect(result.error?.location).toBe("inputs");
    expect(result.error?.message).toContain("local file path");
  });

  it("surfaces an invalid closure as a no-verdict input_domain at the SELECTOR (no produced-invalid arm)", async () => {
    const result = await walk(
      { files, inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(invalidReport) },
    );

    expect(result.status).toBe("error");
    expect(result.error?.class).toBe("input_domain");
    // Not `pipe_ref`: the closure is broken, which is a question about whatever
    // named the method and never about a field the caller left empty.
    expect(result.error?.location).toBe("files");
    expect(result.error?.hint).toContain("pipelex_show_method");
  });

  it("locates an invalid closure at method_ref when an address named the method", async () => {
    const result = await walk(
      { files: [], method_ref: PUBLISHED_REF, inputs: {} },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(invalidReport) },
    );

    expect(result.error?.location).toBe("method_ref");
    // The hint must not send them to a `pipe_ref` they never typed.
    expect(result.error?.hint).not.toContain("pipe_ref");
  });

  it("refuses a report with no input_form as a deployment fault, not the caller's", async () => {
    // Without the descriptor every value would pass through unchecked, which on
    // this arm means an upload refusal that never fires — the failure mode the
    // whole boundary exists to prevent.
    const result = await walk(
      { files, inputs: { photo: "/tmp/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(undefined)) },
    );

    expect(result.status).toBe("error");
    // `config`, because no request the caller can write works around it. It used
    // to be `input_domain`@`pipe_ref`, under a hint that contradicted the
    // message beside it.
    expect(result.error?.class).toBe("config");
    expect(result.error?.location).toBe("PIPELEX_BASE_URL");
    expect(result.error?.message).toContain("input_form");
  });

  it("refuses a wire input_form of null the same way, rather than dying on Object.keys", async () => {
    // The report is extension-open transport nothing validates at runtime, so a
    // `null` really can arrive where the type says the slot is absent. Tested
    // for the CLASS: as a raw TypeError this surfaced as a retryable `runtime`
    // fault, which is the one reading the refusal exists to prevent.
    const result = await walk(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(
          reportWith(undefined, {
            input_form: null,
          } as unknown as Partial<PipeIOValidReport>),
        ),
      },
    );

    expect(result.error?.class).toBe("config");
    expect(result.error?.retryable).toBe(false);
  });

  it("refuses a descriptor entry whose field list is unreadable", async () => {
    const result = await walk(
      { files, inputs: { photo: "/tmp/a.png" } },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith({ "demo.main": { fields: "nope" } } as unknown as InputForm)),
      },
    );

    expect(result.error?.class).toBe("config");
    expect(result.error?.message).toContain("field list");
  });

  it("passes a malformed NESTED node through instead of throwing out of the walk", async () => {
    // The walk's own contract: a malformed node falls to the pass-through arm.
    // A stated `item: null` used to pass the `!== undefined` test and then have
    // `.kind` read off it, and a null element of `fields` had `.name` read off
    // it — both surfaced as a generic `runtime` fault.
    const malformed = {
      "demo.main": {
        fields: [
          { name: "gallery", kind: "list", item: null },
          { name: "meta", kind: "object", fields: [null] },
        ],
      },
    } as unknown as InputForm;

    const result = await walk(
      {
        files,
        inputs: { gallery: ["https://cdn.example.com/a.png"], meta: { title: "t" } },
      },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(malformed)) },
    );

    expect(result.status).toBe("ok");
    expect(result.inputs).toEqual({
      gallery: ["https://cdn.example.com/a.png"],
      meta: { title: "t" },
    });
  });

  it("names an unusable value for what it is instead of calling it inline bytes", async () => {
    const result = await walk(
      { files, inputs: { photo: 42 } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.error?.location).toBe("inputs");
    expect(result.error?.message).toContain("a number");
    expect(result.error?.message).not.toContain("inline bytes");
  });

  it("still calls real inline bytes inline bytes", async () => {
    const result = await walk(
      { files, inputs: { photo: new Uint8Array([1, 2, 3]) } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(reportWith(demoInputForm)) },
    );

    expect(result.error?.message).toContain("inline bytes");
  });
});

describe("prepareConsoleInputs — pipe selection (SDK parity)", () => {
  /** The route's typed refusal of a selection, as the SDK surfaces it. */
  function selectionRefusal(errorType: string, detail: string): ApiResponseError {
    return new ApiResponseError(
      "HTTP 422",
      `${DEFAULT_API_URL}/v1/pipe-io`,
      422,
      "Unprocessable Entity",
      "{}",
      errorType,
      detail,
      undefined,
      undefined,
    );
  }

  function refusingWith(error: unknown): ConsoleInputsClient {
    return {
      async pipeIo(): Promise<PipeIOResponse> {
        throw error;
      },
    };
  }

  it("refuses a bare pipe_ref before any call", async () => {
    const requests: PipeIORequest[] = [];
    const result = await walk(
      { files, pipe_ref: "main", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith(demoInputForm), (request) => requests.push(request)),
      },
    );

    expect(result.error?.location).toBe("pipe_ref");
    expect(result.error?.message).toContain("qualified");
    expect(requests).toEqual([]);
  });

  it("refuses a dependency package's pipe before any call", async () => {
    const requests: PipeIORequest[] = [];
    const result = await walk(
      { files, pipe_ref: "lib->demo.main", inputs: {} },
      {
        baseUrl: DEFAULT_API_URL,
        client: pipeIoWith(reportWith(demoInputForm), (request) => requests.push(request)),
      },
    );

    expect(result.error?.location).toBe("pipe_ref");
    expect(result.error?.message).toContain("dependency package");
    expect(requests).toEqual([]);
  });

  it("locates the route's refusal of an unknown pipe_ref at pipe_ref, with its detail", async () => {
    const result = await walk(
      { files, pipe_ref: "demo.nope", inputs: {} },
      {
        client: refusingWith(
          selectionRefusal("EntryPipeNotFoundError", "Pipe 'demo.nope' not found in the closure."),
        ),
      },
    );

    expect(result.error?.class).toBe("input_domain");
    expect(result.error?.location).toBe("pipe_ref");
    expect(result.error?.message).toContain("Pipe 'demo.nope' not found");
    expect(result.error?.retryable).toBe(false);
    // The route's detail names no candidates, so the hint says where they are.
    expect(result.error?.hint).toContain("pipelex_show_method");
  });

  it("locates the route's refusal of a method with several entry pipes at pipe_ref", async () => {
    const result = await walk(
      { method_id: "mt_1", inputs: {} },
      {
        client: refusingWith(
          selectionRefusal("EntryPipeAmbiguousError", "Several domains declare a main_pipe."),
        ),
      },
    );

    // A question about the pipe, not about the method the id names.
    expect(result.error?.location).toBe("pipe_ref");
    expect(result.error?.message).toContain("Several domains");
  });

  it("walks the pipe the route selected", async () => {
    const report = reportWith(
      { "demo.other": demoInputForm["demo.main"] },
      { pipe_ref: "demo.other", default_pipe_ref: "demo.other" },
    );

    const result = await walk(
      { files, inputs: { photo: "https://cdn.example.com/a.png" } },
      { baseUrl: DEFAULT_API_URL, client: pipeIoWith(report) },
    );

    expect(result.inputs).toEqual({
      photo: { url: "https://cdn.example.com/a.png" },
    });
  });

  it("refuses an answer whose descriptor does not describe the pipe it selected", async () => {
    // One answer, one pipe, keyed both ways — a miss is the answer
    // contradicting itself, and walking another pipe would prepare a signature
    // the run does not take.
    for (const report of [
      reportWith(demoInputForm, { pipe_ref: "demo.absent" }),
      reportWith(demoInputForm, { pipe_ref: null }),
    ]) {
      const result = await walk(
        { files, inputs: {} },
        { baseUrl: DEFAULT_API_URL, client: pipeIoWith(report) },
      );

      expect(result.status).toBe("error");
      expect(result.error?.location).toBe("pipe_ref");
      expect(result.error?.message).toContain("does not describe it");
      expect(result.error?.message).toContain("demo.main");
    }
  });
});

describe("prepareConsoleInputs — selector-shaped classification", () => {
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

  function failingWith(error: unknown): ConsoleInputsClient {
    return {
      async pipeIo(): Promise<PipeIOResponse> {
        throw error;
      },
    };
  }

  it("locates an address the runner refuses at method_ref", async () => {
    const result = await walk(
      { method_ref: "github.com/Pipelex/methods/nope@v9", inputs: {} },
      { client: failingWith(apiError(404, "not_found", "not_found")) },
    );

    expect(result.error?.class).toBe("input_domain");
    expect(result.error?.location).toBe("method_ref");
  });

  it("locates a malformed address at method_ref with the grammar in the hint", async () => {
    const result = await walk(
      { method_ref: "not-an-address", inputs: {} },
      { client: failingWith(apiError(422, "invalid_request", "input_domain")) },
    );

    expect(result.error?.location).toBe("method_ref");
    expect(result.error?.hint).toContain("github.com/");
  });

  it("locates an unknown method id at method_id, pointing at the console's catalog tool", async () => {
    const result = await walk(
      { method_id: "mt_missing", inputs: {} },
      { client: failingWith(apiError(404, "not_found", "not_found")) },
    );

    expect(result.error?.class).toBe("input_domain");
    expect(result.error?.location).toBe("method_id");
    expect(result.error?.hint).toContain("pipelex_list_methods");
  });

  // A runner too old to serve `/v1/pipe-io` answers a bare 404, with neither an
  // error type nor a code: that is the deployment, never the method named.
  for (const selector of [
    { method_ref: "github.com/Pipelex/methods/documents@v0.1.0" },
    { method_id: "mt_123" },
  ]) {
    it(`reports a bare 404 as config at PIPELEX_BASE_URL (${Object.keys(selector)[0]})`, async () => {
      const result = await walk(
        { ...selector, inputs: {} },
        {
          client: failingWith(
            new ApiResponseError(
              "HTTP 404",
              `${DEFAULT_API_URL}/v1/pipe-io`,
              404,
              "Not Found",
              '{"detail":"Not Found"}',
              undefined, // errorType
              "Not Found",
              undefined, // validationErrors
              undefined, // code
            ),
          ),
        },
      );

      expect(result.error?.class).toBe("config");
      expect(result.error?.location).toBe("PIPELEX_BASE_URL");
      expect(result.error?.hint).toContain("/v1/pipe-io");
    });
  }

  it("locates the sandbox refusal (403) at method_ref, never at the credential", async () => {
    const result = await walk(
      { method_ref: PUBLISHED_REF, inputs: {} },
      { client: failingWith(apiError(403, "CustomCodeRequiresSandbox", "forbidden")) },
    );

    // `/v1/pipe-io` fetches `.mthds` files alone and decides no execution
    // locus, so it should never answer this; the classification stays for a
    // deployment that does, located where it was on `/v1/validate`. The generic 401/403 arm used to tell
    // the caller their credential was rejected, for a package that is
    // perfectly fine on a sandbox-hosted deployment.
    expect(result.status).toBe("error");
    expect(result.error?.class).toBe("input_domain");
    expect(result.error?.location).toBe("method_ref");
    expect(result.error?.hint).toMatch(/sandbox-hosted/);
  });

  it("surfaces an unreachable API as config", async () => {
    const result = await walk(
      { method_id: "mt_123", inputs: {} },
      {
        client: failingWith(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
      },
    );

    expect(result.error?.class).toBe("config");
  });

  it("names no workshop tool in any refusal it composes", async () => {
    // The walk is the console's alone, so every hint it writes must name tools
    // the console registers.
    const refusals = await Promise.all([
      walk({ inputs: { photo: "/tmp/a.png" } }, { client: pipeIoWith(reportWith(demoInputForm)) }),
      walk({ method_ref: PUBLISHED_REF, inputs: {} }, { client: pipeIoWith(invalidReport) }),
      walk({ method_id: "mt_1", inputs: {} }, { client: pipeIoWith(invalidReport) }),
      walk(
        { method_id: "mt_1", inputs: {} },
        { client: failingWith(apiError(404, "not_found", "not_found")) },
      ),
    ]);

    for (const refusal of refusals) {
      expect(refusal.status).toBe("error");
      expect(JSON.stringify(refusal.error)).not.toContain("mthds_");
    }
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
