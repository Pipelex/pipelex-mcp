import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError } from "@pipelex/sdk";
import type {
  CrateInvalidReport,
  InputForm,
  OutputForm,
  PipeIOContracts,
  PipeIORequest,
  PipeIOResponse,
  PipeIOValidReport,
} from "@pipelex/sdk";
import {
  buildStaticGraphSpec,
  mergeBundles,
  parseMthdsBundle,
} from "@pipelex/mthds-ui/static-graph";
import { projectInputsTemplate, renderInputsTemplate } from "mthds/protocol";

import { DEFAULT_API_URL } from "./shared.js";
import {
  MAX_STATIC_GRAPH_NODES,
  showPipelexMethod,
  showResult,
  showToolResult,
  staticGraphSizeBound,
  validateShowRequest,
} from "./show.js";
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

// The method's text, as the route echoes it under `include_files`: an entry
// sequence calling two pipes.
const DEMO_MTHDS = `domain = "demo"
main_pipe = "main"

[pipe.main]
type = "PipeSequence"
description = "The entry pipe"
inputs = { topic = "Text" }
output = "Text"
steps = [{ pipe = "other", result = "note" }, { pipe = "finish", result = "done" }]

[pipe.other]
type = "PipeLLM"
description = "Draft a note"
inputs = { topic = "Text" }
output = "Text"
prompt = "Write about $topic"

[pipe.finish]
type = "PipeLLM"
description = "Polish the note"
inputs = { note = "Text" }
output = "Text"
prompt = "Polish $note"
`;

const DEMO_FILES = [{ content: DEMO_MTHDS, source: "main.mthds" }];

/** The whole-method answer: every pipe's artifacts, the entry pipe, the files. */
const validReport: PipeIOValidReport = {
  is_valid: true,
  pipe_ref: "demo.main",
  pipe_io_contracts: contracts,
  input_form: inputForm,
  output_form: outputForm,
  default_pipe_ref: "demo.main",
  pending_signatures: [],
  is_runnable: true,
  files: DEMO_FILES,
};

const pendingReport: PipeIOValidReport = {
  ...validReport,
  pending_signatures: ["demo.todo"],
  is_runnable: false,
};

// The crate verdict: no artifacts, no runnability facts, and no files.
const invalidReport: CrateInvalidReport = {
  is_valid: false,
  message: "invalid",
  validation_errors: [
    { category: "blueprint_validation", message: "Unknown pipe type", source: "bundle.mthds" },
  ],
};

const PUBLISHED_REF = "github.com/Pipelex/methods/documents@v0.1.0";

/**
 * A method whose every level is a sequence calling the next level's pipe
 * `calls` times, `depth` levels deep: a few kilobytes of text whose static
 * graph has `calls^0 + … + calls^depth` nodes.
 */
function nestedSequences(depth: number, calls: number): string {
  const lines = ['domain = "deep"', 'main_pipe = "level_0"', ""];
  for (let level = 0; level < depth; level += 1) {
    const steps = Array.from(
      { length: calls },
      (_, index) => `{ pipe = "level_${level + 1}", result = "out_${index}" }`,
    ).join(", ");
    lines.push(
      `[pipe.level_${level}]`,
      'type = "PipeSequence"',
      `description = "Level ${level}"`,
      'inputs = { topic = "Text" }',
      'output = "Text"',
      `steps = [${steps}]`,
      "",
    );
  }
  lines.push(
    `[pipe.level_${depth}]`,
    'type = "PipeLLM"',
    'description = "The leaf"',
    'inputs = { topic = "Text" }',
    'output = "Text"',
    'prompt = "Write about $topic"',
    "",
  );
  return lines.join("\n");
}

function mergedFrom(...texts: string[]) {
  return mergeBundles(texts.map((text) => parseMthdsBundle(text).bundle));
}

/** The static graph's pipe codes, sorted: what the builder draws from `DEMO_MTHDS` at its entry. */
function graphPipeCodes(spec: unknown): string[] {
  const nodes = (spec as { nodes?: Array<{ pipe_code?: string }> } | undefined)?.nodes ?? [];
  return nodes.map((node) => node.pipe_code ?? "").sort();
}

function contextAnswering(answer: () => Promise<PipeIOResponse>): {
  context: ShowContext;
  calls: PipeIORequest[];
} {
  const calls: PipeIORequest[] = [];
  const client: ShowClient = {
    async pipeIo(request) {
      calls.push(request);
      return answer();
    },
  };
  return { context: { baseUrl: DEFAULT_API_URL, client }, calls };
}

function apiError(status: number, message: string): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}/v1/pipe-io`,
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
  it("makes one whole-method pipe I/O call with the files, by the selector it was given", async () => {
    const { context, calls } = contextAnswering(async () => validReport);

    await showPipelexMethod({ method_id: "mt_demo" }, context);
    await showPipelexMethod({ method_ref: PUBLISHED_REF }, context);
    // A named pipe is checked against the whole-method answer, never forwarded.
    await showPipelexMethod({ method_id: "mt_demo", pipe_ref: "demo.other" }, context);

    expect(calls).toEqual([
      { method_id: "mt_demo", all_pipes: true, include_files: true },
      { method_ref: PUBLISHED_REF, all_pipes: true, include_files: true },
      { method_id: "mt_demo", all_pipes: true, include_files: true },
    ]);
  });

  it("draws the graph from the echoed files, for a catalog id and an address alike", async () => {
    const { context } = contextAnswering(async () => validReport);

    const byId = await showPipelexMethod({ method_id: "mt_demo" }, context);
    const byRef = await showPipelexMethod({ method_ref: PUBLISHED_REF }, context);

    for (const result of [byId, byRef]) {
      const spec = result.graphSpec as {
        meta?: { mode?: string };
        pipeline_ref?: { domain?: string; main_pipe?: string };
      };
      expect(spec.meta?.mode).toBe("static");
      // Drawn from the entry pipe the route stated, so the whole method shows.
      expect(spec.pipeline_ref).toEqual({ domain: "demo", main_pipe: "main" });
      expect(graphPipeCodes(spec)).toEqual(["finish", "main", "other"]);
      expect(result.structuredContent.available_view_specs).toContain("dry_run_graph");
    }
  });

  it("enters the graph at the pipe the caller named, as the form is", async () => {
    const { context } = contextAnswering(async () => validReport);

    const result = await showPipelexMethod(
      { method_id: "mt_demo", pipe_ref: "demo.other" },
      context,
    );

    const spec = result.graphSpec as { pipeline_ref?: { domain?: string; main_pipe?: string } };
    expect(spec.pipeline_ref).toEqual({ domain: "demo", main_pipe: "other" });
    expect(graphPipeCodes(spec)).toEqual(["other"]);
    // The entry pipe stays the method's own, which the view's caption names.
    expect(result.formPipeRef).toBe("demo.other");
    expect(result.mainPipeRef).toBe("demo.main");
    expect(result.structuredContent.available_view_specs).toEqual(["dry_run_graph", "input_form"]);
  });

  it("enters the graph at the named pipe of a method that settles no entry pipe", async () => {
    const { context } = contextAnswering(async () => ({
      ...validReport,
      pipe_ref: null,
      default_pipe_ref: null,
    }));

    const result = await showPipelexMethod(
      { method_id: "mt_demo", pipe_ref: "demo.main" },
      context,
    );

    expect(graphPipeCodes(result.graphSpec)).toEqual(["finish", "main", "other"]);
    expect(result.mainPipeRef).toBeUndefined();
    expect(result.formPipeRef).toBe("demo.main");
  });

  it("draws the files' declared main pipe when no pipe is named and none is settled", async () => {
    // A pipe the user clicks in the graph is then the only way to a form, so
    // the graph is entered at the first `main_pipe` the files declare. Nothing
    // is called the entry pipe, so the view's caption claims none.
    const noEntry = (files: PipeIOValidReport["files"]): PipeIOValidReport => ({
      ...validReport,
      pipe_ref: null,
      default_pipe_ref: null,
      files,
    });

    const declared = await showPipelexMethod(
      { method_id: "mt_demo" },
      contextAnswering(async () => noEntry(DEMO_FILES)).context,
    );

    const spec = declared.graphSpec as { pipeline_ref?: { domain?: string; main_pipe?: string } };
    expect(spec.pipeline_ref).toEqual({ domain: "demo", main_pipe: "main" });
    expect(graphPipeCodes(spec)).toEqual(["finish", "main", "other"]);
    expect(declared.mainPipeRef).toBeUndefined();
    expect(declared.formPipeRef).toBeUndefined();
    // The view captions a graph only against `main_pipe_ref`, which is absent.
    expect(showToolResult(declared)._meta.main_pipe_ref).toBeUndefined();
    expect(declared.structuredContent.available_view_specs).toEqual(["dry_run_graph"]);

    // Files that declare no `main_pipe` get no graph: the builder's root
    // heuristic would pick a pipe nobody declared.
    const undeclared = await showPipelexMethod(
      { method_id: "mt_demo" },
      contextAnswering(async () =>
        noEntry([
          { content: DEMO_MTHDS.replace('main_pipe = "main"\n', ""), source: "main.mthds" },
        ]),
      ).context,
    );

    expect(undeclared.graphSpec).toBeUndefined();
    expect(undeclared.structuredContent.available_view_specs).toEqual([]);
  });

  it("draws no graph for a named pipe the files do not declare", async () => {
    // The contracts list the pipe, so the local check passes, but the builder
    // cannot resolve it in the files: no graph rather than another pipe's.
    const { context } = contextAnswering(async () => ({
      ...validReport,
      files: [
        {
          content: DEMO_MTHDS.replace(/\[pipe\.other\][\s\S]*?(?=\[pipe\.finish\])/, ""),
          source: "main.mthds",
        },
      ],
    }));

    const result = await showPipelexMethod(
      { method_id: "mt_demo", pipe_ref: "demo.other" },
      context,
    );

    expect(result.graphSpec).toBeUndefined();
    expect(result.structuredContent.pipe_ref).toBe("demo.other");
  });

  it("ships no graph when the answer carries no files, or files the builder draws nothing from", async () => {
    const { files: _files, ...withoutFiles } = validReport;
    for (const report of [
      withoutFiles as PipeIOValidReport,
      { ...validReport, files: [] },
      { ...validReport, files: [{ content: "not [ toml", source: "broken.mthds" }] },
    ]) {
      const { context } = contextAnswering(async () => report);

      const result = await showPipelexMethod({ method_id: "mt_demo" }, context);

      expect(result.graphSpec).toBeUndefined();
      expect(result.structuredContent.available_view_specs).toEqual(["input_form"]);
    }
  });

  it("draws no graph for a method whose expansion passes the node budget, and stays fast", async () => {
    // Four calls per level, seven levels: 21,845 nodes from about 2 KB of text.
    // The builder has no budget of its own and builds synchronously.
    const deepReport = (content: string): PipeIOValidReport => ({
      ...validReport,
      pipe_ref: "deep.level_0",
      default_pipe_ref: "deep.level_0",
      pipe_io_contracts: { "deep.level_0": contracts["demo.main"]! },
      input_form: { "deep.level_0": inputForm["demo.main"]! },
      output_form: { "deep.level_0": outputForm["demo.main"]! },
      files: [{ content, source: "deep.mthds" }],
    });
    // Within the budget, the same shape draws, so the refusal below is the budget's.
    const shallow = await showPipelexMethod(
      { method_id: "mt_deep" },
      contextAnswering(async () => deepReport(nestedSequences(3, 3))).context,
    );
    expect(graphPipeCodes(shallow.graphSpec)).toHaveLength(40);

    const { context } = contextAnswering(async () => deepReport(nestedSequences(7, 4)));

    const started = Date.now();
    const result = await showPipelexMethod({ method_id: "mt_deep" }, context);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.graphSpec).toBeUndefined();
    // Everything else the show gives still comes.
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.available_view_specs).toEqual(["input_form"]);
    expect(result.structuredContent.inputs).toBeDefined();
  });

  it("never lets the method's source reach the model, the view or the summary", async () => {
    const { context } = contextAnswering(async () => validReport);

    const result = showToolResult(await showPipelexMethod({ method_id: "mt_demo" }, context));

    // The catalog projection invariant: only the graph built from the files
    // ships. Its pipe registry carries each pipe's parsed blueprint, as the
    // dry-run graph's did, but never the text of a file or its name.
    const everything = JSON.stringify(result);
    expect(everything).not.toContain(JSON.stringify(DEMO_MTHDS).slice(1, -1));
    expect(everything).not.toContain('main_pipe = \\"main\\"');
    expect(everything).not.toContain("main.mthds");
    expect(result._meta).not.toHaveProperty("files");
    expect(result.structuredContent).not.toHaveProperty("files");
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
      graph_spec: expect.objectContaining({ meta: expect.objectContaining({ mode: "static" }) }),
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

  it("refuses a bare pipe_ref even when a malformed answer carries no contracts", async () => {
    // Membership cannot be checked without the contracts; a bare ref is still
    // refused, since pipelex_run always refuses one.
    const { pipe_io_contracts: _dropped, ...malformed } = validReport as unknown as Record<
      string,
      unknown
    >;
    const { context } = contextAnswering(async () => malformed as unknown as PipeIOValidReport);

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
    // The graph still shows; the form does not. The route states pending
    // signatures without a dry run, so this verdict needs no validation.
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
    // The invalid arm carries no files, so an invalid method ships no graph.
    expect(result.graphSpec).toBeUndefined();
    expect(result.mainPipeRef).toBeUndefined();
    expect(result.formPipeRef).toBeUndefined();
  });

  it("does not check a named pipe against a method that does not validate", async () => {
    const { context } = contextAnswering(async () => invalidReport);

    const result = await showPipelexMethod(
      { method_id: "mt_demo", pipe_ref: "demo.nope" },
      context,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(false);
  });

  it("asks for a pipe_ref when the method settles no entry pipe", async () => {
    const { context } = contextAnswering(async () => ({
      ...validReport,
      pipe_ref: null,
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

describe("staticGraphSizeBound", () => {
  /** What the builder itself draws: the number the bound must never fall below. */
  function builtNodes(text: string, entryPipe: string): number {
    return buildStaticGraphSpec(mergedFrom(text), { entryPipe }).spec.nodes.length;
  }

  /** The bound and the builder, side by side, for a method small enough to build. */
  function boundAndBuilt(text: string, entryPipe: string, budget = 100_000): [number, number] {
    return [staticGraphSizeBound(mergedFrom(text), budget, entryPipe), builtNodes(text, entryPipe)];
  }

  /** A sequence calling `refs` in order, one step each. */
  function sequence(code: string, refs: string[]): string {
    const steps = refs.map((ref, index) => `{ pipe = "${ref}", result = "r_${index}" }`).join(", ");
    return [
      `[pipe.${code}]`,
      'type = "PipeSequence"',
      `description = "${code}"`,
      'inputs = { topic = "Text" }',
      'output = "Text"',
      `steps = [${steps}]`,
      "",
    ].join("\n");
  }

  const LEAF = [
    "[pipe.leaf]",
    'type = "PipeLLM"',
    'description = "Leaf"',
    'inputs = { topic = "Text" }',
    'output = "Text"',
    'prompt = "$topic"',
    "",
  ].join("\n");

  const times = (ref: string, count: number): string[] => Array.from({ length: count }, () => ref);

  it("counts the nodes the builder draws, one per pipe call", () => {
    expect(boundAndBuilt(DEMO_MTHDS, "demo.main")).toEqual([3, 3]);
    // 1 + 3 + 9 + 27: the calls, not the distinct pipes.
    expect(boundAndBuilt(nestedSequences(3, 3), "deep.level_0")).toEqual([40, 40]);
    // Entered lower down, only that pipe and what it calls.
    expect(boundAndBuilt(nestedSequences(3, 3), "deep.level_2")).toEqual([4, 4]);
  });

  it("caps the count just past the budget, without walking the whole expansion", () => {
    const started = Date.now();
    // 4^0 + … + 4^30 nodes if it were built.
    expect(staticGraphSizeBound(mergedFrom(nestedSequences(30, 4)), 100, "deep.level_0")).toBe(101);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("counts a recursive method along the path the builder walks, so no memo can undercount it", () => {
    // Declared in this order, `a` is counted first with `c` below it; a count
    // remembered for `c` from there (where its call to `a` is cut) would be
    // reused under `b`, where the builder expands `c` in full.
    const counterexample = (calls: number): string =>
      [
        'domain = "rec"',
        'main_pipe = "b"',
        "",
        sequence("a", times("c", calls)),
        sequence("b", times("c", calls)),
        sequence("c", ["a"]),
      ].join("\n");
    // b + n × (c + a + n × (c, cut as a leaf)) = 1 + n × (2 + n).
    expect(boundAndBuilt(counterexample(20), "rec.b")).toEqual([441, 441]);
    // At 999 calls the builder would draw a million nodes from about 70 KB.
    const started = Date.now();
    expect(
      staticGraphSizeBound(mergedFrom(counterexample(999)), MAX_STATIC_GRAPH_NODES, "rec.b"),
    ).toBe(MAX_STATIC_GRAPH_NODES + 1);
    expect(Date.now() - started).toBeLessThan(1_000);

    // A cycle entered from outside, several levels up.
    const nested = [
      'domain = "rec"',
      'main_pipe = "d"',
      "",
      sequence("a", ["b", "x"]),
      sequence("b", ["a"]),
      sequence("x", times("leaf", 30)),
      sequence("c", times("b", 5)),
      sequence("d", times("c", 5)),
      LEAF,
    ].join("\n");
    expect(boundAndBuilt(nested, "rec.d")).toEqual([856, 856]);
  });

  it("matches the builder over every controller type, so a builder that walks differently fails here", () => {
    const method = `domain = "mix"
main_pipe = "route"

[pipe.route]
type = "PipeCondition"
description = "Route"
inputs = { topic = "Text" }
output = "Text"
expression = "topic"
outcomes = { a = "each", b = "each", c = "fail", d = "fan" }
default_outcome = "loop"

[pipe.each]
type = "PipeSequence"
description = "Each"
inputs = { topics = "Text[]" }
output = "Text[]"
steps = [{ pipe = "leaf", batch_over = "topics", batch_as = "topic", result = "out" }]

[pipe.fan]
type = "PipeParallel"
description = "Fan out"
inputs = { topics = "Text[]" }
output = "Text"
branches = [{ pipe = "leaf", result = "one" }, { pipe = "batch", result = "many" }]

[pipe.batch]
type = "PipeBatch"
description = "Batch"
inputs = { topics = "Text[]" }
output = "Text[]"
branch_pipe_code = "leaf"
input_list_name = "topics"
input_item_name = "topic"

[pipe.loop]
type = "PipeSequence"
description = "Calls the router again"
inputs = { topic = "Text" }
output = "Text"
steps = [{ pipe = "route", result = "again" }, { pipe = "lib->other.pipe", result = "ext" }]

${LEAF}`;

    // route (1) + each (1 + batch node 1 + leaf 1) + fan (1 + leaf 1 + batch
    // 1 + leaf 1) + loop (1 + route as a leaf 1 + the opaque dependency leaf
    // 1); "fail" and the duplicate "each" count nothing.
    expect(boundAndBuilt(method, "mix.route")).toEqual([11, 11]);
  });

  it("counts an unresolvable ref, which the builder skips, so the walk's work stays bounded", () => {
    const method = [
      'domain = "gap"',
      'main_pipe = "main"',
      "",
      sequence("main", ["leaf", "nope"]),
      LEAF,
    ].join("\n");
    expect(boundAndBuilt(method, "gap.main")).toEqual([3, 2]);
  });

  it("counts nothing for an entry the builder cannot resolve", () => {
    expect(staticGraphSizeBound(mergedFrom(DEMO_MTHDS), MAX_STATIC_GRAPH_NODES, "demo.nope")).toBe(
      0,
    );
    expect(
      staticGraphSizeBound(mergedFrom(DEMO_MTHDS), MAX_STATIC_GRAPH_NODES, "lib->demo.main"),
    ).toBe(0);
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
    const report: PipeIOValidReport = { ...validReport, input_form: {} };

    const result = showResult(report, { method_id: "mt_demo" });

    expect(result.structuredContent.is_runnable).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("inputs");
    expect(result.summary).toContain("No template could be projected");
  });
});
