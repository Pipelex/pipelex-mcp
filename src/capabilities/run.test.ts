import { describe, expect, it } from "vitest";

import { ApiResponseError, ApiUnreachableError, MissingMainStuffError } from "@pipelex/sdk";
import type {
  RunRead,
  RunResultStart,
  RunResultState,
  RunStatus,
  StartOptions,
} from "@pipelex/sdk";

import {
  boundMainStuff,
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
  start(options: StartOptions): Promise<RunResultStart>;
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
  it("maps MCP input to StartOptions and projects the ack", async () => {
    let seen: StartOptions | undefined;
    const context = contextWith({
      start: (options: StartOptions) => {
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

  it("omits pipe_code and inputs from StartOptions when not supplied", async () => {
    let seen: StartOptions | undefined;
    const context = contextWith({
      start: (options: StartOptions) => {
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
});

describe("runResultsToolResult", () => {
  it("delivers the graph and the full output on _meta, never on structuredContent", async () => {
    const huge = { text: "x".repeat(MAIN_STUFF_CAP * 2) };
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: huge, graph_spec: { nodes: [] } },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const toolResult = runResultsToolResult(await getMthdsRunResults({ run_id: RUN_ID }, context));

    expect(toolResult.isError).toBe(false);
    expect(toolResult._meta.graph_spec).toEqual({ nodes: [] });
    // _meta carries the FULL output; structuredContent the bounded copy.
    expect(toolResult._meta.main_stuff).toBe(huge);
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
  });
});

describe("startMthdsRun path submissions", () => {
  it("resolves { path } items through the context resolver before starting", async () => {
    let seen: StartOptions | undefined;
    const context: RunContext = {
      ...contextWith({
        start: (options: StartOptions) => {
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
