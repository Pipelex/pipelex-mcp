import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  InputForm,
  MthdsFile,
  PipeIOContracts,
  PipelexInvalidReport,
  PipelexValidationReport,
  PipelexValidationResult,
  ValidateFilesOptions,
  ValidateMethodSelector,
} from "@pipelex/sdk";

import { DEFAULT_API_URL } from "./shared.js";
import type { FileResolver } from "./shared.js";
import { toolResult, validateMthds, validationResult } from "./validate.js";

/** Fake selector arm for tests whose request must never reach the selector leg. */
const selectorValidateNotCalled = {
  async validate(): Promise<PipelexValidationResult> {
    throw new Error("validate (selector leg) must not be called in this test");
  },
};

/** Fake validateFiles arm for tests whose request must never reach the inline-files leg. */
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
  // Namespaced, matching the `demo.main` key the contracts and the descriptor
  // are stored under — a real report keys both artifacts by the ref the
  // blueprint produces, and the signature's contract lookup depends on it.
  bundle_blueprint: { domain: "demo", main_pipe: "main" },
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

// Appended to the API's rendered markdown on every valid verdict that carries a
// signature, ahead of the Views note. Kept in sync with `signatureLine`.
const MAIN_PIPE_NOTE = "\n\n## Main pipe\n\n`demo.main(topic: native.Text) -> native.Text`";

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
    // The summary is the API markdown plus the appended signature line and
    // Views note, in that order.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE + VIEWS_NOTE);
    // The graph rides the view-only `graphSpec` field (delivered on `_meta`),
    // never `structuredContent` — the model reads the lean verdict only.
    expect(result.graphSpec).toEqual(validReport.graph_spec);
    // ...but the model still learns the views are available via this list.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    // The IO contracts and their descriptor ride beside the graph, same
    // channel, same discipline.
    expect(result.pipeIoContracts).toEqual(validReport.pipe_io_contracts);
    expect(result.inputForm).toEqual(validReport.input_form);
    expect(result.mainPipeRef).toBe("demo.main");
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
    // The signature does not ride the graph either.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE + VIEWS_NOTE_FORM_ONLY);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
  });

  it("falls back to the bare main pipe name when the blueprint states no domain", () => {
    const report: PipelexValidationReport = {
      ...validReport,
      bundle_blueprint: { main_pipe: "main" },
    };
    const result = validationResult(report, true);

    expect(result.mainPipeRef).toBe("main");
    // ...and the contracts, keyed by the namespaced ref, then hold no entry for
    // it — a missing entry omits the signature rather than guessing at a key.
    expect(result.structuredContent.main_pipe).toBeUndefined();
    expect(result.summary).toBe("# Valid" + VIEWS_NOTE);
  });

  it("does not advertise a form when the report carries no contracts", () => {
    const report: PipelexValidationReport = { ...validReport, pipe_io_contracts: {} };
    const result = validationResult(report, true);

    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result.pipeIoContracts).toBeUndefined();
    expect(result.inputForm).toBeUndefined();
    // The ref is still derived (it is the blueprint's, not the contracts'), but
    // an empty contract map leaves the signature nothing to project.
    expect(result.mainPipeRef).toBe("demo.main");
    expect(result.structuredContent.main_pipe).toBeUndefined();
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
    expect(result.mainPipeRef).toBe("demo.main");
    // The signature reads the contracts, which are still there — it never
    // depended on the descriptor beyond input order.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE + VIEWS_NOTE_GRAPH_ONLY);
  });

  it("does not advertise or emit a graph when the invoking shell has no views", () => {
    const result = validationResult(validReport, true, false);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.graphSpec).toBeUndefined();
    expect(result.pipeIoContracts).toBeUndefined();
    // The workshop is precisely the shell the signature exists for, so it is
    // NOT on the views branch.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE);
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
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE + VIEWS_NOTE_GRAPH_ONLY);
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

/**
 * A three-input contract whose MAP order (`notes`, `document`, `tags`) is
 * deliberately not the authored order the descriptor states (`document`,
 * `notes`, `tags`) — ordering is the one thing the descriptor is consulted for,
 * and a fixture whose two orders agree would prove nothing. It also carries the
 * three shapes the rendered line has notation for: an optional slot, a variable
 * list, and a fixed output.
 */
const orderedContracts: PipeIOContracts = {
  "demo.main": {
    inputs: {
      notes: {
        concept_ref: "native.Text",
        presence: "optional",
        multiplicity: "single",
        item_count: null,
        json_schema: { type: "string" },
      },
      document: {
        concept_ref: "legal.Contract",
        presence: "force",
        multiplicity: "single",
        item_count: null,
        json_schema: { type: "object" },
      },
      tags: {
        concept_ref: "native.Text",
        presence: "plain",
        multiplicity: "variable",
        item_count: null,
        json_schema: { type: "array", items: { type: "string" } },
      },
    },
    output: {
      concept_ref: "analysis.Report",
      multiplicity: "fixed",
      item_count: 2,
      optional: false,
    },
  },
};

const orderedInputForm: InputForm = {
  "demo.main": {
    fields: [
      {
        name: "document",
        kind: "object",
        concept_ref: "legal.Contract",
        required: true,
        presence: "force",
        gating: true,
        fields: [],
      },
      {
        name: "notes",
        kind: "prose",
        concept_ref: "native.Text",
        required: false,
        presence: "optional",
        gating: false,
      },
      {
        name: "tags",
        kind: "list",
        concept_ref: "native.Text",
        required: true,
        presence: "plain",
        gating: false,
        item: { kind: "prose", concept_ref: "native.Text", required: true },
      },
    ],
  },
};

const orderedReport: PipelexValidationReport = {
  ...validReport,
  pipe_io_contracts: orderedContracts,
  input_form: orderedInputForm,
};

/** The three ordered inputs, as the signature reports them. */
const ORDERED_INPUTS = [
  { name: "document", concept_ref: "legal.Contract", multiplicity: "single", required: true },
  { name: "notes", concept_ref: "native.Text", multiplicity: "single", required: false },
  { name: "tags", concept_ref: "native.Text", multiplicity: "variable", required: true },
];

/** Build a report whose main pipe carries exactly this (possibly malformed) contract. */
function reportWithContract(contract: unknown): PipelexValidationReport {
  return {
    ...validReport,
    pipe_io_contracts: { "demo.main": contract } as unknown as PipeIOContracts,
  };
}

describe("main pipe signature", () => {
  it("projects the main pipe's signature in the authored order the descriptor states", () => {
    const result = validationResult(orderedReport, true);

    // toEqual pins the field set as well as the values: an extra member would
    // be a token the model pays for and a schema the host may reject.
    expect(result.structuredContent.main_pipe).toEqual({
      pipe_ref: "demo.main",
      inputs: ORDERED_INPUTS,
      output: {
        concept_ref: "analysis.Report",
        multiplicity: "fixed",
        item_count: 2,
        optional: false,
      },
    });
    // `?` for an input the caller may omit, `[]` for a variable list, `[N]` for
    // a fixed one.
    expect(result.summary).toContain(
      "`demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]`",
    );
  });

  it("falls back to the contract map's own order when no descriptor arrived", () => {
    const result = validationResult({ ...orderedReport, input_form: undefined }, true);

    expect(result.structuredContent.main_pipe?.inputs.map((input) => input.name)).toEqual([
      "notes",
      "document",
      "tags",
    ]);
  });

  it("keeps every declared input when the descriptor and the contract disagree", () => {
    // A descriptor naming a slot the contract does not declare, and silent
    // about one it does: ordering degrades, an input is never dropped.
    const inputForm: InputForm = {
      "demo.main": {
        fields: [
          {
            name: "ghost",
            kind: "prose",
            required: true,
            presence: "plain",
            gating: true,
          },
          {
            name: "tags",
            kind: "list",
            concept_ref: "native.Text",
            required: true,
            presence: "plain",
            gating: false,
            item: { kind: "prose", concept_ref: "native.Text", required: true },
          },
        ],
      },
    };
    const result = validationResult({ ...orderedReport, input_form: inputForm }, true);

    expect(result.structuredContent.main_pipe?.inputs.map((input) => input.name)).toEqual([
      "tags",
      "notes",
      "document",
    ]);
  });

  it("reports a slot once when the descriptor names it twice", () => {
    // A repeated field is producer drift like any other, and the ordered half
    // would otherwise carry the name twice — a duplicated slot renders a call
    // site that is wrong in the plausible way this module refuses to be.
    const [document, notes, tags] = orderedInputForm["demo.main"].fields;
    const inputForm: InputForm = {
      "demo.main": { fields: [document, notes, document, tags] },
    };
    const result = validationResult({ ...orderedReport, input_form: inputForm }, true);

    expect(result.structuredContent.main_pipe?.inputs).toEqual(ORDERED_INPUTS);
  });

  it("projects the signature on a pending-signature verdict", () => {
    // Not runnable, so no form is advertised — but the shape is fully
    // determined before the signatures resolve, and knowing it is what lets an
    // agent write the call site it is about to fill in.
    const result = validationResult(
      { ...orderedReport, pending_signatures: ["demo.todo"], is_runnable: false },
      true,
    );

    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.main_pipe?.pipe_ref).toBe("demo.main");
  });

  it("projects the signature on a shell with no views — the workshop case", () => {
    const result = validationResult(orderedReport, true, false);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.main_pipe?.inputs).toEqual(ORDERED_INPUTS);
    expect(result.summary).toContain("## Main pipe");
  });

  it("projects the signature when the graph was not requested", () => {
    const result = validationResult(orderedReport, false);

    expect(result.graphSpec).toBeUndefined();
    expect(result.structuredContent.main_pipe?.inputs).toEqual(ORDERED_INPUTS);
  });

  it("marks an optional output with a trailing ? in the rendered line", () => {
    const result = validationResult(
      reportWithContract({
        inputs: {},
        output: {
          concept_ref: "analysis.Report",
          multiplicity: "single",
          item_count: null,
          optional: true,
        },
      }),
      true,
    );

    expect(result.structuredContent.main_pipe?.output.optional).toBe(true);
    expect(result.summary).toContain("`demo.main() -> analysis.Report?`");
  });

  it("omits the signature when the blueprint declares no main pipe", () => {
    const result = validationResult(
      { ...orderedReport, bundle_blueprint: { domain: "demo" } },
      true,
    );

    expect(result.structuredContent.main_pipe).toBeUndefined();
    expect(result.summary).not.toContain("## Main pipe");
  });

  it("omits the whole signature rather than emitting a partial one", () => {
    // Each of these is a well-formed report in every other respect: the verdict
    // must survive untouched, and half a signature must never reach the agent
    // typing a call site against it.
    const malformed: Array<[string, unknown]> = [
      ["a contract that is not an object", "demo.main"],
      [
        "an unknown multiplicity",
        {
          inputs: {},
          output: { concept_ref: "analysis.Report", multiplicity: "many", item_count: null },
        },
      ],
      [
        "a fixed arm with no item_count",
        {
          inputs: {},
          output: {
            concept_ref: "analysis.Report",
            multiplicity: "fixed",
            item_count: null,
            optional: false,
          },
        },
      ],
      [
        "an item_count off the fixed arm",
        {
          inputs: {},
          output: {
            concept_ref: "analysis.Report",
            multiplicity: "single",
            item_count: 3,
            optional: false,
          },
        },
      ],
      [
        // `Concept[1]` is the language's way of writing `Concept` and reports
        // "single" — a fixed arm carrying 1 is a producer violation.
        "a fixed count of one",
        {
          inputs: {},
          output: {
            concept_ref: "analysis.Report",
            multiplicity: "fixed",
            item_count: 1,
            optional: false,
          },
        },
      ],
      [
        // The contract states `item_count: null` on every non-fixed arm,
        // literally and always on the wire — an omitted member is drift.
        "an omitted item_count off the fixed arm",
        {
          inputs: {},
          output: { concept_ref: "analysis.Report", multiplicity: "single", optional: false },
        },
      ],
      [
        "a non-null non-number item_count off the fixed arm",
        {
          inputs: {},
          output: {
            concept_ref: "analysis.Report",
            multiplicity: "variable",
            item_count: "3",
            optional: false,
          },
        },
      ],
      [
        "an output with no optional flag",
        {
          inputs: {},
          output: { concept_ref: "analysis.Report", multiplicity: "single", item_count: null },
        },
      ],
      [
        "an empty concept ref on an input",
        {
          inputs: {
            topic: {
              concept_ref: "",
              presence: "plain",
              multiplicity: "single",
              item_count: null,
              json_schema: {},
            },
          },
          output: {
            concept_ref: "analysis.Report",
            multiplicity: "single",
            item_count: null,
            optional: false,
          },
        },
      ],
      [
        "an unknown presence marker on an input",
        {
          inputs: {
            topic: {
              concept_ref: "native.Text",
              presence: "maybe",
              multiplicity: "single",
              item_count: null,
              json_schema: {},
            },
          },
          output: {
            concept_ref: "analysis.Report",
            multiplicity: "single",
            item_count: null,
            optional: false,
          },
        },
      ],
    ];

    for (const [label, contract] of malformed) {
      const result = validationResult(reportWithContract(contract), true);

      expect(result.structuredContent.main_pipe, label).toBeUndefined();
      expect(result.summary, label).not.toContain("## Main pipe");
      // The verdict is unaffected — the signature is a projection beside it.
      expect(result.structuredContent.is_valid, label).toBe(true);
      expect(result.structuredContent.status, label).toBe("ok");
    }
  });
});

describe("effective entry pipe", () => {
  /**
   * A `method_ref` package whose manifest entry (`other.shout`) is not the
   * bundle-level `main_pipe` (`demo.main`) — the divergence the server's
   * `default_pipe_ref` exists to state, and the only case where the two signals
   * disagree about the pipe a selector-less run executes.
   */
  const divergingContracts: PipeIOContracts = {
    ...orderedContracts,
    "other.shout": {
      inputs: {
        message: {
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

  const divergingReport: PipelexValidationReport = {
    ...orderedReport,
    pipe_io_contracts: divergingContracts,
  };

  it("prefers the server's stated default over the blueprint's main pipe", () => {
    // The blueprint still says `demo.main`; the manifest the MCP cannot see
    // says `other.shout`, and that is the pipe `mthds_run` defaults to.
    const result = validationResult({ ...divergingReport, default_pipe_ref: "other.shout" }, true);

    expect(result.mainPipeRef).toBe("other.shout");
    expect(result.structuredContent.main_pipe).toEqual({
      pipe_ref: "other.shout",
      inputs: [
        { name: "message", concept_ref: "native.Text", multiplicity: "single", required: true },
      ],
      output: { concept_ref: "native.Text", multiplicity: "single", optional: false },
    });
    expect(result.summary).toContain("`other.shout(message: native.Text) -> native.Text`");
  });

  it("omits the signature when the server states no default, blueprint or not", () => {
    // `null` is the server saying it determined no entry pipe — a manifest
    // naming a pipe the closure declares in several domains, say. A
    // selector-less run would fail to resolve one too, so the blueprint must
    // not be consulted behind it.
    const result = validationResult({ ...divergingReport, default_pipe_ref: null }, true);

    expect(result.mainPipeRef).toBeUndefined();
    expect(result.structuredContent.main_pipe).toBeUndefined();
    expect(result.summary).not.toContain("## Main pipe");
    // The verdict is untouched — this is a projection beside it.
    expect(result.structuredContent.is_valid).toBe(true);
  });

  it("falls back to the blueprint when the field is absent — the older runner", () => {
    // No `default_pipe_ref` own property at all: the runner predates the
    // field, and the blueprint derivation is the only signal there is.
    expect(divergingReport).not.toHaveProperty("default_pipe_ref");
    const result = validationResult(divergingReport, true);

    expect(result.mainPipeRef).toBe("demo.main");
    expect(result.structuredContent.main_pipe?.inputs).toEqual(ORDERED_INPUTS);
  });

  it("treats a drifting field value as no default rather than as absence", () => {
    // A server carrying the field but sending something unreadable has an
    // opinion we cannot read; naming the blueprint's pipe behind it would be
    // the guess this module refuses everywhere else.
    for (const stated of [42, "", { pipe_ref: "demo.main" }]) {
      // Cast because the drift is the point: a newer SDK types this field, and
      // a fixture that could not express a value it forbids would stop testing
      // what arrives on the wire.
      const result = validationResult(
        { ...divergingReport, default_pipe_ref: stated } as unknown as PipelexValidationReport,
        true,
      );

      expect(result.mainPipeRef, JSON.stringify(stated)).toBeUndefined();
      expect(result.structuredContent.main_pipe, JSON.stringify(stated)).toBeUndefined();
    }
  });

  it("carries the stated default on _meta, where the view reads the pipe in play", () => {
    const result = toolResult(
      validationResult({ ...divergingReport, default_pipe_ref: "other.shout" }, true),
    );

    expect(result._meta.main_pipe_ref).toBe("other.shout");
  });
});

describe("toolResult", () => {
  it("delivers the graph on _meta, never on structuredContent", () => {
    const result = toolResult(validationResult(validReport, true));

    expect(result._meta.graph_spec).toEqual(validReport.graph_spec);
    expect(result._meta.pipe_io_contracts).toEqual(validReport.pipe_io_contracts);
    expect(result._meta.input_form).toEqual(validReport.input_form);
    expect(result._meta.main_pipe_ref).toBe("demo.main");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: "# Valid" + MAIN_PIPE_NOTE + VIEWS_NOTE },
    ]);
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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
          ...selectorValidateNotCalled,
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

describe("validateMthds by selector (server pass-through)", () => {
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  function apiError(
    status: number,
    statusText: string,
    errorType?: string,
    serverMessage?: string,
  ): ApiResponseError {
    return new ApiResponseError(
      `HTTP ${status}`,
      `${DEFAULT_API_URL}/v1/validate`,
      status,
      statusText,
      "{}",
      errorType,
      serverMessage,
      undefined, // validationErrors
      undefined, // code
    );
  }

  it("forwards method_id to the validate route as a selector — nothing expanded client-side", async () => {
    let capturedSource: ValidateMethodSelector | undefined;
    let capturedArgs: unknown[] | undefined;

    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(source, allowSignatures, mthdsSources, render, views) {
            capturedSource = source;
            capturedArgs = [allowSignatures, mthdsSources, render, views];
            return validReport;
          },
        },
      },
    );

    expect(capturedSource).toEqual({ method_id: "mt_123" });
    // allowSignatures on; no client-side source labels (the server labels
    // diagnostics from the stored method's real file names); the descriptor
    // opt-in rides `views`. `render` stays undefined — the SDK always adds
    // markdown itself.
    expect(capturedArgs).toEqual([true, undefined, undefined, ["input_form"]]);
    expect(result.structuredContent.status).toBe("ok");
    // The views work the same whichever selector supplied the content.
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    expect(result.graphSpec).toEqual(validReport.graph_spec);
  });

  it("forwards method_ref to the validate route as a selector", async () => {
    let capturedSource: ValidateMethodSelector | undefined;

    const result = await validateMthds(
      { method_ref: ADDRESS },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(source) {
            capturedSource = source;
            return validReport;
          },
        },
      },
    );

    expect(capturedSource).toEqual({ method_ref: ADDRESS });
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects files + method_id — one selector on a tooling tool, files no longer silently win", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: { ...validateFilesNotCalled, ...selectorValidateNotCalled },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("rejects files + method_ref", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }], method_ref: ADDRESS },
      {
        baseUrl: DEFAULT_API_URL,
        client: { ...validateFilesNotCalled, ...selectorValidateNotCalled },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("rejects method_ref + method_id", async () => {
    const result = await validateMthds(
      { method_ref: ADDRESS, method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: { ...validateFilesNotCalled, ...selectorValidateNotCalled },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("rejects a blank method_ref at method_ref", async () => {
    const result = await validateMthds(
      { method_ref: "   " },
      {
        baseUrl: DEFAULT_API_URL,
        client: { ...validateFilesNotCalled, ...selectorValidateNotCalled },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("surfaces an unknown method id (404) as input_domain at method_id", async () => {
    const result = await validateMthds(
      { method_id: "mt_missing" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(404, "Not Found", "not_found", "Method not found");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
  });

  it("locates a by-id 422 (no source, or a deployment without the selector) at method_id", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(422, "Unprocessable Entity", "bad_request", "no MTHDS source");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/hosted/i);
  });

  it("locates a method_ref parse/fetch 422 and a no-package 404 at method_ref", async () => {
    for (const [status, statusText, errorType] of [
      [422, "Unprocessable Entity", "MethodFetchError"],
      [404, "Not Found", "MethodPackageNotFoundError"],
    ] as const) {
      const result = await validateMthds(
        { method_ref: ADDRESS },
        {
          baseUrl: DEFAULT_API_URL,
          client: {
            ...validateFilesNotCalled,
            async validate(): Promise<PipelexValidationResult> {
              throw apiError(status, statusText, errorType, "resolution failed");
            },
          },
        },
      );

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
      expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
      expect(result.structuredContent.errors?.[0]?.retryable).toBe(false);
    }
  });

  it("classifies the structures refusal (403) as the caller's selector, never an auth failure", async () => {
    const result = await validateMthds(
      { method_ref: ADDRESS },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(
              403,
              "Forbidden",
              "MethodStructuresRefusedError",
              "hosted execution accepts MTHDS concepts and sandboxed PipeFuncs, not in-process Python",
            );
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    // A plain 403 classifies as config-at-auth; this one names the policy in
    // its error_type and must read as the caller's own package, not a bad key.
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/MTHDS concepts/);
  });

  it("classifies a registry-form 501 as input_domain at method_ref with the address-grammar hint", async () => {
    const result = await validateMthds(
      { method_ref: "some-registry/method" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(501, "Not Implemented", "not_implemented", "registry refs are reserved");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/address-form/i);
  });

  it("classifies a paywall (402) on the selector leg as config with the plan headline", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          ...validateFilesNotCalled,
          async validate(): Promise<PipelexValidationResult> {
            throw apiError(402, "Payment Required", "forbidden", "Subscription required");
          },
        },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    // A headline-only host shows just this line, so it must name the plan
    // rather than the connectivity headline every other `config` error gets.
    expect(result.summary).toBe(
      "Validation could not start: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("classifies a malformed base URL on the selector leg as config", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      { baseUrl: `${DEFAULT_API_URL}/v1` },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });

  it("rejects a request with no selector at all", async () => {
    const result = await validateMthds(
      {},
      {
        baseUrl: DEFAULT_API_URL,
        client: { ...validateFilesNotCalled, ...selectorValidateNotCalled },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
  });
});
