import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiResponseError, ApiUnreachableError, RequestArgumentError } from "@pipelex/sdk";
import type {
  InputForm,
  MethodTreeSource,
  OutputForm,
  PipeIOContracts,
  PipelexInvalidReport,
  PipelexValidateSource,
  PipelexValidationReport,
  PipelexValidationResult,
  ValidateOptions,
} from "@pipelex/sdk";

import { localMethodFileResolver } from "../files.js";
import { GRAPH_PAGE_FILENAME, GRAPH_PAGE_MARK } from "./graph-page.js";
import { DEFAULT_API_URL, problemOf, SECRET_REASON } from "./shared.js";
import type { FileResolver } from "./shared.js";
import { imageFieldPaths, toolResult, validateMthds, validationResult } from "./validate.js";
import type { ValidationClient, ValidationContext } from "./validate.js";

/** A fake client for tests whose request must never reach the API. */
const validateNotCalled: ValidationClient = {
  async validate(): Promise<PipelexValidationResult> {
    throw new Error("validate must not be called in this test");
  },
};

/** The tree a validate call sent, when it sent one rather than a selector. */
function treeOf(source: PipelexValidateSource): MethodTreeSource | undefined {
  return "tree" in source && source.tree !== undefined && source.tree !== null
    ? source.tree
    : undefined;
}

/**
 * A fake client answering a tree with `answer`, which gets the tree and the
 * options it was sent with; a selector must never reach it.
 */
function onTree(
  answer: (
    tree: MethodTreeSource,
    options: ValidateOptions | undefined,
  ) => PipelexValidationResult | Promise<PipelexValidationResult>,
): ValidationClient {
  return {
    async validate(source, _allowSignatures, options) {
      const tree = treeOf(source);
      if (tree === undefined) throw new Error("the selector leg must not be called in this test");
      return answer(tree, options);
    },
  };
}

/** Every file of a tree sent, as text, by tree path. */
async function contentsOf(tree: MethodTreeSource | undefined): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  for (const file of tree?.files ?? []) {
    contents[file.path] = new TextDecoder().decode(await tree!.readFile(file.path));
  }
  return contents;
}

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
      json_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
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

/**
 * The input form's twin for the other half of the contract: one node saying
 * what the pipe RESOLVES TO. `demo.main` produces text, so the default fixture
 * holds no image and the projection reports the empty array.
 */
const demoOutputForm: OutputForm = {
  "demo.main": {
    field: { name: "output", kind: "prose", concept_ref: "native.Text", required: true },
  },
};

/** One output-form descriptor for `demo.main`, around whatever node is under test. */
function outputFormOf(field: unknown): OutputForm {
  return { "demo.main": { field } } as OutputForm;
}

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
// signature. Kept in sync with `signatureLine`.
const MAIN_PIPE_NOTE = "\n\n## Main pipe\n\n`demo.main(topic: native.Text) -> native.Text`";

const invalidReport: PipelexInvalidReport = {
  is_valid: false,
  is_runnable: false,
  pending_signatures: [],
  message: "invalid",
  errors: [
    {
      code: "method.pipe_type_invalid",
      detail: "Pipe 'demo.main' has no usable type (reason: unknown_type).",
      params: { pipe: "demo.main", reason: "unknown_type" },
      location: { pipe: "demo.main", file: "bundle.mthds" },
    },
  ],
  rendered_markdown: "# Invalid",
};

describe("validationResult", () => {
  it("projects runnable valid reports and keeps the graph off structuredContent", () => {
    const result = validationResult(validReport);

    expect(result.structuredContent.status).toBe("ok");
    // The summary is the API markdown plus the appended signature line.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE);
    expect(result.mainPipeRef).toBe("demo.main");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
  });

  it("settles no entry pipe when the blueprint states a bare main pipe and no domain", () => {
    const report: PipelexValidationReport = {
      ...validReport,
      bundle_blueprint: { main_pipe: "main" },
    };
    const result = validationResult(report);

    // A bare code cannot key either artifact — both are keyed by the qualified
    // ref — so there is nothing to qualify it with and nothing to find.
    expect(result.mainPipeRef).toBeUndefined();
    // A missing entry omits the signature rather than guessing at a key.
    expect(result.structuredContent.main_pipe).toBeUndefined();
    expect(result.summary).toBe("# Valid");
  });

  it("leaves an already-qualified blueprint main_pipe alone instead of prefixing the domain", () => {
    // A cross-domain `main_pipe` used to be prefixed unconditionally into
    // `demo.other.shout`, which keys neither artifact, so the signature went
    // missing on every runner old enough to serve no `default_pipe_ref`.
    const report: PipelexValidationReport = {
      ...validReport,
      bundle_blueprint: { domain: "demo", main_pipe: "other.shout" },
    };

    expect(validationResult(report).mainPipeRef).toBe("other.shout");
  });

  it("carries no signature when the report carries no contracts", () => {
    const report: PipelexValidationReport = { ...validReport, pipe_io_contracts: {} };
    const result = validationResult(report);

    // The ref is still derived (it is the blueprint's, not the contracts'), but
    // an empty contract map leaves the signature nothing to project.
    expect(result.mainPipeRef).toBe("demo.main");
    expect(result.structuredContent.main_pipe).toBeUndefined();
    expect(result.summary).toBe("# Valid");
  });

  it("keeps the signature when the report carries no descriptor", () => {
    // A runner that ignores the `views` token (or predates it) returns no
    // `input_form`.
    const report: PipelexValidationReport = { ...validReport, input_form: undefined };
    const result = validationResult(report);

    expect(result.mainPipeRef).toBe("demo.main");
    // The signature reads the contracts, which are still there — it never
    // depended on the descriptor beyond input order.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE);
  });

  it("does not advertise or emit a graph", () => {
    const result = validationResult(validReport);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    // The signature is not on a views branch.
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE);
  });

  it("projects pending signatures as valid but not runnable", () => {
    const result = validationResult(pendingReport);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.pending_signatures).toEqual(["demo.todo"]);
    expect(result.summary).toBe("# Valid" + MAIN_PIPE_NOTE);
  });

  it("projects invalid produced verdicts as ok with their problem items", () => {
    const result = validationResult(invalidReport);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.errors).toEqual(invalidReport.errors);
    expect(result.structuredContent).not.toHaveProperty("problem");
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent).not.toHaveProperty("rendered_markdown");
    expect(result.summary).toBe("# Invalid");
  });

  it("throws when rendered markdown is missing", () => {
    const report = {
      ...validReport,
      rendered_markdown: null,
    } as unknown as PipelexValidationReport;

    expect(() => validationResult(report)).toThrow(/did not include rendered markdown/);
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
      json_schema: {
        type: "object",
        properties: {
          items: { type: "array", minItems: 2, maxItems: 2, items: { type: "object" } },
        },
      },
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
    const result = validationResult(orderedReport);

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
    const result = validationResult({ ...orderedReport, input_form: undefined });

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
    const result = validationResult({ ...orderedReport, input_form: inputForm });

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
    const result = validationResult({ ...orderedReport, input_form: inputForm });

    expect(result.structuredContent.main_pipe?.inputs).toEqual(ORDERED_INPUTS);
  });

  it("projects the signature on a pending-signature verdict", () => {
    // Not runnable, so no form is advertised — but the shape is fully
    // determined before the signatures resolve, and knowing it is what lets an
    // agent write the call site it is about to fill in.
    const result = validationResult({
      ...orderedReport,
      pending_signatures: ["demo.todo"],
      is_runnable: false,
    });

    expect(result.structuredContent.is_runnable).toBe(false);
    expect(result.structuredContent.main_pipe?.pipe_ref).toBe("demo.main");
  });

  it("projects the signature on a shell with no views — the workshop case", () => {
    const result = validationResult(orderedReport);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.main_pipe?.inputs).toEqual(ORDERED_INPUTS);
    expect(result.summary).toContain("## Main pipe");
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
    );

    expect(result.structuredContent.main_pipe?.output.optional).toBe(true);
    expect(result.summary).toContain("`demo.main() -> analysis.Report?`");
  });

  it("omits the signature when the blueprint declares no main pipe", () => {
    const result = validationResult({ ...orderedReport, bundle_blueprint: { domain: "demo" } });

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
      const result = validationResult(reportWithContract(contract));

      expect(result.structuredContent.main_pipe, label).toBeUndefined();
      expect(result.summary, label).not.toContain("## Main pipe");
      // The verdict is unaffected — the signature is a projection beside it.
      expect(result.structuredContent.is_valid, label).toBe(true);
      expect(result.structuredContent.status, label).toBe("ok");
    }
  });

  it("omits the signature when a plain-object contract fails to narrow", () => {
    // The signature refuses to emit a half-narrowed call site, so a
    // non-boolean `optional` yields no signature.
    const result = validationResult(
      reportWithContract({
        inputs: {},
        output: {
          concept_ref: "analysis.Report",
          multiplicity: "single",
          item_count: null,
          optional: "no",
        },
      }),
    );

    expect(result.structuredContent.main_pipe).toBeUndefined();
  });

  it("omits the signature when the contract entry is not an object", () => {
    // An entry that is no object at all is no entry.
    const result = validationResult(reportWithContract("demo.main"));

    expect(result.structuredContent.main_pipe).toBeUndefined();
    // The verdict is untouched.
    expect(result.structuredContent.is_valid).toBe(true);
  });
});

describe("the produces-images signal", () => {
  describe("imageFieldPaths", () => {
    it("reads a top-level image as the output's own root", () => {
      expect(imageFieldPaths({ name: "output", kind: "image", required: true })).toEqual({
        paths: ["$"],
        complete: true,
      });
    });

    it("reads a plural image output through the descriptor's own list wrap", () => {
      // The plural wrap is performed on the descriptor, so the walk never
      // consults the contract's multiplicity for it.
      expect(
        imageFieldPaths({
          name: "output",
          kind: "list",
          concept_ref: "native.Image",
          required: true,
          item: { kind: "image", concept_ref: "native.Image", required: true },
        }),
      ).toEqual({ paths: ["$[]"], complete: true });
    });

    it("names each image field of a structured output, and skips the rest", () => {
      expect(
        imageFieldPaths({
          name: "output",
          kind: "object",
          concept_ref: "report.Page",
          required: true,
          fields: [
            { name: "caption", kind: "prose", required: true },
            { name: "picture", kind: "image", required: true },
            { name: "attachment", kind: "document", required: false },
            { name: "thumbnail", kind: "image", required: false },
          ],
        }),
        // Complete: prose and document are kinds the walk fully understands and
        // that hold no picture, so the set below is known to be exhaustive.
      ).toEqual({ paths: ["$.picture", "$.thumbnail"], complete: true });
    });

    it("walks into a list of structured outputs", () => {
      expect(
        imageFieldPaths({
          name: "output",
          kind: "list",
          concept_ref: "report.Page",
          required: true,
          item: {
            kind: "object",
            concept_ref: "report.Page",
            required: true,
            fields: [{ name: "picture", kind: "image", required: true }],
          },
        }),
      ).toEqual({ paths: ["$[].picture"], complete: true });
    });

    it("treats an unknown node as opaque, and says the walk was incomplete", () => {
      // The standard's escape hatch: a producer that could not map the node
      // honestly. There may be an image in there and there is no way to know,
      // so the empty list MUST be reported as "could not tell" — the caller
      // withholds the member on it rather than publishing a confident none.
      expect(imageFieldPaths({ name: "output", kind: "unknown", required: true })).toEqual({
        paths: [],
        complete: false,
      });
    });

    it("stays complete through kinds that are understood and hold no picture", () => {
      // A document is deliberately not a picture. That is an ANSWER, not a
      // failure to look, so it must not poison the walk's completeness.
      for (const kind of ["text", "prose", "date", "number", "boolean", "enum", "document"]) {
        expect(imageFieldPaths({ name: "output", kind, required: true })).toEqual({
          paths: [],
          complete: true,
        });
      }
    });

    it("reports incomplete for a kind this build does not know", () => {
      // A kind a later version of the standard adds. Reading it as "no images"
      // is the exact false negative the completeness flag exists to prevent.
      expect(imageFieldPaths({ name: "output", kind: "hologram", required: true })).toEqual({
        paths: [],
        complete: false,
      });
    });

    it("reports incomplete past the depth ceiling", () => {
      let node: unknown = { name: "output", kind: "image", required: true };
      for (let i = 0; i < 40; i += 1) {
        node = { name: "output", kind: "list", required: true, item: node };
      }
      expect(imageFieldPaths(node)).toEqual({ paths: [], complete: false });
    });

    it("keeps a found image while reporting the walk incomplete beside it", () => {
      // The mixed case: one subtree is opaque, another really does hold a
      // picture. The paths are still true; the set is just not exhaustive.
      expect(
        imageFieldPaths({
          name: "output",
          kind: "object",
          required: true,
          fields: [
            { name: "picture", kind: "image", required: true },
            { name: "extra", kind: "unknown", required: false },
          ],
        }),
      ).toEqual({ paths: ["$.picture"], complete: false });
    });

    it("costs a malformed node its own subtree and nothing else", () => {
      expect(
        imageFieldPaths({
          name: "output",
          kind: "object",
          required: true,
          fields: [
            { name: "broken", kind: "not_a_kind", required: true },
            "not even an object",
            { kind: "image", required: true },
            { name: "picture", kind: "image", required: true },
          ],
        }),
        // The nameless image is skipped too: a path needs a name to be a path.
        // Each skipped child is a subtree nobody walked, so the set is not
        // known to be exhaustive.
      ).toEqual({ paths: ["$.picture"], complete: false });
    });

    it("answers nothing for a node that is not a node at all", () => {
      expect(imageFieldPaths(undefined)).toEqual({ paths: [], complete: false });
      expect(imageFieldPaths("a string")).toEqual({ paths: [], complete: false });
      expect(imageFieldPaths({ name: "output", required: true })).toEqual({
        paths: [],
        complete: false,
      });
    });
  });

  describe("projection onto main_pipe.output", () => {
    it("reports the empty array when the descriptor arrived and holds no image", () => {
      const result = validationResult({ ...validReport, output_form: demoOutputForm });

      expect(result.structuredContent.main_pipe?.output.images).toEqual([]);
      // Nothing is said in prose when nothing is produced.
      expect(result.summary).not.toContain("produces images");
    });

    it("reports the path and says so in prose when the output is an image", () => {
      const result = validationResult({
        ...validReport,
        output_form: outputFormOf({
          name: "output",
          kind: "image",
          concept_ref: "native.Image",
          required: true,
        }),
      });

      expect(result.structuredContent.main_pipe?.output.images).toEqual(["$"]);
      expect(result.summary).toContain("-> native.Text (produces images)");
    });

    it("leaves the member ABSENT when the walk could not see the whole output", () => {
      // The four-reviewer finding of round 1. `[]` is contracted to mean "the
      // server described the WHOLE output and it holds no image", so emitting
      // it off a node the walk could not read is a confident false negative —
      // a consumer applying the documented `images.length > 0` rule would skip
      // the image workflow on a method that may well produce pictures.
      for (const field of [
        { name: "output", kind: "unknown", required: true },
        { name: "output", kind: "not_a_kind", required: true },
        { name: "output", required: true },
        {
          name: "output",
          kind: "object",
          required: true,
          fields: [{ name: "inner", kind: "unknown", required: true }],
        },
      ]) {
        const result = validationResult({ ...validReport, output_form: outputFormOf(field) });

        expect(result.structuredContent.main_pipe?.output).not.toHaveProperty("images");
        expect(result.summary).not.toContain("produces images");
      }
    });

    it("still reports an image the walk DID find, though the rest was opaque", () => {
      // Downgrading a known yes to "unknown" would lose the very signal the
      // member exists for, so a non-empty list rides even when incomplete.
      const result = validationResult({
        ...validReport,
        output_form: outputFormOf({
          name: "output",
          kind: "object",
          required: true,
          fields: [
            { name: "picture", kind: "image", required: true },
            { name: "extra", kind: "unknown", required: false },
          ],
        }),
      });

      expect(result.structuredContent.main_pipe?.output.images).toEqual(["$.picture"]);
      expect(result.summary).toContain("(produces images)");
    });

    it("leaves the member ABSENT when no descriptor arrived, which is unknown and not none", () => {
      const result = validationResult(validReport);

      expect(result.structuredContent.main_pipe?.output).not.toHaveProperty("images");
      expect(result.summary).not.toContain("produces images");
    });

    it("leaves the member absent when the descriptor carries no entry for the entry pipe", () => {
      const result = validationResult({
        ...validReport,
        output_form: { "demo.other": demoOutputForm["demo.main"] },
      });

      expect(result.structuredContent.main_pipe?.output).not.toHaveProperty("images");
    });

    it("keeps the whole signature when the descriptor's entry is malformed", () => {
      // The contract is the signature's source of truth; the descriptor is
      // presentation riding beside it, so a bad one costs the images member and
      // never the signature.
      const result = validationResult({
        ...validReport,
        output_form: { "demo.main": { field: "not a node" } } as unknown as OutputForm,
      });

      expect(result.structuredContent.main_pipe).toEqual({
        pipe_ref: "demo.main",
        inputs: [
          {
            name: "topic",
            concept_ref: "native.Text",
            multiplicity: "single",
            required: true,
          },
        ],
        output: {
          concept_ref: "native.Text",
          multiplicity: "single",
          optional: false,
        },
      });
    });

    it("rides a valid verdict whose signatures are still pending", () => {
      // Independent of `is_runnable`, like the rest of the signature: the
      // output's shape is settled before the signatures are.
      const result = validationResult({
        ...pendingReport,
        output_form: outputFormOf({ name: "output", kind: "image", required: true }),
      });

      expect(result.structuredContent.main_pipe?.output.images).toEqual(["$"]);
    });
  });

  describe("the output descriptor", () => {
    it("never reaches structuredContent", () => {
      const result = toolResult(validationResult({ ...validReport, output_form: demoOutputForm }));

      expect(result.structuredContent).not.toHaveProperty("output_form");
    });

    it("still carries the images member", () => {
      const result = validationResult({
        ...validReport,
        output_form: outputFormOf({ name: "output", kind: "image", required: true }),
      });

      // The model-facing half is not on a views branch.
      expect(result.structuredContent.main_pipe?.output.images).toEqual(["$"]);
    });
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
        json_schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
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
    const result = validationResult({ ...divergingReport, default_pipe_ref: "other.shout" });

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
    const result = validationResult({ ...divergingReport, default_pipe_ref: null });

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
    const result = validationResult(divergingReport);

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
      const result = validationResult({
        ...divergingReport,
        default_pipe_ref: stated,
      } as unknown as PipelexValidationReport);

      expect(result.mainPipeRef, JSON.stringify(stated)).toBeUndefined();
      expect(result.structuredContent.main_pipe, JSON.stringify(stated)).toBeUndefined();
    }
  });

  it("carries the stated default on _meta", () => {
    const result = toolResult(
      validationResult({ ...divergingReport, default_pipe_ref: "other.shout" }),
    );

    expect(result._meta.main_pipe_ref).toBe("other.shout");
  });

  it("omits the signature when the contract has no entry for the entry pipe", () => {
    // The DESCRIPTOR knows `other.shout` while the contracts (still
    // `demo.main` only) do not.
    const inputForm: InputForm = {
      ...orderedInputForm,
      "other.shout": {
        fields: [
          {
            name: "message",
            kind: "prose",
            concept_ref: "native.Text",
            required: true,
            presence: "plain",
            gating: true,
          },
        ],
      },
    };
    const result = validationResult({
      ...orderedReport,
      input_form: inputForm,
      default_pipe_ref: "other.shout",
    });

    // No signature: the contract is what the signature narrows from.
    expect(result.structuredContent.main_pipe).toBeUndefined();
    expect(result.mainPipeRef).toBe("other.shout");
  });
});

describe("toolResult", () => {
  it("delivers the main pipe ref on _meta, and keeps the graph off structuredContent", () => {
    const result = toolResult(validationResult(validReport));

    expect(result._meta.main_pipe_ref).toBe("demo.main");
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "# Valid" + MAIN_PIPE_NOTE }]);
  });
});

describe("validateMthds", () => {
  it("sends inline files as one tree and projects the response", async () => {
    let captured: MethodTreeSource | undefined;
    let capturedOptions: ValidateOptions | undefined;

    const result = await validateMthds(
      {
        files: [
          { content: 'domain = "demo"', uri: "bundle.mthds" },
          { content: 'main_pipe = "main"', uri: null },
        ],
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: onTree((tree, options) => {
          captured = tree;
          capturedOptions = options;
          return validReport;
        }),
      },
    );

    // The first takes its uri's name; the second, with none, the next free one.
    expect(await contentsOf(captured)).toEqual({
      "bundle-2.mthds": 'main_pipe = "main"',
      "bundle.mthds": 'domain = "demo"',
    });
    // The `views` token is the descriptor opt-in — the spec keeps `input_form`
    // off the report unless the caller asks for it.
    expect(capturedOptions).toEqual({
      render: ["markdown"],
      views: ["input_form", "output_form"],
    });
    expect(result.structuredContent.status).toBe("ok");
    // Listed in tree path order, the order the tree is sent in.
    expect(result.structuredContent.files_sent).toEqual(["bundle-2.mthds", "bundle.mthds"]);
    // No views are advertised.
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
  });

  it("does not call the client when request validation fails", async () => {
    let called = false;

    const result = await validateMthds(
      {
        files: [],
      },
      {
        baseUrl: DEFAULT_API_URL,
        client: onTree(() => {
          called = true;
          return validReport;
        }),
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "files", reason: "missing" },
      location: { field: "files" },
    });
    expect(result.structuredContent.problem?.message).toContain("Provide a method folder");
    // The summary is the problem rendered: its title, detail, the workshop's
    // sentence, the next step and the code.
    expect(result.summary).toContain("## An argument was refused before sending");
    expect(result.summary).toContain("The argument 'files' was refused before any request left");
    expect(result.summary).toContain("Provide a method folder");
    expect(result.summary).toContain("**Next step** (`change_input`)");
    expect(result.summary).toContain("`client.argument_invalid`");
  });

  it("treats a reachable but malformed report as an unreadable answer, not unreachable", async () => {
    const malformedReport = {
      ...validReport,
      rendered_markdown: null,
    } as unknown as PipelexValidationReport;

    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: onTree(() => malformedReport),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      params: { status: 200 },
    });
    expect(result.structuredContent.problem?.message).toContain("The API answered");
    expect(result.summary).toContain("`client.response_unreadable`");
    expect(result.summary).not.toMatch(/unreachable/i);
  });

  it("relays an unreachable API as the SDK's client.unreachable, with the base URL note", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: onTree(() => {
          throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.unreachable",
      domain: "runtime",
      retry: "yes",
      params: { base_url: DEFAULT_API_URL },
    });
    expect(result.summary).toContain("## The runtime could not be reached");
    expect(result.summary).toContain(
      "The Pipelex API in use is the one PIPELEX_BASE_URL names, else the hosted Pipelex API.",
    );
  });

  it("relays an auth failure as the key, with the key note, never as an unreachable API", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }] },
      {
        baseUrl: DEFAULT_API_URL,
        apiNotes: { apiKey: "The API key came from the host's PIPELEX_API_KEY." },
        client: onTree(() => {
          throw new ApiResponseError(
            "HTTP 401",
            `${DEFAULT_API_URL}/v1/validate`,
            401,
            "Unauthorized",
            "{}",
            { headers: { "x-request-id": "req_auth" } },
          );
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "auth.missing_credential",
      domain: "account",
      retry: "no",
      request_id: "req_auth",
    });
    // The key, never the network: a user with no key must not be sent to
    // debug connectivity (L-260924-a58ae1).
    expect(result.summary).toContain("## No credential was sent");
    expect(result.summary).toContain("The API key came from the host's PIPELEX_API_KEY.");
    expect(result.summary).toContain("req_auth");
    expect(result.summary).not.toMatch(/unreachable/i);
  });
});

describe("validateMthds path submissions", () => {
  const resolver: FileResolver = {
    async resolve() {
      throw new Error("a { path } item is read as bytes, never as text");
    },
    async statMethodFile(path) {
      if (path === "methods/bundle.mthds") {
        return { ok: true, absolute: `/work/${path}`, relative: path, size: 15 };
      }
      return { ok: false, message: `File not found: ${path}`, remedy: "Check the path." };
    },
    async readMethodFile(path) {
      if (path === "methods/bundle.mthds") {
        return { ok: true, bytes: new TextEncoder().encode('domain = "demo"') };
      }
      return { ok: false, message: `File not found: ${path}`, remedy: "Check the path." };
    },
  };

  it("refuses a list of files holding no .mthds file without reading it or calling the API", async () => {
    let touched = 0;
    const untouchable: FileResolver = {
      resolve: () => Promise.reject(new Error("never read")),
      statMethodFile: () => {
        touched += 1;
        return Promise.reject(new Error("never stated"));
      },
      readMethodFile: () => {
        touched += 1;
        return Promise.reject(new Error("never read"));
      },
    };

    const result = await validateMthds(
      { files: [{ path: "finance/payroll.xlsx" }] },
      { baseUrl: DEFAULT_API_URL, resolver: untouchable, client: validateNotCalled },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "files", reason: "no_method_file" },
      location: { field: "files" },
    });
    expect(result.structuredContent.problem).not.toHaveProperty("errors");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
    expect(touched).toBe(0);
  });
  it("reads { path } items through the context resolver and sends them under their tree path", async () => {
    let captured: MethodTreeSource | undefined;

    const result = await validateMthds(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver,
        client: onTree((tree) => {
          captured = tree;
          return validReport;
        }),
      },
    );

    expect(await contentsOf(captured)).toEqual({ "bundle.mthds": 'domain = "demo"' });
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      files_sent: ["methods/bundle.mthds"],
    });
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    let called = false;

    const result = await validateMthds(
      { files: [{ path: "methods/bundle.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        client: onTree(() => {
          called = true;
          return validReport;
        }),
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "files[0].path", reason: "not_readable_here" },
      location: { field: "files[0].path" },
    });
    expect(result.structuredContent.problem?.message).toContain("npx @pipelex/mcp");
  });

  it("surfaces the hosted rejection message and its remedy into the content stream", async () => {
    // The desktop-host scenario: a { path } submission to the hosted console.
    // The instructive detail must reach the agent-facing `content`, not sit
    // only in structuredContent.problem where the agent had to guess from it.
    const result = await validateMthds(
      { files: [{ path: "methods/bundle.mthds" }] },
      { baseUrl: DEFAULT_API_URL },
    );

    const { content } = toolResult(result);
    const text = content[0]?.text ?? "";

    expect(text).toContain("## An argument was refused before sending");
    expect(text).toContain("field 'files[0].path'");
    expect(text).toContain("This deployment cannot read files from disk");
    expect(text).toContain("npx @pipelex/mcp");
    expect(text).toContain("`client.argument_invalid`");
  });

  it("does not call the client when resolution fails", async () => {
    let called = false;

    const result = await validateMthds(
      { files: [{ path: "missing.mthds" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver,
        client: onTree(() => {
          called = true;
          return validReport;
        }),
      },
    );

    expect(called).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    // The resolver's refusal, located at the item it refused.
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files[0].path" },
      location: { field: "files[0].path" },
    });
    expect(result.structuredContent.problem?.message).toMatch(
      /^File not found: missing\.mthds Check the path\./,
    );
  });
});

describe("validateMthds sends a method's tree", () => {
  const tempDirs: string[] = [];
  const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  /** A template check's finding, as the API sends it: one problem item. */
  const TEMPLATE_WARNING = {
    code: "pipelex.docgen.template_warning",
    detail: "The template reads {{ discount }}, which no input of the step provides.",
    params: {
      template_file: "templates/invoice.xlsx",
      template_location: "sheet Invoice, cell B7",
    },
    location: { pipe: "render_invoice" },
  };
  /** Key-shaped text assembled at run time, so no literal here looks like a key. None is real. */
  const fakeKey = ["plx_sk_", "f".repeat(32)].join("");

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  /** A bundle whose PipeDocGen step fills templates/invoice.xlsx. */
  const INVOICE_BUNDLE = [
    'domain = "invoice"',
    "",
    "[pipe.render_invoice]",
    'type = "PipeDocGen"',
    'description = "Fill the invoice workbook"',
    'inputs = { invoice = "Invoice" }',
    'output = "Document"',
    'template_file = "templates/invoice.xlsx"',
    "",
  ].join("\n");

  /** A working directory holding a bundle that fills a workbook, read through the real resolver. */
  async function bundleWithTemplate(): Promise<string> {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-validate-templates-")),
    );
    tempDirs.push(root);
    await fs.mkdir(path.join(root, "methods/invoice/templates"), { recursive: true });
    await fs.writeFile(path.join(root, "methods/invoice/invoice.mthds"), INVOICE_BUNDLE);
    await fs.writeFile(path.join(root, "methods/invoice/templates/invoice.xlsx"), XLSX);
    return root;
  }

  const BY_PATH = {
    files: [
      { path: "methods/invoice/invoice.mthds" },
      { path: "methods/invoice/templates/invoice.xlsx" },
    ],
  };

  it("sends { path } files as one tree, the template where its step's template_file leads, and relays the warnings", async () => {
    const root = await bundleWithTemplate();
    let captured: MethodTreeSource | undefined;

    const result = await validateMthds(BY_PATH, {
      baseUrl: DEFAULT_API_URL,
      resolver: localMethodFileResolver(root),
      saveRoot: root,
      client: onTree((tree) => {
        captured = tree;
        return { ...validReport, warnings: [TEMPLATE_WARNING] };
      }),
    });

    expect(captured?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "templates/invoice.xlsx",
    ]);
    expect(await captured?.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: true,
      warnings: [TEMPLATE_WARNING],
      files_sent: BY_PATH.files.map((item) => item.path),
      graph_page: { written: true },
    });
    // The graph page draws the method's text, never the workbook.
    const page = await fs.readFile(path.join(root, "methods/invoice", GRAPH_PAGE_FILENAME), "utf8");
    expect(page).toContain('"name":"invoice.mthds"');
    expect(page).not.toMatch(/"name":"[^"]*invoice\.xlsx"/);
  });

  it("sends a folder's PipeFunc module with its bundle, so the runner finds the function its step names", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-validate-pipefunc-")),
    );
    tempDirs.push(root);
    const module = "def capitalize(text):\n    return text.upper()\n";
    await fs.mkdir(path.join(root, "methods/text/funcs"), { recursive: true });
    await fs.writeFile(
      path.join(root, "methods/text/text.mthds"),
      [
        'domain = "text"',
        "",
        "[pipe.shout]",
        'type = "PipeFunc"',
        'description = "Capitalize the text"',
        'inputs = { text = "Text" }',
        'output = "Text"',
        'function_name = "funcs.text_utils.capitalize"',
        "",
      ].join("\n"),
    );
    await fs.writeFile(path.join(root, "methods/text/funcs/text_utils.py"), module);
    let captured: MethodTreeSource | undefined;

    const result = await validateMthds(
      { method_dir: "methods/text", graph_page: false },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: onTree((tree) => {
          captured = tree;
          return validReport;
        }),
      },
    );

    // The module rides the tree at the import path's file, where pipelex
    // looks for the function a PipeFunc step names.
    expect(captured?.files.map((file) => file.path)).toEqual(["funcs/text_utils.py", "text.mthds"]);
    expect(new TextDecoder().decode(await captured?.readFile("funcs/text_utils.py"))).toBe(module);
    expect(result.structuredContent.files_sent).toEqual([
      path.join("methods", "text", "funcs", "text_utils.py"),
      path.join("methods", "text", "text.mthds"),
    ]);
  });

  it("omits warnings from a valid verdict that has none", async () => {
    const root = await bundleWithTemplate();
    let captured: MethodTreeSource | undefined;

    const result = await validateMthds(
      { files: [{ path: "methods/invoice/invoice.mthds" }], graph_page: false },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: onTree((tree) => {
          captured = tree;
          return validReport;
        }),
      },
    );

    expect(captured?.files.map((file) => file.path)).toEqual(["invoice.mthds"]);
    expect(result.structuredContent).not.toHaveProperty("warnings");
  });

  it("roots the tree at the deepest directory holding every listed file", async () => {
    const root = await bundleWithTemplate();
    await fs.mkdir(path.join(root, "shared"));
    await fs.writeFile(path.join(root, "shared/invoice.xlsx"), XLSX);
    let captured: MethodTreeSource | undefined;

    const result = await validateMthds(
      { files: [{ path: "methods/invoice/invoice.mthds" }, { path: "shared/invoice.xlsx" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: onTree((tree) => {
          captured = tree;
          return validReport;
        }),
      },
    );

    expect(captured?.files.map((file) => file.path)).toEqual([
      "methods/invoice/invoice.mthds",
      "shared/invoice.xlsx",
    ]);
    expect(result.structuredContent.files_sent).toEqual([
      "methods/invoice/invoice.mthds",
      "shared/invoice.xlsx",
    ]);
  });

  it("refuses a listed file that is neither .mthds nor a template before calling the API", async () => {
    const root = await bundleWithTemplate();
    await fs.writeFile(path.join(root, "methods/invoice/notes.md"), "not readable here");

    const result = await validateMthds(
      { files: [...BY_PATH.files, { path: "methods/invoice/notes.md" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: validateNotCalled,
      },
    );

    // One fault, so the problem is that fault itself, never a list of one.
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files[2].path", reason: "wrong_extension" },
      location: { field: "files[2].path" },
    });
    expect(result.structuredContent.problem).not.toHaveProperty("errors");
    expect(result.structuredContent.problem?.message).toContain("method_dir");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
  });

  it("reads a method folder whole, lists what it sent, and draws the graph page into the folder", async () => {
    const root = await bundleWithTemplate();
    await fs.writeFile(path.join(root, "methods/invoice/notes.md"), "part of the method's tree");
    await fs.writeFile(path.join(root, "methods/invoice/.env"), "LEFT=out\n");
    let captured: MethodTreeSource | undefined;
    let capturedOptions: ValidateOptions | undefined;

    const result = await validateMthds(
      { method_dir: "methods/invoice" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        saveRoot: root,
        client: onTree((tree, options) => {
          captured = tree;
          capturedOptions = options;
          return validReport;
        }),
      },
    );

    const sent = [
      path.join("methods", "invoice", "invoice.mthds"),
      path.join("methods", "invoice", "notes.md"),
      path.join("methods", "invoice", "templates", "invoice.xlsx"),
    ];
    expect(await contentsOf(captured)).toMatchObject({
      "invoice.mthds": INVOICE_BUNDLE,
      "notes.md": "part of the method's tree",
    });
    expect(captured?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "notes.md",
      "templates/invoice.xlsx",
    ]);
    expect(captured?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(capturedOptions).toEqual({ render: ["markdown"], views: ["input_form", "output_form"] });
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: true,
      files_sent: sent,
      graph_page: { written: true },
    });
    expect(toolResult(result).content[0].text).toContain(`## Files sent`);
    await expect(
      fs.readFile(path.join(root, "methods/invoice", GRAPH_PAGE_FILENAME), "utf8"),
    ).resolves.toContain('"name":"invoice.mthds"');

    // The page it drew is no member the folder sends the next time.
    const again = await validateMthds(
      { method_dir: "methods/invoice", graph_page: false },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: onTree(() => validReport),
      },
    );
    expect(again.structuredContent.files_sent).toEqual(sent);
  });

  it("lists no file of a folder when the request never left the machine", async () => {
    const root = await bundleWithTemplate();

    // The client refuses the base URL as it is built.
    const unbuilt = await validateMthds(
      { method_dir: "methods/invoice", graph_page: false },
      { baseUrl: "invalid-no-scheme", resolver: localMethodFileResolver(root) },
    );
    expect(unbuilt.structuredContent.status).toBe("error");
    expect(unbuilt.structuredContent.problem).toMatchObject({
      code: "client.not_configured",
      params: { setting: "base_url" },
    });
    expect(unbuilt.structuredContent).not.toHaveProperty("files_sent");
    expect(toolResult(unbuilt).content[0].text).not.toContain("Files sent");

    // The SDK refuses an argument before sending.
    const refused = await validateMthds(
      { method_dir: "methods/invoice", graph_page: false },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: onTree(() => Promise.reject(new RequestArgumentError("refused before sending"))),
      },
    );
    expect(refused.structuredContent.status).toBe("error");
    expect(refused.structuredContent.problem?.code).toBe("client.argument_invalid");
    expect(refused.structuredContent).not.toHaveProperty("files_sent");

    // A request that left the machine lists them, whatever the failure.
    const unreachable = await validateMthds(
      { method_dir: "methods/invoice", graph_page: false },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: onTree(() =>
          Promise.reject(
            new ApiUnreachableError("connection reset", DEFAULT_API_URL, "ECONNRESET"),
          ),
        ),
      },
    );
    expect(unreachable.structuredContent.files_sent).toHaveLength(2);
  });

  it("refuses a folder holding no .mthds file at its top before calling the API, at method_dir", async () => {
    const root = await bundleWithTemplate();

    const result = await validateMthds(
      { method_dir: "methods" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "method_dir", reason: "no_method_file" },
      location: { field: "method_dir" },
    });
    expect(result.structuredContent).not.toHaveProperty("files_sent");
  });

  it("refuses an empty .mthds file in a folder before calling the API, naming it", async () => {
    const root = await bundleWithTemplate();
    await fs.writeFile(path.join(root, "methods/invoice/blank.mthds"), "  \n");

    const result = await validateMthds(
      { method_dir: "methods/invoice", graph_page: false },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_dir", reason: "empty_bundle" },
      location: { field: "method_dir" },
    });
    // The workshop's sentence opens the message, its remedy closing it.
    expect(String(result.structuredContent.problem?.message)).toMatch(
      new RegExp(
        `^${path.join("methods", "invoice", "blank.mthds").replace(/\./g, "\\.")} is empty\\. \\S`,
      ),
    );
    expect(result.structuredContent).not.toHaveProperty("files_sent");
  });

  it("refuses method_dir beside method_id, one selector on a tooling tool", async () => {
    const result = await validateMthds(
      { method_dir: "methods/invoice", method_id: "mt_abc123" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver("/nonexistent-root"),
        client: validateNotCalled,
      },
    );

    // The one fault, the selector beside the folder, located at method_id.
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
    expect(result.structuredContent.problem).not.toHaveProperty("errors");
  });

  it("refuses a folder holding a key before anything is sent, naming the file and never the key", async () => {
    const root = await bundleWithTemplate();
    await fs.mkdir(path.join(root, "methods/invoice/funcs"));
    await fs.writeFile(path.join(root, "methods/invoice/funcs/client.py"), `KEY = "${fakeKey}"\n`);
    let asked = false;

    const result = await validateMthds(
      { method_dir: "methods/invoice" },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        saveRoot: root,
        client: {
          async validate() {
            asked = true;
            return validReport;
          },
          async methodTreeLimits() {
            return { maxFileCount: 1000 };
          },
        } as ValidationClient,
      },
    );

    expect(asked).toBe(false);
    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "method_dir", reason: SECRET_REASON },
      location: { field: "method_dir" },
    });
    expect(result.structuredContent.problem).not.toHaveProperty("errors");
    expect(result.structuredContent.problem?.message).toContain(
      path.join("methods", "invoice", "funcs", "client.py"),
    );
    expect(result.structuredContent.problem?.message).toContain("nothing was sent");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("refuses a listed file holding a key, at its item, before anything is sent", async () => {
    const root = await bundleWithTemplate();
    await fs.writeFile(path.join(root, "methods/invoice/templates/cert.html"), `${fakeKey}\n`);

    const result = await validateMthds(
      { files: [...BY_PATH.files, { path: "methods/invoice/templates/cert.html" }] },
      {
        baseUrl: DEFAULT_API_URL,
        resolver: localMethodFileResolver(root),
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files[2].path", reason: SECRET_REASON },
      location: { field: "files[2].path" },
    });
    expect(result.structuredContent.problem).not.toHaveProperty("errors");
    expect(result.structuredContent.problem?.message).toContain(
      "methods/invoice/templates/cert.html",
    );
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });
});

describe("validateMthds by selector (server pass-through)", () => {
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

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
      `${DEFAULT_API_URL}/v1/validate`,
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

  /** A context whose selector leg throws `err`. */
  function refusing(err: unknown): ValidationContext {
    return {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(): Promise<PipelexValidationResult> {
          throw err;
        },
      },
    };
  }

  it("forwards method_id to the validate route as a selector — nothing expanded client-side", async () => {
    let capturedSource: PipelexValidateSource | undefined;
    let capturedArgs: unknown[] | undefined;

    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
          async validate(source, allowSignatures, options) {
            capturedSource = source;
            capturedArgs = [allowSignatures, options];
            return validReport;
          },
        },
      },
    );

    expect(capturedSource).toEqual({ method_id: "mt_123" });
    // allowSignatures on; the server labels diagnostics from the stored
    // method's real file names; the descriptor opt-in rides `views`, beside
    // the markdown render every arm asks for.
    expect(capturedArgs).toEqual([
      true,
      { render: ["markdown"], views: ["input_form", "output_form"] },
    ]);
    expect(result.structuredContent.status).toBe("ok");
  });

  it("forwards method_ref to the validate route as a selector", async () => {
    let capturedSource: PipelexValidateSource | undefined;

    const result = await validateMthds(
      { method_ref: ADDRESS },
      {
        baseUrl: DEFAULT_API_URL,
        client: {
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
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
  });

  it("rejects files + method_ref", async () => {
    const result = await validateMthds(
      { files: [{ content: 'domain = "demo"' }], method_ref: ADDRESS },
      {
        baseUrl: DEFAULT_API_URL,
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "method_ref", reason: "mutually_exclusive" },
      location: { field: "method_ref" },
    });
  });

  it("rejects method_ref + method_id", async () => {
    const result = await validateMthds(
      { method_ref: ADDRESS, method_id: "mt_123" },
      {
        baseUrl: DEFAULT_API_URL,
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      params: { argument: "method_id", reason: "mutually_exclusive" },
      location: { field: "method_id" },
    });
  });

  it("rejects a blank method_ref at method_ref", async () => {
    const result = await validateMthds(
      { method_ref: "   " },
      {
        baseUrl: DEFAULT_API_URL,
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "method_ref", reason: "empty" },
      location: { field: "method_ref" },
    });
  });

  it("relays an unknown method id (404) as the platform's problem, unchanged", async () => {
    const err = refusal(404, {
      code: "pipelex.catalog.not_found",
      title: "Method not found",
      detail: "No method mt_missing belongs to this organization.",
      domain: "input",
      location: { field: "method_id" },
    });

    const result = await validateMthds({ method_id: "mt_missing" }, refusing(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.catalog.not_found",
      domain: "input",
      retry: "no",
      location: { field: "method_id" },
      request_id: "req_404",
    });
    expect(result.summary).toContain("## Method not found");
    expect(result.summary).toContain("No method mt_missing belongs to this organization.");
    expect(result.summary).toContain("`pipelex.catalog.not_found`");
    expect(result.summary).toContain("req_404");
  });

  it("relays a by-id 422 (a deployment without the selector) as the API's problem, unchanged", async () => {
    const err = refusal(422, {
      code: "request.invalid",
      title: "The request was refused",
      detail: "The field 'method_id' is not one this route accepts.",
      domain: "input",
      location: { field: "method_id" },
    });

    const result = await validateMthds({ method_id: "mt_123" }, refusing(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "request.invalid",
      domain: "input",
      location: { field: "method_id" },
    });
  });

  it("relays a method_ref fetch 422 and a no-package 404 as the runner's problems, unchanged", async () => {
    for (const [status, code] of [
      [422, "method.fetch_failed"],
      [404, "method.not_found"],
    ] as const) {
      const err = refusal(status, {
        code,
        title: "The method could not be resolved",
        detail: `${ADDRESS} could not be resolved.`,
        domain: "input",
      });

      const result = await validateMthds({ method_ref: ADDRESS }, refusing(err));

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toEqual(problemOf(err));
      expect(result.structuredContent.problem).toMatchObject({
        code,
        domain: "input",
        retry: "no",
      });
    }
  });

  it("relays the structures refusal as the method's own problem, never an auth failure, and marks it refused for its Python", async () => {
    const err = refusal(422, {
      code: "pipelex.deployment.python_structures_refused",
      title: "The method's Python declares structure classes",
      detail:
        "Hosted execution accepts MTHDS concepts and sandboxed PipeFuncs, not in-process Python structure classes.",
      domain: "input",
    });

    const result = await validateMthds({ method_ref: ADDRESS }, refusing(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem?.domain).toBe("input");
    // The execution-locus gate, read by its code: the save stores such a
    // method as an unvalidated draft rather than refuse it.
    expect(result.refusedForPython).toBe(true);
    expect(result.summary).toContain("MTHDS concepts");
    expect(result.summary).not.toContain("The API key is read from PIPELEX_API_KEY.");
  });

  it("relays the sandbox refusal as the method's own problem, never an auth failure, and marks it refused for its Python", async () => {
    const err = refusal(501, {
      code: "pipelex.deployment.custom_code_requires_sandbox",
      title: "Custom code needs a sandbox-hosted deployment",
      detail:
        "This bundle ships custom Python (.py); running it requires a sandbox-hosted deployment.",
      domain: "input",
      params: { origin: "method_ref" },
    });

    const result = await validateMthds({ method_ref: ADDRESS }, refusing(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.deployment.custom_code_requires_sandbox",
      domain: "input",
      params: { origin: "method_ref" },
    });
    expect(result.refusedForPython).toBe(true);
    expect(result.summary).toContain("sandbox-hosted");
    expect(result.summary).not.toContain("The API key is read from PIPELEX_API_KEY.");
  });

  it("relays a registry-form method_ref refusal as the runner's request.unsupported, unchanged", async () => {
    const err = refusal(422, {
      code: "request.unsupported",
      title: "The request asks for something this runtime does not support",
      detail: "A registry-form method_ref is reserved; no registry here resolves it.",
      domain: "input",
      params: { reason: "registry_form_method_ref" },
      location: { field: "method_ref" },
    });

    const result = await validateMthds({ method_ref: "some-registry/method" }, refusing(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "request.unsupported",
      params: { reason: "registry_form_method_ref" },
      location: { field: "method_ref" },
    });
    expect(result.summary).toContain("field 'method_ref'");
  });

  it("relays a paywall (402) on the selector leg as the platform's plan problem, unchanged", async () => {
    const err = refusal(402, {
      code: "pipelex.billing.plan_limit",
      title: "The organization's plan does not cover this call",
      detail: "Validating a saved method needs a plan that includes the catalog.",
      domain: "account",
      next_step: {
        kind: "contact_owner",
        detail: "Ask the organization's owner to change its plan.",
      },
    });

    const result = await validateMthds({ method_id: "mt_123" }, refusing(err));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(problemOf(err));
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.billing.plan_limit",
      domain: "account",
      retry: "no",
    });
    // The plan, never the network.
    expect(result.summary).toContain("## The organization's plan does not cover this call");
    expect(result.summary).toContain("**Next step** (`contact_owner`)");
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("relays a malformed base URL on the selector leg as client.not_configured, with the base URL note", async () => {
    const result = await validateMthds(
      { method_id: "mt_123" },
      {
        baseUrl: `${DEFAULT_API_URL}/v1`,
        apiNotes: { baseUrl: "The base URL came from the host's PIPELEX_BASE_URL." },
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.not_configured",
      params: { setting: "base_url" },
    });
    expect(result.summary).toContain("The base URL came from the host's PIPELEX_BASE_URL.");
  });

  it("rejects a request with no selector at all", async () => {
    const result = await validateMthds(
      {},
      {
        baseUrl: DEFAULT_API_URL,
        client: validateNotCalled,
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "files", reason: "missing" },
      location: { field: "files" },
    });
  });
});

describe("the method graph page", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  /** A working directory holding the bundle, and a context that validates and writes under it. */
  async function workshopContext(
    client: ValidationClient,
  ): Promise<{ root: string; context: ValidationContext }> {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-validate-page-")),
    );
    tempDirs.push(root);
    await fs.mkdir(path.join(root, "methods/demo"), { recursive: true });
    await fs.writeFile(path.join(root, "methods/demo/bundle.mthds"), 'domain = "demo"', "utf8");
    return {
      root,
      context: {
        baseUrl: DEFAULT_API_URL,
        client,
        resolver: localMethodFileResolver(root),
        saveRoot: root,
      },
    };
  }

  function answering(report: PipelexValidationResult): ValidationClient {
    return onTree(() => report);
  }

  const PAGE = path.join("methods", "demo", GRAPH_PAGE_FILENAME);
  const BY_PATH = { files: [{ path: "methods/demo/bundle.mthds" }] };

  async function pageExists(root: string): Promise<boolean> {
    return fs.stat(path.join(root, PAGE)).then(
      () => true,
      () => false,
    );
  }

  it("writes the page beside { path } files and reports it after the verdict", async () => {
    const { root, context } = await workshopContext(answering(validReport));

    const result = toolResult(await validateMthds(BY_PATH, context));

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      is_valid: true,
      graph_page: { path: PAGE, written: true },
    });
    expect(result.structuredContent.graph_page).not.toHaveProperty("created");
    const [block] = result.content;
    // The files sent come before the page, which is the call's own output.
    expect(block.text).toContain(
      `# Valid${MAIN_PIPE_NOTE}\n\n## Files sent\n\nThe method's tree, every file this call sent and nothing else:\n\n- \`methods/demo/bundle.mthds\`\n\n## Method graph\n\nWrote`,
    );
    const page = await fs.readFile(path.join(root, PAGE), "utf8");
    expect(page).toContain(GRAPH_PAGE_MARK);
    expect(page).toContain('"name":"bundle.mthds"');
  });

  it("says a rewritten page is a rewrite", async () => {
    const { context } = await workshopContext(answering(validReport));
    await validateMthds(BY_PATH, context);

    const result = toolResult(await validateMthds(BY_PATH, context));

    expect(result.content[0].text).toContain("## Method graph\n\nRewrote");
  });

  it("writes it on an invalid verdict, which the page draws with its notes", async () => {
    const { root, context } = await workshopContext(answering(invalidReport));

    const result = await validateMthds(BY_PATH, context);

    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: false,
      graph_page: { written: true },
    });
    expect(await pageExists(root)).toBe(true);
  });

  it("writes it when the API produced no verdict, and reports it after the errors", async () => {
    const { root, context } = await workshopContext({
      async validate() {
        throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
      },
    });

    const result = toolResult(await validateMthds(BY_PATH, context));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "error",
      graph_page: { path: PAGE, written: true },
    });
    const text = result.content[0].text;
    expect(text.indexOf("## The runtime could not be reached")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("## The runtime could not be reached")).toBeLessThan(
      text.indexOf("## Method graph"),
    );
    expect(await pageExists(root)).toBe(true);
  });

  it("keeps the verdict when the page cannot be written, and says why", async () => {
    const { root, context } = await workshopContext(answering(validReport));
    await fs.writeFile(path.join(root, PAGE), "somebody else's page", "utf8");

    const result = toolResult(await validateMthds(BY_PATH, context));

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      is_valid: true,
      graph_page: {
        path: PAGE,
        written: false,
        error: {
          code: "client.target_exists",
          domain: "input",
          params: { path: PAGE },
          location: { field: "graph_page" },
        },
      },
    });
    // A full caller-view problem at that member, which never becomes the call's.
    expect(result.structuredContent.graph_page?.error?.message).toContain("left untouched");
    expect(result.structuredContent).not.toHaveProperty("problem");
    expect(result.structuredContent).not.toHaveProperty("errors");
    expect(result.content[0].text).toContain("the verdict above stands");
    expect(result.content[0].text).toContain("(`client.target_exists`)");
    expect(await fs.readFile(path.join(root, PAGE), "utf8")).toBe("somebody else's page");
  });

  it("claims no verdict when neither the API nor the page produced anything", async () => {
    const { root, context } = await workshopContext({
      async validate() {
        throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
      },
    });
    await fs.writeFile(path.join(root, PAGE), "somebody else's page", "utf8");

    const result = toolResult(await validateMthds(BY_PATH, context));

    expect(result.structuredContent).toMatchObject({
      status: "error",
      graph_page: { path: PAGE, written: false },
    });
    const text = result.content[0].text;
    const section = text.slice(text.indexOf("## Method graph"));
    expect(section).toContain("the result above is unaffected");
    expect(section).not.toContain("verdict");
  });

  it("writes nothing when the caller opts out", async () => {
    const { root, context } = await workshopContext(answering(validReport));

    const result = await validateMthds({ ...BY_PATH, graph_page: false }, context);

    expect(result.structuredContent.graph_page).toBeUndefined();
    expect(result.graphPage).toBeUndefined();
    expect(await pageExists(root)).toBe(false);
  });

  it("writes nothing for inline files, or a bundle only partly given as paths", async () => {
    const { root, context } = await workshopContext(answering(validReport));

    const inline = await validateMthds({ files: [{ content: 'domain = "demo"' }] }, context);
    const mixed = await validateMthds(
      { files: [...BY_PATH.files, { content: 'domain = "demo"', uri: "extra.mthds" }] },
      context,
    );

    expect(inline.structuredContent.graph_page).toBeUndefined();
    expect(mixed.structuredContent.graph_page).toBeUndefined();
    expect(await fs.readdir(root)).toEqual(["methods"]);
    expect(await pageExists(root)).toBe(false);
  });

  it("writes nothing from a context without a save root — the save's validation leg", async () => {
    const { root, context } = await workshopContext(answering(validReport));

    const result = await validateMthds(BY_PATH, { ...context, saveRoot: undefined });

    expect(result.structuredContent.graph_page).toBeUndefined();
    expect(await pageExists(root)).toBe(false);
  });

  it("writes nothing for a request refused before the API call", async () => {
    const { root, context } = await workshopContext(validateNotCalled);

    const result = await validateMthds({ ...BY_PATH, method_id: "mt_demo" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.graph_page).toBeUndefined();
    expect(await pageExists(root)).toBe(false);
  });
});

describe("validateMthds by method_id, on both platforms", () => {
  function onPlatform(
    extensions: string[] | Error,
    sent: PipelexValidateSource[],
    answer: PipelexValidationResult | Error = validReport,
  ): ValidationContext {
    return {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(source) {
          sent.push(source);
          if (answer instanceof Error) throw answer;
          return answer;
        },
        async version() {
          if (extensions instanceof Error) throw extensions;
          return { version: "1.0.0", extensions };
        },
      },
    };
  }

  it("sends each selector as given where versions resolve, and says what it validated", async () => {
    const sent: PipelexValidateSource[] = [];
    const supported = ["runs", "method_versions"];

    const bare = await validateMthds({ method_id: "mt_123" }, onPlatform(supported, sent));
    const drafted = await validateMthds({ method_id: "mt_123@draft" }, onPlatform(supported, sent));
    const pinned = await validateMthds({ method_id: "mt_123@2" }, onPlatform(supported, sent));

    expect(sent).toEqual([
      { method_id: "mt_123" },
      { method_id: "mt_123@draft" },
      { method_id: "mt_123@2" },
    ]);
    expect(bare.structuredContent.method_version).toBe("latest");
    expect(drafted.structuredContent.method_version).toBe("draft");
    expect(pinned.structuredContent.method_version).toBe(2);
    expect(pinned.summary).toContain("This validated version 2 of `mt_123`.");
  });

  it("sends a bare id without waiting on the handshake, and still says what it validated", async () => {
    // Nothing sent depends on the platform's answer. Awaited first, it cost
    // every bare-id call a handshake, up to its deadline where the platform
    // does not resolve versions and so never caches its answer.
    const sent: PipelexValidateSource[] = [];
    let answer: (info: unknown) => void = () => undefined;
    const context: ValidationContext = {
      baseUrl: DEFAULT_API_URL,
      client: {
        async validate(source) {
          sent.push(source);
          return validReport;
        },
        version() {
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      },
    };

    const result = validateMthds({ method_id: "mt_123" }, context);
    await vi.waitFor(() => expect(sent).toEqual([{ method_id: "mt_123" }]));
    answer({ version: "1.0.0", extensions: ["runs"] });

    expect((await result).structuredContent.method_version).toBe("draft");
  });

  it("reads the draft for a bare id where they do not, and sends every suffix as given", async () => {
    const sent: PipelexValidateSource[] = [];

    const bare = await validateMthds({ method_id: "mt_123" }, onPlatform(["runs"], sent));
    const drafted = await validateMthds({ method_id: "mt_123@draft" }, onPlatform(["runs"], sent));
    const pinned = await validateMthds({ method_id: "mt_123@2" }, onPlatform(["runs"], sent));

    // A platform that cannot read a suffix refuses it; rewritten on a stale
    // answer, @draft sent bare would read the latest published version.
    expect(sent).toEqual([
      { method_id: "mt_123" },
      { method_id: "mt_123@draft" },
      { method_id: "mt_123@2" },
    ]);
    expect(bare.structuredContent.method_version).toBe("draft");
    expect(drafted.structuredContent.method_version).toBe("draft");
    expect(pinned.structuredContent.method_version).toBe(2);
  });

  it("sends a suffix as given when it cannot ask, and reads a refusal of it as a platform that may not resolve it", async () => {
    const sent: PipelexValidateSource[] = [];
    // The platform's miss of an id it looked up literally.
    const notFound = new ApiResponseError(
      "HTTP 404",
      `${DEFAULT_API_URL}/v1/validate`,
      404,
      "Not Found",
      JSON.stringify({
        type: "https://mthds.ai/errors/pipelex.catalog.not_found",
        title: "Method not found",
        status: 404,
        detail: "No method mt_123@draft belongs to this organization.",
        code: "pipelex.catalog.not_found",
        domain: "input",
        retry: "no",
        next_step: { kind: "change_input", detail: "Pick a method the catalog lists." },
        location: { field: "method_id" },
      }),
    );

    const result = await validateMthds(
      { method_id: "mt_123@draft" },
      onPlatform(new Error("down"), sent, notFound),
    );

    expect(sent).toEqual([{ method_id: "mt_123@draft" }]);
    // The platform's problem, its code and location kept, with the selector
    // note in the workshop's sentence, which the summary renders.
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.catalog.not_found",
      location: { field: "method_id" },
    });
    expect(result.structuredContent.problem?.message).toContain(
      "may have refused `mt_123@draft` because it does not resolve version suffixes yet",
    );
    expect(result.summary).toContain("does not resolve version suffixes yet");
  });
});
