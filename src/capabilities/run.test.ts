import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, MissingMainStuffError } from "@pipelex/sdk";
import type {
  MethodProvenance,
  RunRead,
  RunResults,
  RunResultStart,
  RunResultState,
  RunStatus,
  PipelexStartOptions,
  TokensUsageRecord,
} from "@pipelex/sdk";

import {
  boundMainStuff,
  computeUsageByPipe,
  ELLIPSIS_MARKER,
  getMthdsRunResults,
  getMthdsRunStatus,
  MAIN_STUFF_CAP,
  resultsResult,
  RUN_RESULTS_ERROR_OPTIONS,
  RUN_START_ERROR_OPTIONS,
  RUN_STATUS_ERROR_OPTIONS,
  runResultsToolResult,
  startMthdsRun,
  startResult,
  statusResult,
  summarizeUsage,
  validateRunRequest,
} from "./run.js";
import type { RunContext } from "./run.js";
import { classifyError, DEFAULT_API_URL } from "./shared.js";

const RUN_ID = "01JRUN0000000000000000TEST";

function runRead(overrides: Partial<RunRead> = {}): RunRead {
  return {
    pipeline_run_id: RUN_ID,
    status: "RUNNING",
    created_at: "2026-07-15T10:00:00Z",
    degraded: false,
    ...overrides,
  };
}

describe("validateRunRequest", () => {
  it("rejects an empty file list", () => {
    const errors = validateRunRequest({ files: [] });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("files");
  });

  it("accepts a method_id-only request", () => {
    expect(validateRunRequest({ files: [], method_id: "mt_abc123" })).toEqual([]);
  });

  it("rejects a blank method_id at method_id", () => {
    const errors = validateRunRequest({ files: [], method_id: "  " });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.class).toBe("input_domain");
    expect(errors[0]?.location).toBe("method_id");
  });

  it("rejects a blank pipe_code", () => {
    const errors = validateRunRequest({
      files: [{ content: 'domain = "demo"' }],
      pipe_code: "  ",
    });

    expect(errors.map((error) => error.location)).toEqual(["pipe_code"]);
    expect(errors[0]?.class).toBe("input_domain");
  });

  it("accepts an omitted pipe_code", () => {
    const errors = validateRunRequest({ files: [{ content: 'domain = "demo"' }] });

    expect(errors).toEqual([]);
  });
});

describe("run-route error classification", () => {
  it("classifies a 404 on the run routes as an unknown run id (input_domain)", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/runs/${RUN_ID}/status`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Run not found",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_STATUS_ERROR_OPTIONS,
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("run_id");
    expect(error.message).toBe("Run not found");
  });

  it("keeps the missing-route 404 arm (config) on the start route", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 404",
        `${DEFAULT_API_URL}/v1/start`,
        404,
        "Not Found",
        "{}",
        "not_found",
        "Not found",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_START_ERROR_OPTIONS,
    );

    expect(error.class).toBe("config");
    expect(error.location).toBe("PIPELEX_BASE_URL");
    expect(error.hint).toContain("/v1/start");
  });

  it("points a start-route 5xx at the recoverable causes first", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 503",
        `${DEFAULT_API_URL}/v1/start`,
        503,
        "Service Unavailable",
        "{}",
        "pipeline_start_unavailable",
        "Failed to start pipeline",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_START_ERROR_OPTIONS,
    );

    // The hosted /v1/start answers 503 for an invalid bundle too — the hint
    // must point at validation before blaming the platform.
    expect(error.class).toBe("runtime");
    expect(error.hint).toMatch(/mthds_validate/);
  });

  it("points a start-route 422 at the run request fields", () => {
    const error = classifyError(
      new ApiResponseError(
        "HTTP 422",
        `${DEFAULT_API_URL}/v1/start`,
        422,
        "Unprocessable Entity",
        "{}",
        "validation_error",
        "Invalid bundle",
        undefined, // validationErrors
        undefined, // code
      ),
      RUN_START_ERROR_OPTIONS,
    );

    expect(error.class).toBe("input_domain");
    expect(error.location).toBe("files");
    expect(error.hint).toMatch(/mthds_validate/);
  });

  it("points a 400/422 on the run-id routes at run_id, not files", () => {
    const routes: Array<[string, typeof RUN_STATUS_ERROR_OPTIONS]> = [
      ["/v1/runs/not-a-run-id/status", RUN_STATUS_ERROR_OPTIONS],
      ["/v1/runs/not-a-run-id/results", RUN_RESULTS_ERROR_OPTIONS],
    ];
    for (const [route, options] of routes) {
      const error = classifyError(
        new ApiResponseError(
          "HTTP 422",
          `${DEFAULT_API_URL}${route}`,
          422,
          "Unprocessable Entity",
          "{}",
          "validation_error",
          "Invalid run id",
          undefined, // validationErrors
          undefined, // code
        ),
        options,
      );

      expect(error.class).toBe("input_domain");
      expect(error.location).toBe("run_id");
      expect(error.hint).toMatch(/mthds_run/);
    }
  });
});

describe("startResult", () => {
  it("projects a hosted start ack with its extension fields", () => {
    const ack: RunResultStart = {
      pipeline_run_id: RUN_ID,
      state: "STARTED",
      created_at: "2026-07-15T10:00:00Z",
      workflow_id: "wf-123",
    };

    const result = startResult(ack);

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      run_status: "STARTED",
      created_at: "2026-07-15T10:00:00Z",
      available_view_specs: ["live_run_status"],
    });
    expect(result.summary).toContain(RUN_ID);
    expect(result.summary).toContain("mthds_run_status");
    expect(result.summary).toContain("mthds_run_results");
    expect(result.summary).toContain("## Views");
  });

  it("projects method_provenance and narrates the resolved snapshot", () => {
    const result = startResult({
      pipeline_run_id: RUN_ID,
      method_provenance: {
        address: "github.com/Pipelex/methods/documents",
        tag: "v0.1.0",
        commit_sha: "abc123def456",
      },
    });

    expect(result.structuredContent.method_provenance).toEqual({
      address: "github.com/Pipelex/methods/documents",
      tag: "v0.1.0",
      commit_sha: "abc123def456",
    });
    expect(result.summary).toContain("github.com/Pipelex/methods/documents");
    expect(result.summary).toContain("v0.1.0");
    expect(result.summary).toContain("abc123def456");
  });

  it("narrates a tagless resolution without inventing a tag", () => {
    const result = startResult({
      pipeline_run_id: RUN_ID,
      method_provenance: {
        address: "github.com/Pipelex/methods/documents",
        tag: null,
        commit_sha: "abc123def456",
      },
    });

    expect(result.structuredContent.method_provenance?.tag).toBeNull();
    expect(result.summary).not.toContain("at tag");
  });

  it("drops a malformed method_provenance extension instead of guessing", () => {
    const result = startResult({
      pipeline_run_id: RUN_ID,
      method_provenance: {
        address: "github.com/x/y",
        commit_sha: 42,
      } as unknown as MethodProvenance,
    });

    expect(result.structuredContent).not.toHaveProperty("method_provenance");
  });

  it("tolerates a bare protocol ack with no extensions", () => {
    const result = startResult({ pipeline_run_id: RUN_ID });

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
    expect(result.structuredContent).not.toHaveProperty("run_status");
    expect(result.structuredContent).not.toHaveProperty("created_at");
  });

  it("does not advertise or narrate a live card when the invoking shell has no views", () => {
    const result = startResult({ pipeline_run_id: RUN_ID }, false);

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.summary).not.toContain("## Views");
    expect(result.summary).not.toContain("live status card");
  });

  it("drops an unrecognized state extension instead of guessing", () => {
    const result = startResult({ pipeline_run_id: RUN_ID, state: "WARMING_UP" });

    expect(result.structuredContent).not.toHaveProperty("run_status");
  });
});

describe("statusResult", () => {
  it("projects a non-terminal status with the retry hint passed through", () => {
    const result = statusResult(runRead({ status: "RUNNING", retry_after_seconds: 5 }));

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      run_status: "RUNNING",
      is_terminal: false,
      degraded: false,
      retry_after_seconds: 5,
      created_at: "2026-07-15T10:00:00Z",
    });
    expect(result.summary).toContain("~5s");
  });

  it("suggests a default check-again delay when the server sends no hint", () => {
    const result = statusResult(runRead({ status: "PENDING" }));

    expect(result.structuredContent).not.toHaveProperty("retry_after_seconds");
    expect(result.summary).toMatch(/check again in ~\d+s/i);
  });

  it("projects a completed run as terminal and points at mthds_run_results", () => {
    const result = statusResult(
      runRead({ status: "COMPLETED", finished_at: "2026-07-15T10:05:00Z" }),
    );

    expect(result.structuredContent.run_status).toBe("COMPLETED");
    expect(result.structuredContent.is_terminal).toBe(true);
    expect(result.structuredContent.finished_at).toBe("2026-07-15T10:05:00Z");
    expect(result.summary).toContain("mthds_run_results");
    expect(result.summary).not.toMatch(/check again/i);
  });

  it("projects a failed run as a produced ok verdict, not an error", () => {
    const result = statusResult(runRead({ status: "FAILED" }));

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_status).toBe("FAILED");
    expect(result.structuredContent.is_terminal).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("errors");
  });

  it("derives is_terminal from the whole RunStatus set", () => {
    const expectations: Array<[RunStatus, boolean]> = [
      ["PENDING", false],
      ["STARTED", false],
      ["RUNNING", false],
      ["COMPLETED", true],
      ["FAILED", true],
      ["CANCELLED", true],
      ["TERMINATED", true],
      ["TIMED_OUT", true],
    ];

    for (const [status, isTerminal] of expectations) {
      expect(statusResult(runRead({ status })).structuredContent.is_terminal).toBe(isTerminal);
    }
  });

  it("flags a degraded read without alarming the summary", () => {
    const result = statusResult(
      runRead({ status: "RUNNING", degraded: true, retry_after_seconds: 10 }),
    );

    expect(result.structuredContent.degraded).toBe(true);
    expect(result.structuredContent.retry_after_seconds).toBe(10);
    expect(result.summary).toMatch(/last-known/i);
  });
});

describe("resultsResult", () => {
  it("projects a running lookup as a produced ok verdict with the retry hint", () => {
    const result = resultsResult({
      state: "running",
      pipeline_run_id: RUN_ID,
      retry_after_seconds: 3,
    });

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "running",
      retry_after_seconds: 3,
      available_view_specs: [],
    });
    expect(result.summary).toContain("~3s");
    expect(result.graphSpec).toBeUndefined();
    expect(result.mainStuff).toBeUndefined();
  });

  it("names mthds_download_artifacts in the summary only where the tool exists and files were produced", () => {
    const withFiles = {
      state: "completed" as const,
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: {
          url: "pipelex-storage://runs/x/illustration.png",
          public_url: "https://signed.example/illustration.png?X-Amz-Expires=3600",
        },
      },
    };
    const withoutFiles = {
      ...withFiles,
      result: { pipeline_run_id: RUN_ID, main_stuff: { answer: 42 } },
    };

    // The workshop: files produced → the nudge, with the expiry stated.
    const workshop = resultsResult(withFiles, false, true);
    expect(workshop.summary).toContain("mthds_download_artifacts");
    expect(workshop.summary).toContain("1 stored file(s)");
    expect(workshop.summary).toContain("expire");
    // The nudge is prose only — the structured contract is untouched.
    expect(workshop.structuredContent).not.toHaveProperty("artifacts");

    // The workshop, nothing produced → silent.
    expect(resultsResult(withoutFiles, false, true).summary).not.toContain(
      "mthds_download_artifacts",
    );
    // The console has no such tool → silent even with files.
    expect(resultsResult(withFiles, true, false).summary).not.toContain("mthds_download_artifacts");
    expect(resultsResult(withFiles).summary).not.toContain("mthds_download_artifacts");
  });

  it("projects a completed run and carries graph + full output off structuredContent", () => {
    const mainStuff = { answer: 42, items: ["a", "b"] };
    const graphSpec = { nodes: [{ id: "demo.main" }] };
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: mainStuff, graph_spec: graphSpec },
    });

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("completed");
    expect(result.structuredContent.main_stuff).toEqual(mainStuff);
    expect(result.structuredContent.truncated).toBe(false);
    expect(result.structuredContent.available_view_specs).toEqual(["run_graph"]);
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.graphSpec).toEqual(graphSpec);
    expect(result.mainStuff).toBe(mainStuff);
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain('"answer": 42');
    // No tokens_usages on the wire → usage omitted, nothing on _meta.
    expect(result.structuredContent).not.toHaveProperty("usage");
    expect(result.tokensUsages).toBeUndefined();
    expect(result.summary).not.toContain("## Usage");
  });

  it("does not advertise a view but preserves full result metadata when the shell has no views", () => {
    const mainStuff = { answer: "x".repeat(MAIN_STUFF_CAP * 2) };
    const result = resultsResult(
      {
        state: "completed",
        pipeline_run_id: RUN_ID,
        result: {
          pipeline_run_id: RUN_ID,
          main_stuff: mainStuff,
          graph_spec: { nodes: [{ id: "demo.main" }] },
        },
      },
      false,
    );

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.truncated).toBe(true);
    expect(result.graphSpec).toBeUndefined();
    expect(result.mainStuff).toBe(mainStuff);
  });

  it("keeps a falsy-but-present main output as a valid completed result", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: [] },
    });

    expect(result.structuredContent.main_stuff).toEqual([]);
    expect(result.structuredContent.truncated).toBe(false);
  });

  it("advertises no view when the completed result carries no graph", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", graph_spec: null },
    });

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.graphSpec).toBeUndefined();
  });

  it("bounds a huge completed output and keeps the full copy for the view", () => {
    const mainStuff = {
      report: Array.from({ length: 3000 }, (_, index) => ({
        index,
        text: `item ${index} `.repeat(5),
      })),
    };
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: mainStuff },
    });

    expect(result.structuredContent.truncated).toBe(true);
    expect(JSON.stringify(result.structuredContent.main_stuff).length).toBeLessThanOrEqual(
      MAIN_STUFF_CAP,
    );
    expect(result.mainStuff).toBe(mainStuff);
    expect(result.summary).toMatch(/truncated/i);
  });

  it("projects run-level usage in structuredContent, per-pipe only off it, and no usage prose", () => {
    const tokensUsages: TokensUsageRecord[] = [
      {
        pipe_code: "extract",
        cost: 0.018,
        nb_tokens_by_category: { input: 6000, input_cached: 2000, output: 3000 },
      },
      { pipe_code: "summarize", cost: 0.005, nb_tokens_by_category: { input: 2500, output: 1000 } },
    ];
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", tokens_usages: tokensUsages },
    });

    const usage = result.structuredContent.usage;
    // Run-level totals only; input_cached (a subset of input) is excluded: 9000 + 3500 = 12500.
    expect(usage?.cost_usd).toBeCloseTo(0.023, 10);
    expect(usage?.tokens).toBe(12500);
    expect(usage?.calls).toBe(2);
    expect(usage).not.toHaveProperty("cost_partial");
    expect(usage).not.toHaveProperty("assembly_error");
    // Per-pipe is deliberately absent from the model-facing structuredContent.
    expect(usage).not.toHaveProperty("by_pipe");
    expect(usage).not.toHaveProperty("by_pipe_truncated");
    // Per-pipe rollup + full per-call list ride the result (→ _meta), never structuredContent.
    expect(result.tokensUsages).toBe(tokensUsages);
    expect(result.usageByPipe).toEqual([
      { pipe_code: "extract", cost_usd: 0.018, tokens: 9000, calls: 1 },
      { pipe_code: "summarize", cost_usd: 0.005, tokens: 3500, calls: 1 },
    ]);
    // Usage never appears in the prose summary.
    expect(result.summary).not.toContain("Usage");
    expect(result.summary).not.toContain("$0.02");
    expect(result.summary).not.toContain("tokens");
  });

  it("omits usage but keeps the completed result when the run reported no usage", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", tokens_usages: null },
    });

    expect(result.structuredContent).not.toHaveProperty("usage");
    expect(result.tokensUsages).toBeUndefined();
    expect(result.usageByPipe).toBeUndefined();
  });

  it("hard-errors when a completed result is missing its main output", () => {
    const state = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID },
    } as unknown as RunResultState;

    expect(() => resultsResult(state)).toThrow(/main_stuff/);
  });

  it("projects a failed run as a produced ok verdict with the failure details", () => {
    const result = resultsResult({
      state: "failed",
      pipeline_run_id: RUN_ID,
      status: "FAILED",
      message: "Pipe demo.main raised.",
    });

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "FAILED",
      failure_message: "Pipe demo.main raised.",
      available_view_specs: [],
    });
    expect(result.summary).toContain("FAILED");
    expect(result.summary).toContain("Pipe demo.main raised.");
    expect(result.summary).toMatch(/no graph/i);
  });
});

describe("summarizeUsage", () => {
  function runResults(overrides: Partial<RunResults>): RunResults {
    return { pipeline_run_id: RUN_ID, main_stuff: "done", ...overrides };
  }

  function record(overrides: Partial<TokensUsageRecord> = {}): TokensUsageRecord {
    return {
      pipe_code: "demo",
      cost: 0.01,
      nb_tokens_by_category: { input: 100, output: 50 },
      ...overrides,
    };
  }

  it("omits usage when tokens_usages is null and no assembly error (usage off / pre-artifact)", () => {
    expect(summarizeUsage(runResults({ tokens_usages: null }))).toBeUndefined();
    expect(summarizeUsage(runResults({}))).toBeUndefined();
  });

  it("branches on usage_assembly_error, not the null list, when assembly broke", () => {
    const usage = summarizeUsage(
      runResults({ tokens_usages: null, usage_assembly_error: "artifact read failed" }),
    );

    expect(usage).toEqual({
      cost_usd: null,
      tokens: null,
      calls: 0,
      assembly_error: "artifact read failed",
    });
  });

  it("reports zero totals for an empty list (assembly ran, no inference)", () => {
    const usage = summarizeUsage(runResults({ tokens_usages: [] }));

    expect(usage).toEqual({ cost_usd: 0, tokens: 0, calls: 0 });
  });

  it("returns null cost (not 0) when calls happened but none were priced", () => {
    const usage = summarizeUsage(
      runResults({
        tokens_usages: [
          record({ cost: null, nb_tokens_by_category: { input: 10, output: 5 } }),
          record({ cost: undefined, nb_tokens_by_category: { input: 20, output: 5 } }),
        ],
      }),
    );

    expect(usage?.cost_usd).toBeNull();
    expect(usage?.tokens).toBe(40);
    expect(usage).not.toHaveProperty("cost_partial");
  });

  it("flags cost_partial and sums only the priced calls when the run mixes priced and unpriced", () => {
    const usage = summarizeUsage(
      runResults({
        tokens_usages: [record({ cost: 0.02 }), record({ cost: null })],
      }),
    );

    expect(usage?.cost_usd).toBeCloseTo(0.02, 10);
    expect(usage?.cost_partial).toBe(true);
  });

  it("excludes cached-input and reasoning subsets from the token total", () => {
    const usage = summarizeUsage(
      runResults({
        tokens_usages: [
          record({
            nb_tokens_by_category: {
              input: 1000,
              input_cached: 400,
              output: 300,
              output_reasoning: 120,
            },
          }),
        ],
      }),
    );

    // input + output only: 1000 + 300 = 1300 (cached/reasoning are subsets).
    expect(usage?.tokens).toBe(1300);
  });

  it("returns null tokens when no record reported input or output counts", () => {
    const usage = summarizeUsage(
      runResults({
        tokens_usages: [
          record({ nb_tokens_by_category: null }),
          record({ nb_tokens_by_category: {} }),
        ],
      }),
    );

    expect(usage?.tokens).toBeNull();
  });

  it("does not put per-pipe on the run-level usage — that rides _meta only", () => {
    const usage = summarizeUsage(
      runResults({
        tokens_usages: [
          record({ pipe_code: "a", cost: 0.01 }),
          record({ pipe_code: "b", cost: 0.02 }),
        ],
      }),
    );

    expect(usage?.calls).toBe(2);
    expect(usage).not.toHaveProperty("by_pipe");
    expect(usage).not.toHaveProperty("by_pipe_truncated");
  });
});

describe("computeUsageByPipe", () => {
  function record(overrides: Partial<TokensUsageRecord> = {}): TokensUsageRecord {
    return {
      pipe_code: "demo",
      cost: 0.01,
      nb_tokens_by_category: { input: 100, output: 50 },
      ...overrides,
    };
  }

  it("groups by pipe_code, sorts by cost desc, and groups unattributed calls under null", () => {
    const rows = computeUsageByPipe([
      record({ pipe_code: "cheap", cost: 0.001, nb_tokens_by_category: { input: 10, output: 5 } }),
      record({
        pipe_code: "pricey",
        cost: 0.05,
        nb_tokens_by_category: { input: 100, output: 50 },
      }),
      record({ pipe_code: "pricey", cost: 0.02, nb_tokens_by_category: { input: 40, output: 10 } }),
      record({ pipe_code: null, cost: null, nb_tokens_by_category: null }),
    ]);

    expect(rows.map((row) => row.pipe_code)).toEqual(["pricey", "cheap", null]);
    const pricey = rows[0];
    expect(pricey?.calls).toBe(2);
    expect(pricey?.cost_usd).toBeCloseTo(0.07, 10);
    expect(pricey?.tokens).toBe(200);
    // The unattributed (null-priced) group sorts last with a null cost.
    expect(rows[2]).toEqual({ pipe_code: null, cost_usd: null, tokens: null, calls: 1 });
  });

  it("keeps every distinct pipe — the rollup is unbounded (it rides _meta, not model context)", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      record({
        pipe_code: `pipe_${index}`,
        cost: 0.001,
        nb_tokens_by_category: { input: 10, output: 10 },
      }),
    );

    expect(computeUsageByPipe(many)).toHaveLength(50);
  });
});

describe("usage stays out of the run-results prose", () => {
  function completedSummaryFor(overrides: Partial<RunResults>): string {
    return resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", ...overrides },
    }).summary;
  }

  it("never mentions usage, cost, or tokens for a run with usage records", () => {
    const summary = completedSummaryFor({
      tokens_usages: [
        { pipe_code: "demo", cost: 0.02, nb_tokens_by_category: { input: 10, output: 5 } },
      ],
    });
    expect(summary).not.toMatch(/usage/i);
    expect(summary).not.toContain("$");
    expect(summary).not.toContain("tokens");
  });

  it("never mentions a usage assembly error in the prose", () => {
    const summary = completedSummaryFor({ usage_assembly_error: "boom" });
    expect(summary).not.toMatch(/usage/i);
    expect(summary).not.toContain("boom");
  });
});

describe("boundMainStuff", () => {
  it("returns a value at the cap untouched", () => {
    // JSON.stringify adds the two quotes, landing exactly on the cap.
    const value = "a".repeat(MAIN_STUFF_CAP - 2);

    const bounded = boundMainStuff(value);

    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(value);
  });

  it("head+tails a text output just over the cap", () => {
    const text = "H".repeat(1000) + "m".repeat(MAIN_STUFF_CAP) + "T".repeat(1000);

    const bounded = boundMainStuff(text);

    expect(bounded.truncated).toBe(true);
    const value = bounded.value as string;
    expect(value.length).toBeLessThanOrEqual(MAIN_STUFF_CAP);
    expect(value.startsWith("H".repeat(100))).toBe(true);
    expect(value.endsWith("T".repeat(100))).toBe(true);
    expect(value).toContain(ELLIPSIS_MARKER);
  });

  it("prunes a long collection with an ellipsis marker", () => {
    const value = Array.from({ length: 2000 }, (_, index) => ({
      index,
      text: "x".repeat(50),
    }));

    const bounded = boundMainStuff(value);

    expect(bounded.truncated).toBe(true);
    const prunedItems = bounded.value as unknown[];
    expect(prunedItems.at(-1)).toBe(ELLIPSIS_MARKER);
    expect(prunedItems[0]).toEqual(value[0]);
    expect(JSON.stringify(bounded.value).length).toBeLessThanOrEqual(MAIN_STUFF_CAP);
  });

  it("prunes deep nesting and long strings deterministically", () => {
    let nested: Record<string, unknown> = { payload: "y".repeat(3000) };
    for (let level = 0; level < 30; level += 1) {
      nested = { payload: "y".repeat(3000), child: nested };
    }

    const first = boundMainStuff(nested);
    const second = boundMainStuff(nested);

    expect(first.truncated).toBe(true);
    expect(JSON.stringify(first.value).length).toBeLessThanOrEqual(MAIN_STUFF_CAP);
    expect(JSON.stringify(first.value)).toContain(ELLIPSIS_MARKER);
    expect(second.value).toEqual(first.value);
  });

  it("leaves a small structured output untouched", () => {
    const value = { answer: 42, items: ["a", "b"] };

    const bounded = boundMainStuff(value);

    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(value);
  });
});

// ── capability tests (fake client seam) ─────────────────────────────

// Structural mirror of the RunClient seam in run.ts.
interface FakeRunClient {
  start(options: PipelexStartOptions): Promise<RunResultStart>;
  getRunStatus(runId: string): Promise<RunRead>;
  getRunResult(runId: string): Promise<RunResultState>;
}

const NEVER_CLIENT: FakeRunClient = {
  start: () => Promise.reject(new Error("start must not be called")),
  getRunStatus: () => Promise.reject(new Error("getRunStatus must not be called")),
  getRunResult: () => Promise.reject(new Error("getRunResult must not be called")),
};

function contextWith(overrides: Partial<FakeRunClient>): RunContext {
  return {
    baseUrl: DEFAULT_API_URL,
    client: { ...NEVER_CLIENT, ...overrides },
  };
}

describe("startMthdsRun", () => {
  it("maps MCP input to PipelexStartOptions and projects the ack", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID, state: "STARTED" });
      },
    });

    const result = await startMthdsRun(
      {
        files: [{ content: 'domain = "demo"', uri: "file:///demo.mthds" }],
        pipe_code: "main",
        inputs: { question: "why?" },
      },
      context,
    );

    // /v1/start takes no source labels — only the contents cross the wire.
    expect(seen).toEqual({
      mthds_contents: ['domain = "demo"'],
      pipe_code: "main",
      inputs: { question: "why?" },
    });
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("omits pipe_code and inputs from PipelexStartOptions when not supplied", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID });
      },
    });

    await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(seen).toEqual({ mthds_contents: ['domain = "demo"'] });
    expect(seen).not.toHaveProperty("pipe_code");
    expect(seen).not.toHaveProperty("inputs");
  });

  it("does not call the client when request validation fails", async () => {
    const result = await startMthdsRun({ files: [] }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.available_view_specs).toEqual([]);
  });

  it("classifies an unreachable API as config", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
    });

    const result = await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.summary).toContain("unreachable or misconfigured");
  });
});

describe("startMthdsRun by method_ref", () => {
  const ADDRESS = "github.com/Pipelex/methods/documents@v0.1.0";

  it("forwards method_ref as the run source, with no contents and no linkage id", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID });
      },
    });

    const result = await startMthdsRun({ method_ref: ADDRESS, inputs: { q: "why?" } }, context);

    expect(seen).toEqual({ inputs: { q: "why?" }, method_ref: ADDRESS });
    expect(result.structuredContent.status).toBe("ok");
  });

  it("rejects files beside method_ref without calling the client", async () => {
    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_ref: ADDRESS },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });

  it("rejects method_ref beside method_id without calling the client", async () => {
    const result = await startMthdsRun(
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
    expect(result.structuredContent.errors?.[0]?.message).toContain("provenance");
  });

  it("classifies a structures refusal (403 MethodStructuresRefusedError) at method_ref", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 403",
            `${DEFAULT_API_URL}/v1/start`,
            403,
            "Forbidden",
            "{}",
            "MethodStructuresRefusedError",
            "The method declares in-process Python structures",
            undefined,
            undefined,
          ),
        ),
    });

    const result = await startMthdsRun({ method_ref: ADDRESS }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/MTHDS concepts/);
  });

  it("classifies a registry-form 501 at method_ref with the address-form hint", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 501",
            `${DEFAULT_API_URL}/v1/start`,
            501,
            "Not Implemented",
            "{}",
            undefined,
            "Registry-form refs are not implemented",
            undefined,
            undefined,
          ),
        ),
    });

    const result = await startMthdsRun({ method_ref: ADDRESS }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
    expect(result.structuredContent.errors?.[0]?.hint).toMatch(/address-form/i);
  });
});

describe("startMthdsRun by method_id", () => {
  function notFound(): ApiResponseError {
    return new ApiResponseError(
      "HTTP 404",
      `${DEFAULT_API_URL}/v1/start`,
      404,
      "Not Found",
      "{}",
      "not_found",
      "Method 'mt_missing' not found",
      undefined, // validationErrors
      "not_found",
    );
  }

  it("starts by id alone — method_id crosses as a named option, no mthds_contents", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID, state: "STARTED" });
      },
    });

    const result = await startMthdsRun(
      { method_id: "mt_abc123", inputs: { question: "why?" } },
      context,
    );

    expect(seen).toEqual({ method_id: "mt_abc123", inputs: { question: "why?" } });
    expect(seen).not.toHaveProperty("mthds_contents");
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("passes both when files and method_id are supplied (files run, id is linkage)", async () => {
    let seen: PipelexStartOptions | undefined;
    const context = contextWith({
      start: (options: PipelexStartOptions) => {
        seen = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID });
      },
    });

    await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_abc123" },
      context,
    );

    expect(seen).toEqual({
      mthds_contents: ['domain = "demo"'],
      method_id: "mt_abc123",
    });
  });

  it("does not call the client when neither files nor method_id is supplied", async () => {
    const result = await startMthdsRun({}, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files");
    expect(result.structuredContent.errors?.[0]?.message).toBe(
      "Provide MTHDS files, a method_ref address, or a method_id.",
    );
  });

  it("does not call the client on a blank method_id", async () => {
    const result = await startMthdsRun({ method_id: "   " }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_id");
  });

  it("classifies an unknown-method 404 as input_domain at method_id, not retryable", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun({ method_id: "mt_missing" }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toMatch(/org-scoped/);
    expect(error?.retryable).toBe(false);
  });

  it("keeps a files-only 404 as config at PIPELEX_BASE_URL (regression guard)", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.location).toBe("PIPELEX_BASE_URL");
  });

  it("classifies a paywall 402 as config with the billing hint", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 402",
            `${DEFAULT_API_URL}/v1/start`,
            402,
            "Payment Required",
            "{}",
            "subscription_required",
            "Subscription required to run methods",
            undefined, // validationErrors
            "forbidden",
          ),
        ),
    });

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("config");
    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("app.pipelex.com");
    // A headline-only host shows just this line, so it must name the plan
    // rather than the connectivity headline every other `config` error gets.
    expect(result.summary).toBe(
      "Run could not start: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("points a mixed-request 422 at files — the executed source — not method_id", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 422",
            `${DEFAULT_API_URL}/v1/start`,
            422,
            "Unprocessable Entity",
            "{}",
            "unprocessable_entity",
            "Pipe 'missing_pipe' not found in the submitted bundle",
            undefined, // validationErrors
            undefined, // code
          ),
        ),
    });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_abc123" },
      context,
    );

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("files");
    expect(error?.hint).toMatch(/files, pipe_code, and inputs/);
    expect(error?.retryable).toBe(false);
  });

  it("keeps a mixed-request 404 at method_id — the linkage id is what a 404 is about", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_missing" },
      context,
    );

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toMatch(/org-scoped/);
    expect(error?.retryable).toBe(false);
  });

  it("points a by-id 422 at method_id with the combined no-source/org-context hint", async () => {
    const context = contextWith({
      start: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 422",
            `${DEFAULT_API_URL}/v1/start`,
            422,
            "Unprocessable Entity",
            "{}",
            "unprocessable_entity",
            "Stored method 'mt_abc123' has no MTHDS source to run.",
            undefined, // validationErrors
            undefined, // code
          ),
        ),
    });

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(error?.hint).toMatch(/no MTHDS source/);
    expect(error?.hint).toMatch(/organization context/);
  });
});

// A 402 on a run route: the platform reports a plan limit this way, and its
// problem `code` really is "forbidden" (never sniffed — the status decides).
function paywall(routeSuffix: string): ApiResponseError {
  return new ApiResponseError(
    "HTTP 402",
    `${DEFAULT_API_URL}/v1/runs/${RUN_ID}${routeSuffix}`,
    402,
    "Payment Required",
    "{}",
    "subscription_required",
    "Subscription required",
    undefined, // validationErrors
    "forbidden",
  );
}

describe("getMthdsRunStatus", () => {
  it("reads and projects the status by id", async () => {
    let seenId: string | undefined;
    const context = contextWith({
      getRunStatus: (runId: string) => {
        seenId = runId;
        return Promise.resolve(runRead());
      },
    });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(seenId).toBe(RUN_ID);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_status).toBe("RUNNING");
  });

  it("does not call the client on a blank run_id", async () => {
    const result = await getMthdsRunStatus({ run_id: "  " }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("run_id");
  });

  it("classifies an unknown-id 404 as input_domain", async () => {
    const context = contextWith({
      getRunStatus: () =>
        Promise.reject(
          new ApiResponseError(
            "HTTP 404",
            `${DEFAULT_API_URL}/v1/runs/${RUN_ID}/status`,
            404,
            "Not Found",
            "{}",
            "not_found",
            "Run not found",
            undefined, // validationErrors
            undefined, // code
          ),
        ),
    });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("run_id");
  });

  it("headlines a paywall (402) as a plan limit, not as connectivity", async () => {
    const context = contextWith({ getRunStatus: () => Promise.reject(paywall("/status")) });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.summary).toBe(
      "Run status could not be read: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });
});

describe("getMthdsRunResults", () => {
  it("fetches and projects a completed result by id", async () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: { answer: 42 },
        graph_spec: { nodes: [] },
      },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("completed");
    expect(result.graphSpec).toEqual({ nodes: [] });
  });

  it("does not call the client on a blank run_id", async () => {
    const result = await getMthdsRunResults({ run_id: "" }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
  });

  it("classifies the SDK's MissingMainStuffError as runtime", async () => {
    const context = contextWith({
      getRunResult: () =>
        Promise.reject(new MissingMainStuffError("completed run has no main stuff", RUN_ID)),
    });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
  });

  it("treats a reachable but malformed completed result as runtime, not unreachable", async () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: null },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("runtime");
    expect(result.summary).toContain("malformed report");
  });

  it("headlines a paywall (402) as a plan limit, not as connectivity", async () => {
    const context = contextWith({ getRunResult: () => Promise.reject(paywall("/result")) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.errors?.[0]?.kind).toBe("paywall");
    expect(result.summary).toBe(
      "Run results could not be read: the organization's Pipelex plan does not cover this call.",
    );
    expect(result.summary).not.toMatch(/unreachable/);
  });
});

describe("runResultsToolResult", () => {
  it("delivers the graph and the full output on _meta, never on structuredContent", async () => {
    const huge = { text: "x".repeat(MAIN_STUFF_CAP * 2) };
    const tokensUsages: TokensUsageRecord[] = [
      { pipe_code: "extract", cost: 0.01, nb_tokens_by_category: { input: 100, output: 50 } },
      { pipe_code: "summarize", cost: 0.02, nb_tokens_by_category: { input: 40, output: 20 } },
    ];
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: huge,
        graph_spec: { nodes: [] },
        tokens_usages: tokensUsages,
      },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const toolResult = runResultsToolResult(await getMthdsRunResults({ run_id: RUN_ID }, context));

    expect(toolResult.isError).toBe(false);
    expect(toolResult._meta.graph_spec).toEqual({ nodes: [] });
    // _meta carries the FULL output, the raw per-call list, and the per-pipe rollup;
    // structuredContent carries only the bounded output and the run-level usage.
    expect(toolResult._meta.main_stuff).toBe(huge);
    expect(toolResult._meta.tokens_usages).toBe(tokensUsages);
    expect(toolResult._meta.usage_by_pipe).toEqual([
      { pipe_code: "summarize", cost_usd: 0.02, tokens: 60, calls: 1 },
      { pipe_code: "extract", cost_usd: 0.01, tokens: 150, calls: 1 },
    ]);
    // The run-level usage totals are in structuredContent; per-pipe is not.
    expect(toolResult.structuredContent.usage?.calls).toBe(2);
    expect(toolResult.structuredContent.usage).not.toHaveProperty("by_pipe");
    expect(toolResult.structuredContent.truncated).toBe(true);
    expect(JSON.stringify(toolResult.structuredContent.main_stuff).length).toBeLessThanOrEqual(
      MAIN_STUFF_CAP,
    );
  });

  it("flags error results as isError with empty _meta", async () => {
    const toolResult = runResultsToolResult(
      await getMthdsRunResults({ run_id: "" }, contextWith({})),
    );

    expect(toolResult.isError).toBe(true);
    expect(toolResult._meta.graph_spec).toBeUndefined();
    expect(toolResult._meta.main_stuff).toBeUndefined();
    expect(toolResult._meta.tokens_usages).toBeUndefined();
    expect(toolResult._meta.usage_by_pipe).toBeUndefined();
  });
});

describe("startMthdsRun path submissions", () => {
  it("resolves { path } items through the context resolver before starting", async () => {
    let seen: PipelexStartOptions | undefined;
    const context: RunContext = {
      ...contextWith({
        start: (options: PipelexStartOptions) => {
          seen = options;
          return Promise.resolve({ pipeline_run_id: RUN_ID });
        },
      }),
      resolver: {
        async resolve() {
          return { ok: true, content: 'domain = "demo"' };
        },
      },
    };

    const result = await startMthdsRun({ files: [{ path: "methods/bundle.mthds" }] }, context);

    // /v1/start takes no source labels — only the resolved contents cross.
    expect(seen).toEqual({ mthds_contents: ['domain = "demo"'] });
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.run_id).toBe(RUN_ID);
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await startMthdsRun(
      { files: [{ path: "methods/bundle.mthds" }] },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("files[0].path");
    expect(result.structuredContent.errors?.[0]?.hint).toContain("npx @pipelex/mcp");
    expect(result.summary).toBe("Run was not started: request input is invalid.");
  });
});
