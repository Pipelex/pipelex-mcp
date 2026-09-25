import { describe, expect, it } from "vitest";

import type { OutputForm, PipeIOContracts } from "@pipelex/mthds-ui/form";

import type { RunResultsStructuredContent, RunUsage } from "@pipelex/mcp-core/capabilities/run.js";
import {
  completedHeadline,
  executedPipeRefOf,
  failedHeadline,
  formatDuration,
  formatRunCost,
  hasExecutedGraph,
  outputFieldFor,
  runDurationSeconds,
  runResultsViewOf,
} from "./run-results.js";

// The standard's own minimal shapes, as the validate tests state them: a
// `native.Text` output, whose payload sits under `text`.
const contracts: PipeIOContracts = {
  "demo.main": {
    inputs: {},
    output: {
      concept_ref: "native.Text",
      multiplicity: "single",
      item_count: null,
      optional: false,
      json_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
};

const outputForm: OutputForm = {
  "demo.main": {
    field: { name: "output", kind: "prose", concept_ref: "native.Text", required: true },
  },
};

/** A live graph as the runtime stamps it: `pipeline_ref` names the pipe it traced. */
const liveGraph = {
  pipeline_ref: { domain: "demo", main_pipe: "main" },
  nodes: [{ id: "demo.main" }],
  edges: [],
};

const usage = (overrides: Partial<RunUsage>): RunUsage => ({
  state: "records",
  cost_usd: 0.0138,
  tokens: 1200,
  calls: 2,
  assembly_error: null,
  ...overrides,
});

describe("runResultsViewOf", () => {
  const content: RunResultsStructuredContent = {
    status: "ok",
    run_id: "run_1",
    state: "completed",
    main_stuff: { text: "bounded" },
    available_view_specs: ["run_graph"],
  };

  it("reads the view-only artifacts off _meta, the full output included", () => {
    const view = runResultsViewOf(content, {
      graph_spec: liveGraph,
      pipe_io_contracts: contracts,
      output_form: outputForm,
      main_stuff: { text: "the whole output" },
    });
    expect(view.content).toBe(content);
    expect(view.graphSpec).toBe(liveGraph);
    expect(view.contracts).toBe(contracts);
    expect(view.outputForm).toBe(outputForm);
    expect(view.inputForm).toBeNull();
    expect(view.mainStuff).toEqual({ text: "the whole output" });
    expect(hasExecutedGraph(view)).toBe(true);
  });

  it("reads a response with no _meta as carrying no artifacts", () => {
    const view = runResultsViewOf(content, undefined);
    expect(view.graphSpec).toBeNull();
    expect(view.contracts).toBeNull();
    expect(view.outputForm).toBeNull();
    expect(view.mainStuff).toBeUndefined();
    expect(hasExecutedGraph(view)).toBe(false);
  });

  it("treats a graph with no nodes as no graph", () => {
    expect(hasExecutedGraph(runResultsViewOf(content, { graph_spec: { nodes: [] } }))).toBe(false);
  });
});

describe("executedPipeRefOf", () => {
  it("takes the pipe the executed graph names over the one requested", () => {
    // The graph is the runtime's statement of what ran, manifest resolution
    // included, which the caller cannot always know.
    expect(executedPipeRefOf(liveGraph, "other.shout")).toBe("demo.main");
  });

  it("falls back to the requested pipe when the graph names none", () => {
    expect(executedPipeRefOf(null, "demo.main")).toBe("demo.main");
    expect(executedPipeRefOf({ nodes: [] }, " demo.main ")).toBe("demo.main");
  });

  it("says nothing rather than guess when neither names a pipe", () => {
    expect(executedPipeRefOf(null, null)).toBeNull();
    expect(executedPipeRefOf(undefined, "  ")).toBeNull();
    // A half-stamped ref is no ref.
    expect(executedPipeRefOf({ pipeline_ref: { main_pipe: "main" } }, undefined)).toBeNull();
  });
});

describe("outputFieldFor", () => {
  it("derives the output field from the descriptor and the contract's payload schema", () => {
    const field = outputFieldFor(contracts, outputForm, "demo.main");
    expect(field).toMatchObject({ name: "output", kind: "prose", conceptRef: "native.Text" });
    // The payload schema is what names the property a native payload sits
    // under; without it the renderer would have to guess.
    expect(field).toMatchObject({ contentKey: "text" });
  });

  it("derives nothing without a pipe, or when either artifact misses it", () => {
    expect(outputFieldFor(contracts, outputForm, null)).toBeNull();
    expect(outputFieldFor(null, outputForm, "demo.main")).toBeNull();
    expect(outputFieldFor(contracts, null, "demo.main")).toBeNull();
    expect(outputFieldFor(contracts, outputForm, "demo.other")).toBeNull();
    expect(outputFieldFor({}, outputForm, "demo.main")).toBeNull();
  });

  it("derives nothing when the contract states no payload schema", () => {
    // An older runner's contract: the kernel requires the schema, and a field
    // derived without one would render the wrong shape.
    const schemaless = {
      "demo.main": { ...contracts["demo.main"], output: { concept_ref: "native.Text" } },
    } as unknown as PipeIOContracts;
    expect(outputFieldFor(schemaless, outputForm, "demo.main")).toBeNull();
  });
});

describe("runDurationSeconds", () => {
  it("measures the run record from creation to finish", () => {
    expect(runDurationSeconds("2026-09-25T10:00:00.000Z", "2026-09-25T10:00:23.600Z")).toBe(23.6);
  });

  it("is unknown when either end is missing, unreadable or out of order", () => {
    expect(runDurationSeconds(undefined, "2026-09-25T10:00:23Z")).toBeNull();
    expect(runDurationSeconds("2026-09-25T10:00:00Z", null)).toBeNull();
    expect(runDurationSeconds("2026-09-25T10:00:00Z", undefined)).toBeNull();
    expect(runDurationSeconds("yesterday", "2026-09-25T10:00:23Z")).toBeNull();
    expect(runDurationSeconds("2026-09-25T10:00:23Z", "2026-09-25T10:00:00Z")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("writes seconds to one decimal under a minute", () => {
    expect(formatDuration(23.56)).toBe("23.6 s");
    expect(formatDuration(0.4)).toBe("0.4 s");
  });

  it("writes minutes and seconds under an hour", () => {
    expect(formatDuration(125)).toBe("2 min 5 s");
    expect(formatDuration(120)).toBe("2 min");
  });

  it("writes hours and minutes beyond", () => {
    expect(formatDuration(3780)).toBe("1 h 3 min");
    expect(formatDuration(7200)).toBe("2 h");
  });
});

describe("formatRunCost", () => {
  it("writes a priced run at the graph panel's four decimals", () => {
    expect(formatRunCost(usage({}))).toBe("$0.0138");
    expect(formatRunCost(usage({ cost_usd: 0 }))).toBe("$0.0000");
  });

  it("never rounds a real cost to zero", () => {
    expect(formatRunCost(usage({ cost_usd: 0.00004 }))).toBe("<$0.0001");
  });

  it("marks a partial cost as a lower bound", () => {
    expect(formatRunCost(usage({ cost_partial: true }))).toBe("≥ $0.0138");
  });

  it("prints nothing when nothing honest can be printed", () => {
    expect(formatRunCost(undefined)).toBeNull();
    // No call was priced: a missing dollar is never a zero one.
    expect(formatRunCost(usage({ cost_usd: null }))).toBeNull();
    // The run made no inference.
    expect(formatRunCost(usage({ state: "no_inference", cost_usd: 0, calls: 0 }))).toBeNull();
    expect(formatRunCost(usage({ state: "unavailable", cost_usd: null, calls: 0 }))).toBeNull();
  });
});

describe("the headlines", () => {
  it("states the duration and the cost of a completed run, each when known", () => {
    expect(completedHeadline(23.6, usage({}))).toBe("Completed in 23.6 s · $0.0138");
    expect(completedHeadline(null, usage({ cost_partial: true }))).toBe("Completed · ≥ $0.0138");
    expect(completedHeadline(4, usage({ cost_usd: null }))).toBe("Completed in 4.0 s");
    expect(completedHeadline(null, undefined)).toBe("Completed");
  });

  it("names how a failed run ended", () => {
    expect(failedHeadline("FAILED", 12.1)).toBe("Failed after 12.1 s");
    expect(failedHeadline("TIMED_OUT", 600)).toBe("Timed out after 10 min");
    expect(failedHeadline("CANCELLED", null)).toBe("Cancelled");
    expect(failedHeadline(undefined, null)).toBe("Failed");
  });
});
