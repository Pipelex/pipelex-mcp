import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  InputForm,
  OutputForm,
  PipeIOContracts,
  PipelexInvalidReport,
  PipelexValidationReport,
  PipelexValidationResult,
  ValidateMethodSelector,
} from "@pipelex/sdk";
import { projectInputsTemplate, renderInputsTemplate } from "mthds/protocol";

import { DEFAULT_API_URL } from "./shared.js";
import { showPipelexMethod, showResult, showToolResult, validateShowRequest } from "./show.js";
import type { ShowClient, ShowContext } from "./show.js";

// Two pipes, so a named pipe_ref has somewhere to go: the entry pipe takes a
// text and an image, the other one a text alone.
const contracts: PipeIOContracts = {
  "demo.main": {
    inputs: {
      topic: {
        concept_ref: "native.Text",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: { type: "string" },
      },
      photo: {
        concept_ref: "native.Image",
        presence: "plain",
        multiplicity: "single",
        item_count: null,
        json_schema: { type: "object" },
      },
    },
    output: {
      concept_ref: "native.Text",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: { type: "object" },
    },
  },
  "demo.other": {
    inputs: {
      note: {
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
      json_schema: { type: "object" },
    },
  },
};

const inputForm: InputForm = {
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
      {
        name: "photo",
        kind: "image",
        concept_ref: "native.Image",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
  "demo.other": {
    fields: [
      {
        name: "note",
        kind: "prose",
        concept_ref: "native.Text",
        required: true,
        presence: "plain",
        gating: true,
      },
    ],
  },
};

const outputForm: OutputForm = {
  "demo.main": {
    field: { name: "output", kind: "prose", concept_ref: "native.Text", required: true },
  },
  "demo.other": {
    field: { name: "output", kind: "prose", concept_ref: "native.Text", required: true },
  },
};

const GRAPH = { nodes: [{ id: "demo.main" }] };

const validReport: PipelexValidationReport = {
  is_valid: true,
  bundle_blueprint: { domain: "demo", main_pipe: "main" },
  pipe_io_contracts: contracts,
  input_form: inputForm,
  output_form: outputForm,
  graph_spec: GRAPH,
  validated_pipes: [],
  pending_signatures: [],
  liftable_pipes: [],
  warnings: [],
  is_runnable: true,
  message: "ok",
};

const pendingReport: PipelexValidationReport = {
  ...validReport,
  pending_signatures: ["demo.todo"],
  is_runnable: false,
};

const invalidReport: PipelexInvalidReport = {
  is_valid: false,
  is_runnable: false,
  pending_signatures: [],
  message: "invalid",
  validation_errors: [
    { category: "blueprint_validation", message: "Unknown pipe type", source: "bundle.mthds" },
  ],
};

const PUBLISHED_REF = "github.com/Pipelex/methods/documents@v0.1.0";

interface ValidateCall {
  source: string[] | ValidateMethodSelector;
  allowSignatures?: boolean;
  render?: string[];
  views?: string[];
}

function contextAnswering(answer: () => Promise<PipelexValidationResult>): {
  context: ShowContext;
  calls: ValidateCall[];
} {
  const calls: ValidateCall[] = [];
  const client: ShowClient = {
    async validate(source, allowSignatures, _mthdsSources, render, views) {
      calls.push({ source, allowSignatures, render, views });
      return answer();
    },
  };
  return { context: { baseUrl: DEFAULT_API_URL, client }, calls };
}

function apiError(status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/validate`,
    status,
    "Error",
    "{}",
    "error",
    message,
    undefined,
    undefined,
  );
}

describe("showPipelexMethod", () => {
  it("asks /v1/validate for the graph and both forms, by the selector it was given", async () => {
    const { context, calls } = contextAnswering(async () => validReport);

    await showPipelexMethod({ method_id: "mt_demo" }, context);
    await showPipelexMethod({ method_ref: PUBLISHED_REF }, context);

    expect(calls).toEqual([
      {
        source: { method_id: "mt_demo" },
        allowSignatures: true,
        render: undefined,
        views: ["input_form", "output_form"],
      },
      {
        source: { method_ref: PUBLISHED_REF },
        allowSignatures: true,
        render: undefined,
        views: ["input_form", "output_form"],
      },
    ]);
  });

  it("hands the model a runnable method's signature and template, and the view its artifacts", async () => {
    const { context } = contextAnswering(async () => validReport);

    const result = showToolResult(await showPipelexMethod({ method_id: "mt_demo" }, context));
    const content = result.structuredContent;

    expect(content.status).toBe("ok");
    expect(content.method_id).toBe("mt_demo");
    expect(content).not.toHaveProperty("method_ref");
    expect(content.is_valid).toBe(true);
    expect(content.is_runnable).toBe(true);
    expect(content.pipe_ref).toBe("demo.main");
    expect(content.main_pipe?.pipe_ref).toBe("demo.main");
    expect(content.main_pipe?.inputs.map((slot) => slot.name)).toEqual(["topic", "photo"]);
    // The template is the standard's own projection of the pipe's descriptor.
    expect(content.inputs).toEqual(
      JSON.parse(
        JSON.stringify(projectInputsTemplate(inputForm["demo.main"]!, { explicit: true })),
      ),
    );
    expect(Object.keys(content.inputs ?? {})).toEqual(["topic", "photo"]);
    expect(content.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
    expect(result.isError).toBe(false);

    // The view reads exactly the keys `mthds_validate` fed it on.
    expect(result._meta).toEqual({
      graph_spec: GRAPH,
      pipe_io_contracts: contracts,
      input_form: inputForm,
      output_form: outputForm,
      main_pipe_ref: "demo.main",
      form_pipe_ref: "demo.main",
    });
    // None of it reaches the model's contract.
    expect(JSON.stringify(content)).not.toContain("json_schema");
  });

  it("says, in the summary, the signature, the template and who goes first", async () => {
    const { context } = contextAnswering(async () => validReport);

    const { summary } = await showPipelexMethod({ method_id: "mt_demo" }, context);

    expect(summary).toContain("## Signature");
    expect(summary).toContain("demo.main(");
    // The template in a fenced block, spelled by the standard's own writer.
    const templateText = renderInputsTemplate(inputForm["demo.main"]!, {
      explicit: true,
      format: "json",
    });
    expect(summary).toContain(`\`\`\`json\n${templateText}\n\`\`\``);
    // Who goes first: a user who already gave the values gets the run now;
    // otherwise the model stops, and the instructions say whether a form shows.
    expect(summary).toContain("## Who goes first");
    expect(summary).toContain(
      "If the user already gave you the input values, fill the template with them and call `pipelex_run` now, with method_id `mt_demo`, pipe_ref `demo.main`.",
    );
    expect(summary).toContain("Otherwise stop here and let the user choose.");
    expect(summary).toContain("the server instructions say whether it does");
    expect(summary).toContain("the method would run twice");
    expect(summary).not.toContain("mthds_");
  });

  it("echoes an address, and names it in the run it suggests", async () => {
    const { context } = contextAnswering(async () => validReport);

    const result = await showPipelexMethod({ method_ref: PUBLISHED_REF }, context);

    expect(result.structuredContent.method_ref).toBe(PUBLISHED_REF);
    expect(result.structuredContent).not.toHaveProperty("method_id");
    expect(result.summary).toContain(`method_ref \`${PUBLISHED_REF}\``);
  });

  it("shows the pipe the caller named, template and all", async () => {
    const { context } = contextAnswering(async () => validReport);

    const result = await showPipelexMethod(
      { method_id: "mt_demo", pipe_ref: "demo.other" },
      context,
    );

    expect(result.structuredContent.pipe_ref).toBe("demo.other");
    expect(result.structuredContent.main_pipe?.pipe_ref).toBe("demo.other");
    expect(Object.keys(result.structuredContent.inputs ?? {})).toEqual(["note"]);
    // The form opens on the named pipe; the entry pipe stays the method's own,
    // so the view never calls the named pipe the entry pipe.
    expect(result.formPipeRef).toBe("demo.other");
    expect(result.mainPipeRef).toBe("demo.main");
    expect(result.summary).toContain("pipe_ref `demo.other`");
  });

  it("refuses a bare or an unknown pipe_ref, naming the pipes the method declares", async () => {
    const { context } = contextAnswering(async () => validReport);

    for (const pipeRef of ["main", "demo.nope"]) {
      const result = await showPipelexMethod({ method_id: "mt_demo", pipe_ref: pipeRef }, context);

      expect(result.structuredContent.status).toBe("error");
      const error = result.structuredContent.errors?.[0];
      expect(error?.class).toBe("input_domain");
      expect(error?.location).toBe("pipe_ref");
      expect(error?.message).toContain("demo.main, demo.other");
    }
  });

  it("refuses a bare pipe_ref even when the report carries no contracts", async () => {
    // An older runner sends no pipe_io_contracts, so membership cannot be
    // checked; a bare ref is still refused, since pipelex_run always refuses one.
    const { pipe_io_contracts: _dropped, ...legacyReport } = validReport as unknown as Record<
      string,
      unknown
    >;
    const { context } = contextAnswering(async () => legacyReport as PipelexValidationReport);

    const bare = await showPipelexMethod({ method_id: "mt_demo", pipe_ref: "main" }, context);
    const qualified = await showPipelexMethod(
      { method_id: "mt_demo", pipe_ref: "demo.main" },
      context,
    );

    expect(bare.structuredContent.errors?.[0]?.location).toBe("pipe_ref");
    expect(qualified.structuredContent.status).toBe("ok");
  });

  it("reports a pending-signature method as not runnable, with no template and no form", async () => {
    const { context } = contextAnswering(async () => pendingReport);

    const result = showToolResult(await showPipelexMethod({ method_id: "mt_demo" }, context));
    const content = result.structuredContent;

    expect(content.status).toBe("ok");
    expect(content.is_valid).toBe(true);
    expect(content.is_runnable).toBe(false);
    expect(content.pending_signatures).toEqual(["demo.todo"]);
    expect(content).not.toHaveProperty("inputs");
    // The graph still shows; the form does not.
    expect(content.available_view_specs).toEqual(["dry_run_graph"]);
    expect(result._meta.input_form).toBeUndefined();
    expect(result._meta.pipe_io_contracts).toBeUndefined();
    const summary = result.content[0]?.text ?? "";
    expect(summary).toContain("cannot run yet");
    expect(summary).toContain("`demo.todo`");
    expect(summary).not.toContain("```json");
    expect(summary).not.toContain("Who goes first");
  });

  it("reports a method that does not validate as not runnable, with the reason", async () => {
    const { context } = contextAnswering(async () => invalidReport);

    const result = await showPipelexMethod({ method_id: "mt_demo" }, context);
    const content = result.structuredContent;

    // A produced verdict, not an error: the method was shown, and it is broken.
    expect(content.status).toBe("ok");
    expect(content.is_valid).toBe(false);
    expect(content.is_runnable).toBe(false);
    expect(content.validation_errors).toEqual(invalidReport.validation_errors);
    expect(content).not.toHaveProperty("pipe_ref");
    expect(content).not.toHaveProperty("inputs");
    expect(content.available_view_specs).toEqual([]);
    expect(result.summary).toContain("does not validate");
    expect(result.summary).toContain("Unknown pipe type");
    expect(result.graphSpec).toBeUndefined();
  });

  it("asks for a pipe_ref when the method settles no entry pipe", async () => {
    const { context } = contextAnswering(async () => ({
      ...validReport,
      default_pipe_ref: null,
    }));

    const result = await showPipelexMethod({ method_id: "mt_demo" }, context);

    expect(result.structuredContent.is_runnable).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("pipe_ref");
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("Call `pipelex_show_method` again with pipe_ref");
    expect(result.summary).toContain("`demo.main`, `demo.other`");
  });

  it("classifies an id the organization cannot see as input_domain at method_id", async () => {
    const { context } = contextAnswering(async () => {
      throw apiError(404, "not found");
    });

    const result = await showPipelexMethod({ method_id: "mt_missing" }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toContain("pipelex_list_methods");
    expect(result.summary).toBe("The method was not shown: the Pipelex API rejected the request.");
  });

  it("classifies an unresolvable address at method_ref", async () => {
    const { context } = contextAnswering(async () => {
      throw apiError(422, "no such tag");
    });

    const result = await showPipelexMethod({ method_ref: PUBLISHED_REF }, context);

    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("classifies an unreachable API as config", async () => {
    const { context } = contextAnswering(async () => {
      throw new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED");
    });

    const result = await showPipelexMethod({ method_id: "mt_demo" }, context);

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toContain("unreachable or misconfigured");
  });

  it("refuses a malformed request before any call", async () => {
    const { context, calls } = contextAnswering(async () => validReport);

    const neither = await showPipelexMethod({}, context);
    const both = await showPipelexMethod(
      { method_id: "mt_demo", method_ref: PUBLISHED_REF },
      context,
    );

    expect(neither.structuredContent.status).toBe("error");
    expect(neither.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(both.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(calls).toEqual([]);
  });
});

describe("validateShowRequest", () => {
  it("refuses a blank pipe_ref and a blank selector", () => {
    expect(validateShowRequest({ method_id: "mt_demo", pipe_ref: "  " })[0]?.location).toBe(
      "pipe_ref",
    );
    expect(validateShowRequest({ method_id: " " })[0]?.location).toBe("method_id");
    expect(validateShowRequest({ method_ref: "" })[0]?.location).toBe("method_ref");
  });

  it("names no file argument in any refusal: the console takes none", () => {
    const errors = [
      ...validateShowRequest({}),
      ...validateShowRequest({ method_id: "mt_demo", method_ref: PUBLISHED_REF }),
      ...validateShowRequest({ method_id: " " }),
    ];

    for (const error of errors) {
      expect(`${error.message} ${error.hint ?? ""}`).not.toMatch(/\bfiles\b/);
    }
  });
});

describe("showResult", () => {
  it("withholds the template when the descriptor for the pipe is missing", () => {
    const report: PipelexValidationReport = { ...validReport, input_form: {} };

    const result = showResult(report, { method_id: "mt_demo" });

    expect(result.structuredContent.is_runnable).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("No template could be projected");
  });
});
