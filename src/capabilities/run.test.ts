import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  INLINE_TREE_MAX_BYTES,
  MissingMainStuffError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
  buildProblem,
} from "@pipelex/sdk";
import type {
  GetRunResultOptions,
  InputForm,
  MethodProvenance,
  OutputForm,
  PipeIOContracts,
  Problem,
  RunProgress,
  RunRead,
  RunResultArtifact,
  RunResults,
  RunResultStart,
  RunResultState,
  RunStatus,
  PipelexStartOptions,
  TokensUsageRecord,
  UsageSummary,
} from "@pipelex/sdk";

import {
  boundMainStuff,
  ELLIPSIS_MARKER,
  FAILED_RUN_READ_TIMEOUT_MS,
  getMthdsRunResults,
  getMthdsRunStatus,
  MAIN_STUFF_CAP,
  mthdsRunOutputSchema,
  mthdsRunResultsOutputSchema,
  mthdsRunStatusOutputSchema,
  PROGRESS_READ_TIMEOUT_MS,
  projectRunUsage,
  projectUsageByPipe,
  readFailedRun,
  readRunProgress,
  resultsResult,
  RUN_RESULTS_ARTIFACTS,
  runResultsToolResult,
  runStatusToolResult,
  runToolResult,
  startMthdsRun,
  startResult,
  statusResult,
  validateRunRequest,
} from "./run.js";
import type { FailedRunState, RunContext } from "./run.js";
import { localMethodFileResolver } from "../files.js";
import {
  OPERATOR_VIEW_LLM_COMPLETION_PROBLEM,
  RECORDED_FAILED_RUNS,
  TIMED_OUT_RUN_PROBLEM,
  relayingArmOf,
} from "./failed-run-fixtures.js";
import { MAX_PROGRESS_INVOCATIONS } from "./run-progress.js";
import {
  FAILED_RUN_SNAPSHOT,
  MID_RUN_SNAPSHOT,
  MID_RUN_SUMMARY,
  PENDING_SNAPSHOT,
  STUCK_ITEM_DEGRADATION,
  wideBatchSnapshot,
} from "./run-progress-fixtures.js";
import {
  createMethodVersionsMemories,
  methodVersionsOf,
  noteMethodVersionsSupported,
} from "./method-versions.js";
import {
  createPipelexApiClient,
  DEFAULT_API_URL,
  MAX_IMAGE_CANDIDATE_ENTRIES,
  problemSummary,
} from "./shared.js";
import type { MethodTreeToSend } from "./shared.js";
import { comparableRequest, contentsOf, fakeMethodResolver } from "./method-tree-fixtures.js";

/** A tree in hand, for the request checks, which only ask whether one is there. */
const A_TREE: MethodTreeToSend = {
  source: { files: [], digest: "", readFile: () => Promise.reject(new Error("never read")) },
  files: [],
  fromFolder: false,
};

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

/**
 * What `@pipelex/sdk` raises when the API answers `route` with `problem`: an
 * `ApiResponseError` built as the client builds it, which reads the problem
 * document from the answer's body, so the problem is the one the SDK reads.
 */
function answeredWith(route: string, problem: Problem): ApiResponseError {
  const status = problem.status ?? 500;
  return new ApiResponseError(
    `HTTP ${status}`,
    `${DEFAULT_API_URL}${route}`,
    status,
    "",
    JSON.stringify(problem),
  );
}

/** A Pipelex code's problem as the hosted API answers it, written out: `buildProblem` builds core codes alone. */
function pipelexProblem(
  code: string,
  members: {
    title: string;
    status: number;
    detail: string;
    domain: string;
    retry: string;
    next_step: { kind: string; detail: string };
    params?: Record<string, unknown>;
  },
): Problem {
  return { type: `https://docs.pipelex.com/errors/${code}`, code, ...members };
}

/** Where the workshop says the call's key and base URL came from, as `src/credentials.ts` sets them. */
const API_NOTES = {
  apiKey: "The API key in use is the one saved by the last login, in ~/.pipelex/.env.",
  baseUrl: "The base URL in use is PIPELEX_BASE_URL from this host's environment.",
};

/** The hosted API's refusal of a key it does not know, on `route`. */
function refusedKey(route: string): ApiResponseError {
  return answeredWith(route, buildProblem("auth.invalid_credential", {}, { status: 401 }));
}

/** The hosted API's refusal of a call for an organization with no credit left, on `route`. */
function outOfCredit(route: string): ApiResponseError {
  return answeredWith(
    route,
    pipelexProblem("pipelex.billing.credit_exhausted", {
      title: "The organization is out of credit",
      status: 402,
      detail: "The organization has no credit left, so the operation was refused.",
      domain: "account",
      retry: "no",
      next_step: {
        kind: "check_account",
        detail:
          "Add credit to the organization, or move it to a plan that includes more, then try again.",
      },
      params: {},
    }),
  );
}

/**
 * A minimal but REAL trio of I/O artifacts for one pipe. The protocol types are
 * closed shapes, so these are typed rather than cast: a literal that drifts
 * from the standard fails the build here instead of passing a test the wire
 * would reject.
 */
const FIXTURE_PIPE_REF = "demo.main";
const CONTRACTS: PipeIOContracts = {
  [FIXTURE_PIPE_REF]: {
    inputs: {},
    output: {
      concept_ref: "native.Text",
      json_schema: { type: "object", properties: { text: { type: "string" } } },
      multiplicity: "single",
      item_count: null,
      optional: false,
    },
  },
};
const OUTPUT_FORM: OutputForm = {
  [FIXTURE_PIPE_REF]: {
    field: { name: "result", kind: "text", required: true, concept_ref: "native.Text" },
  },
};
const INPUT_FORM: InputForm = { [FIXTURE_PIPE_REF]: { fields: [] } };

describe("validateRunRequest", () => {
  it("rejects a request naming no method", () => {
    const faults = validateRunRequest({});

    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ code: "client.argument_invalid", domain: "input" });
    expect(faults[0]?.location?.field).toBe("files");
  });

  it("accepts a method_id-only request", () => {
    expect(validateRunRequest({ method_id: "mt_abc123" })).toEqual([]);
  });

  it("rejects a blank method_id at method_id", () => {
    const faults = validateRunRequest({ method_id: "  " });

    expect(faults).toHaveLength(1);
    expect(faults[0]?.domain).toBe("input");
    expect(faults[0]?.location?.field).toBe("method_id");
  });

  it("rejects a blank pipe_code", () => {
    const faults = validateRunRequest({ tree: A_TREE, pipe_code: "  " });

    expect(faults.map((fault) => fault.location?.field)).toEqual(["pipe_code"]);
    expect(faults[0]).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      params: { argument: "pipe_code", reason: "empty" },
    });
    expect(faults[0]?.message).toContain("pipe_code must not be empty when supplied.");
  });

  it("accepts an omitted pipe_code", () => {
    const faults = validateRunRequest({ tree: A_TREE });

    expect(faults).toEqual([]);
  });
});

describe("the run routes' problems, relayed as the API answered them", () => {
  it("relays an unknown run id as run.not_found, alike on every run-id route", async () => {
    const notFound = (route: string) =>
      answeredWith(
        `/v1/runs/${RUN_ID}/${route}`,
        buildProblem("run.not_found", { pipeline_run_id: RUN_ID }, { status: 404 }),
      );
    const status = await getMthdsRunStatus(
      { run_id: RUN_ID },
      contextWith({ getRunStatus: () => Promise.reject(notFound("status")) }),
    );
    const results = await getMthdsRunResults(
      { run_id: RUN_ID },
      contextWith({ getRunResult: () => Promise.reject(notFound("results")) }),
    );

    for (const result of [status, results]) {
      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toMatchObject({
        code: "run.not_found",
        domain: "input",
        retry: "no",
        status: 404,
        params: { pipeline_run_id: RUN_ID },
        next_step: { kind: "change_input" },
      });
      expect(result.summary.startsWith("## No such run")).toBe(true);
    }
    expect(status.structuredContent.problem).toEqual(results.structuredContent.problem);
  });

  it("reads a server without the run routes as runtime.unsupported, saying where its base URL came from", async () => {
    const lifecycle = () =>
      Promise.reject(
        new RunLifecycleUnavailableError("no run lifecycle", `${DEFAULT_API_URL}/v1/start`),
      );

    const noted = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      { ...contextWith({ start: lifecycle }), apiNotes: API_NOTES },
    );
    const bare = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith({ start: lifecycle }),
    );

    expect(noted.structuredContent.problem).toMatchObject({
      code: "runtime.unsupported",
      retry: "no",
    });
    expect(noted.summary).toContain(API_NOTES.baseUrl);
    expect(noted.summary).not.toContain(API_NOTES.apiKey);
    // A context without notes names the environment variable.
    expect(bare.summary).toContain("PIPELEX_BASE_URL");
  });

  it("relays a start the platform refused before reaching the runner with its own retry verdict, adding nothing", async () => {
    const refusal = buildProblem("runtime.unavailable", {}, { status: 503 });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith({ start: () => Promise.reject(answeredWith("/v1/start", refusal)) }),
    );

    expect(result.structuredContent.problem).toEqual(refusal);
    expect(result.structuredContent.problem?.retry).toBe("yes");
    expect(result.summary).toBe(problemSummary(refusal));
    expect(result.summary).not.toMatch(/may have started/);
  });

  it("relays the platform's refusal of another organization's stored file as the inputs', with no note about the key", async () => {
    const crossOrg = pipelexProblem("pipelex.org.mismatch", {
      title: "The reference belongs to another organization",
      status: 403,
      detail: "The request's storage_uri belongs to an organization other than the caller's.",
      domain: "input",
      retry: "no",
      next_step: {
        kind: "change_input",
        detail:
          "Use a storage_uri of the organization the request acts for, then send the request again.",
      },
      params: { reference: "storage_uri" },
    });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], inputs: { doc: "pipelex-storage://org_b/x.pdf" } },
      {
        ...contextWith({ start: () => Promise.reject(answeredWith("/v1/start", crossOrg)) }),
        apiNotes: API_NOTES,
      },
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.org.mismatch",
      domain: "input",
      retry: "no",
      params: { reference: "storage_uri" },
    });
    // Not the key's note, which sends the user to check or replace the key.
    expect(result.summary).not.toContain(API_NOTES.apiKey);
    expect(result.summary).not.toContain("PIPELEX_API_KEY");

    // A refused key is the key's problem, and its summary says where the key came from.
    const refused = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      {
        ...contextWith({ start: () => Promise.reject(refusedKey("/v1/start")) }),
        apiNotes: API_NOTES,
      },
    );
    expect(refused.structuredContent.problem).toMatchObject({
      code: "auth.invalid_credential",
      domain: "account",
    });
    expect(refused.summary).toContain(API_NOTES.apiKey);
    expect(refused.summary).toContain(API_NOTES.baseUrl);
  });

  it("relays the location the API gives a refused start, rewriting none", async () => {
    const invalid = buildProblem(
      "request.invalid",
      { field: "inputs.question" },
      { status: 422, location: { field: "inputs.question" } },
    );

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], inputs: { question: 42 } },
      contextWith({ start: () => Promise.reject(answeredWith("/v1/start", invalid)) }),
    );

    expect(result.structuredContent.problem).toEqual(invalid);
    expect(result.structuredContent.problem?.location).toEqual({ field: "inputs.question" });
  });

  it("relays a refused run id on the run-id routes with the API's own location", async () => {
    const invalid = buildProblem(
      "request.invalid",
      { field: "run_id" },
      { status: 422, location: { field: "run_id" } },
    );
    const status = await getMthdsRunStatus(
      { run_id: "not-a-run-id" },
      contextWith({
        getRunStatus: () => Promise.reject(answeredWith("/v1/runs/not-a-run-id/status", invalid)),
      }),
    );
    const results = await getMthdsRunResults(
      { run_id: "not-a-run-id" },
      contextWith({
        getRunResult: () => Promise.reject(answeredWith("/v1/runs/not-a-run-id/results", invalid)),
      }),
    );

    for (const result of [status, results]) {
      expect(result.structuredContent.problem).toEqual(invalid);
    }
  });

  it("gives every no-verdict result a problem its tool's output schema accepts", async () => {
    const start = await startMthdsRun({}, contextWith({}));
    const status = await getMthdsRunStatus({ run_id: " " }, contextWith({}));
    const results = await getMthdsRunResults(
      { run_id: RUN_ID },
      contextWith({ getRunResult: () => Promise.reject(refusedKey(`/v1/runs/${RUN_ID}/results`)) }),
    );

    expect(mthdsRunOutputSchema.safeParse(start.structuredContent).success).toBe(true);
    expect(mthdsRunStatusOutputSchema.safeParse(status.structuredContent).success).toBe(true);
    expect(mthdsRunResultsOutputSchema.safeParse(results.structuredContent).success).toBe(true);
    for (const result of [start, status, results]) {
      expect(result.structuredContent).not.toHaveProperty("errors");
      expect(Array.isArray(result.structuredContent.problem)).toBe(false);
    }
    // The text stream is the problem's summary, nothing added.
    expect(runStatusToolResult(status).content[0].text).toBe(status.summary);
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
      available_view_specs: [],
    });
    expect(result.summary).toContain(RUN_ID);
    expect(result.summary).toContain("mthds_run_status");
    expect(result.summary).toContain("mthds_run_results");
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

  it("does not advertise or narrate a live card", () => {
    const result = startResult({ pipeline_run_id: RUN_ID });

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
    expect(result.structuredContent).not.toHaveProperty("problem");
  });

  it("carries why a failed run ended, from the problem its status read serves", () => {
    const { statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
    const result = statusResult(statusRead);

    expect(result.structuredContent.error).toEqual(statusRead.error);
    expect(result.structuredContent.error).toMatchObject({
      code: "model.unavailable",
      domain: "operator",
      retry: "no",
    });
    expect(mthdsRunStatusOutputSchema.safeParse(result.structuredContent).success).toBe(true);
    // The problem's title, detail, next step and verdict, and the support line, in the summary.
    expect(result.summary).toContain(`Run \`${statusRead.pipeline_run_id}\` ended FAILED.`);
    expect(result.summary).toContain("## This deployment serves no backend for the model");
    expect(result.summary).toContain(
      "**Next step** (`change_model`): Use a model this deployment serves in place of 'claude-4.8-opus', or ask whoever runs the runtime to serve it.",
    );
    expect(result.summary).toContain("- Code: `model.unavailable` (domain operator, retry no)");
    expect(result.summary).toContain(
      `For support: Run ${statusRead.pipeline_run_id} · model.unavailable · ended 2026-09-23T15:16:37.856067+00:00`,
    );
    // No promise of details elsewhere: the details are here.
    expect(result.summary).not.toContain("returns the failure details");
  });

  it("states the retry verdict the problem gives, inferring none", () => {
    const result = statusResult(RECORDED_FAILED_RUNS.sandboxProvisioning.statusRead);

    expect(result.structuredContent.error).toMatchObject({
      code: "pipelex.sandbox.unavailable",
      retry: "yes",
    });
    expect(result.summary).toContain(
      "- Code: `pipelex.sandbox.unavailable` (domain runtime, retry yes)",
    );
    expect(result.summary).toContain("Run the method again after a while.");
  });

  it("drops the operator's diagnostics from the problem a status read serves", () => {
    const result = statusResult(
      runRead({
        status: "FAILED",
        finished_at: "2026-07-15T10:05:00Z",
        error: OPERATOR_VIEW_LLM_COMPLETION_PROBLEM,
      }),
    );

    expect(result.structuredContent.error).not.toHaveProperty("diagnostics");
    expect(result.structuredContent.error?.code).toBe("model.unavailable");
    expect(JSON.stringify(result)).not.toContain("not allowed for this integration");
  });

  it("carries the status alone, and says so, when the read has no problem or one that is no problem document", () => {
    const notProblems = [
      null,
      undefined,
      "boom",
      { provider_metadata: { message: "raw" } },
      { error_type: "LLMCompletionError", title: "LLM completion", retryable: false },
    ];
    for (const error of notProblems) {
      const result = statusResult(
        runRead({
          status: "CANCELLED",
          finished_at: "2026-07-15T10:05:00Z",
          error: error as never,
        }),
      );

      expect(result.structuredContent).not.toHaveProperty("error");
      expect(result.structuredContent.run_status).toBe("CANCELLED");
      expect(result.summary).toContain("The run stored no problem saying why it ended");
      expect(result.summary).toContain(`For support: Run ${RUN_ID} · ended 2026-07-15T10:05:00Z`);
    }
  });

  it("carries no problem on a completed run or a live one, whatever the read holds", () => {
    const runError = RECORDED_FAILED_RUNS.llmCompletion.statusRead.error;
    for (const status of ["COMPLETED", "RUNNING"] as const) {
      expect(
        statusResult(runRead({ status, error: runError })).structuredContent,
      ).not.toHaveProperty("error");
    }
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

  describe("with the run's progress", () => {
    const REASSURANCE = "The run itself is unaffected.";

    it("relays a running run's snapshot and gives its summary a paragraph right after the status", () => {
      const result = statusResult(
        runRead({ status: "RUNNING", retry_after_seconds: 5 }),
        MID_RUN_SNAPSHOT,
      );

      expect(result.structuredContent.progress).toEqual(MID_RUN_SNAPSHOT);
      expect(result.structuredContent).not.toHaveProperty("progress_invocations_omitted");
      expect(result.summary).toBe(
        [
          `Run \`${RUN_ID}\` is RUNNING — not terminal yet. Check again in ~5s.`,
          `Progress: ${MID_RUN_SUMMARY}`,
        ].join("\n\n"),
      );
    });

    it("relays a pending run's snapshot", () => {
      const result = statusResult(runRead({ status: "PENDING" }), PENDING_SNAPSHOT);

      expect(result.structuredContent.progress).toEqual(PENDING_SNAPSHOT);
      expect(result.summary.split("\n\n")).toEqual([
        expect.stringContaining("is PENDING — not terminal yet"),
        "Progress: Waiting to start",
      ]);
    });

    it("relays an ended run's snapshot after the whole account of why it ended", () => {
      const { statusRead } = RECORDED_FAILED_RUNS.llmCompletion;

      const result = statusResult(statusRead, FAILED_RUN_SNAPSHOT);
      const progress =
        "Progress: Failed at condense_filing (step 3 of 4, item 2 of 3, step 2 of 2)";

      expect(result.structuredContent.error).toMatchObject({ code: "model.unavailable" });
      expect(result.structuredContent.progress?.status).toBe("failed");
      expect(result.summary.startsWith(`Run \`${statusRead.pipeline_run_id}\` ended FAILED.`)).toBe(
        true,
      );
      expect(result.summary.endsWith(`\n\n${progress}`)).toBe(true);
      expect(result.summary.indexOf("## This deployment serves no backend")).toBeLessThan(
        result.summary.indexOf(`For support: Run ${statusRead.pipeline_run_id}`),
      );
      expect(result.summary.indexOf("For support:")).toBeLessThan(result.summary.indexOf(progress));
    });

    it("counts the invocations a wide snapshot leaves out beside it", () => {
      const snapshot = wideBatchSnapshot(40, 39);

      const result = statusResult(runRead({ status: "RUNNING" }), snapshot);

      expect(result.structuredContent.progress?.invocations).toHaveLength(MAX_PROGRESS_INVOCATIONS);
      expect(result.structuredContent.progress_invocations_omitted).toBe(
        snapshot.invocations.length - MAX_PROGRESS_INVOCATIONS,
      );
      expect(result.structuredContent.progress?.invocations.map((each) => each.path)).toContain(
        "filings.review_filings/step_1/item_39/step_2",
      );
    });

    it("answers the status alone from a snapshot it cannot read", () => {
      const result = statusResult(runRead({ status: "RUNNING" }), {
        ...MID_RUN_SNAPSHOT,
        summary: undefined,
      } as unknown as RunProgress);

      expect(result.structuredContent.status).toBe("ok");
      expect(result.structuredContent).not.toHaveProperty("progress");
      expect(result.summary).not.toContain("Progress:");
    });

    it("never reassures a run whose workflow task keeps failing, which its progress says is not progressing", () => {
      const result = statusResult(
        runRead({ status: "RUNNING", degraded: true, degradation: STUCK_ITEM_DEGRADATION }),
        MID_RUN_SNAPSHOT,
      );

      expect(result.structuredContent.degraded).toBe(true);
      expect(result.summary).toContain("not progressing at summarize_filing");
      expect(result.summary).not.toContain(REASSURANCE);
    });

    it("gives no reassurance for a degradation the status read cannot explain by the engine's absence", () => {
      for (const reason of ["workflow_task_failing", "a_later_reason"]) {
        const result = statusResult(
          runRead({ status: "RUNNING", degraded: true, degradation: { reason } }),
        );

        expect(result.summary).not.toContain(REASSURANCE);
      }
    });

    it("reassures a status the platform could not read, unless the progress read after it reports the run stuck", () => {
      const unreadable = runRead({
        status: "RUNNING",
        degraded: true,
        degradation: { reason: "status_unavailable" },
      });

      expect(statusResult(unreadable).summary).toContain(REASSURANCE);
      expect(statusResult(unreadable, PENDING_SNAPSHOT).summary).toContain(REASSURANCE);
      expect(statusResult(runRead({ status: "RUNNING", degraded: true })).summary).toContain(
        REASSURANCE,
      );
      expect(statusResult(unreadable, MID_RUN_SNAPSHOT).summary).not.toContain(REASSURANCE);
    });
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
    expect(result.mainStuff).toBeUndefined();
  });

  it("names mthds_download_artifacts on every completed result", () => {
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

    // The workshop: files produced → the nudge, output and files, with the expiry stated.
    const workshop = resultsResult(withFiles);
    expect(workshop.summary).toContain("mthds_download_artifacts");
    expect(workshop.summary).toContain("main_stuff.json");
    expect(workshop.summary).toContain("1 stored file(s)");
    expect(workshop.summary).toContain("expire");
    // The nudge is prose only — the structured contract is untouched.
    expect(workshop.structuredContent).not.toHaveProperty("artifacts");

    // The workshop, nothing produced → still the way to keep the output, since
    // a model that does not know the tool retypes the output into a file.
    const outputOnly = resultsResult(withoutFiles).summary;
    expect(outputOnly).toContain("mthds_download_artifacts");
    expect(outputOnly).toContain("main_stuff.json");
    expect(outputOnly).toContain("Never retype it");
    expect(outputOnly).not.toContain("stored file(s)");
  });

  it("lists the image candidates, for free, from the FULL output", () => {
    const picture = "pipelex-storage://runs/x/illustration.png";
    const report = "pipelex-storage://runs/x/report.pdf";
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: { cover: { url: picture }, appendix: { url: report } },
      },
    };

    const result = resultsResult(state);
    // Bare references: the key beside them was a fixed-prefix strip of the
    // reference itself, so it doubled the list's cost and said nothing new.
    expect(result.structuredContent.image_candidates).toEqual([picture]);
    expect(result.structuredContent).not.toHaveProperty("image_candidates_omitted");

    const summary = result.summary;
    expect(summary).toContain("2 stored file(s)");
    expect(summary).toContain("1 of which look like images");
    expect(summary).toContain("mthds_show_images");
  });

  it("survives a main output bounded away from its references", () => {
    const picture = "pipelex-storage://runs/x/illustration.png";
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        // Big enough that the prune ladder cuts the reference out of the
        // model-facing copy; the candidate list still finds it.
        main_stuff: { filler: "x".repeat(MAIN_STUFF_CAP * 2), cover: { url: picture } },
      },
    };

    const result = resultsResult(state);

    expect(result.structuredContent.truncated).toBe(true);
    expect(result.structuredContent.image_candidates).toEqual([picture]);
  });

  it("bounds the candidate inventory and counts what it left out", () => {
    // The walk reads the FULL output deliberately, so an unbounded projection
    // of it was model-facing content outside the MAIN_STUFF_CAP discipline
    // main_stuff obeys beside it — round 1's three-reviewer finding.
    const pictures = Array.from(
      { length: MAX_IMAGE_CANDIDATE_ENTRIES + 9 },
      (_unused, index) => `pipelex-storage://runs/x/frame-${index}.png`,
    );
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: pictures.map((url) => ({ url })),
      },
    };

    const result = resultsResult(state);

    expect(result.structuredContent.image_candidates).toHaveLength(MAX_IMAGE_CANDIDATE_ENTRIES);
    // A prefix, so an index into this list means the same thing it means to
    // mthds_show_images, which still walks the whole set.
    expect(result.structuredContent.image_candidates).toEqual(
      pictures.slice(0, MAX_IMAGE_CANDIDATE_ENTRIES),
    );
    expect(result.structuredContent.image_candidates_omitted).toBe(9);
  });

  it("says nothing of files, and omits the member, when the output references no stored file", () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: { answer: 42 } },
    };

    const result = resultsResult(state);

    expect(result.structuredContent).not.toHaveProperty("image_candidates");
    expect(result.summary).not.toContain("mthds_show_images");
    expect(result.summary).not.toContain("stored file(s)");
  });

  it("names the download tool as the way to read a truncated output", () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: { memo: "x".repeat(MAIN_STUFF_CAP * 2) } },
    };

    const workshop = resultsResult(state);
    expect(workshop.structuredContent.truncated).toBe(true);
    expect(workshop.summary).toContain("truncated to fit the response");
    expect(workshop.summary).toContain("saves all of it to disk");
    // One mention, not two: without files, the truncation sentence is the save note.
    expect(workshop.summary.split("mthds_download_artifacts")).toHaveLength(2);
  });

  it("reports stored files that look like nothing without naming the image tool", () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: { doc: { url: "pipelex-storage://runs/x/report.pdf" } },
      },
    };

    const result = resultsResult(state);

    expect(result.structuredContent.image_candidates).toEqual([]);
    expect(result.summary).toContain("none of them looks like an image");
    expect(result.summary).not.toContain("mthds_show_images");
    expect(result.summary).toContain("mthds_download_artifacts");
  });

  it("projects a completed run and carries the full output off structuredContent", () => {
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
    expect(result.structuredContent).not.toHaveProperty("graph_spec");
    expect(result.mainStuff).toBe(mainStuff);
    expect(result.summary).toContain("```json");
    expect(result.summary).toContain('"answer": 42');
    // No tokens_usages on the wire → usage reads "unavailable", nothing on _meta.
    expect(result.structuredContent.usage).toEqual({
      state: "unavailable",
      cost_usd: null,
      tokens: null,
      calls: 0,
      assembly_error: null,
    });
    expect(result.tokensUsages).toBeUndefined();
    expect(result.summary).not.toContain("## Usage");
  });

  it("keeps the graph's data artifacts off structuredContent", () => {
    const contracts = CONTRACTS;
    const outputForm = OUTPUT_FORM;
    const inputForm = INPUT_FORM;
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: "done",
        graph_spec: { nodes: [{ id: "demo.main" }] },
        pipe_io_contracts: contracts,
        output_form: outputForm,
        input_form: inputForm,
      },
    });

    // Never the model-facing channel.
    expect(result.structuredContent).not.toHaveProperty("pipe_io_contracts");
    expect(result.structuredContent).not.toHaveProperty("output_form");
    expect(result.structuredContent).not.toHaveProperty("input_form");
  });

  it("does not advertise a view but preserves full result metadata", () => {
    const mainStuff = { answer: "x".repeat(MAIN_STUFF_CAP * 2) };
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: {
        pipeline_run_id: RUN_ID,
        main_stuff: mainStuff,
        graph_spec: { nodes: [{ id: "demo.main" }] },
      },
    });

    expect(result.structuredContent.available_view_specs).toEqual([]);
    expect(result.structuredContent.truncated).toBe(true);
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
  });

  it("bounds a huge completed output and keeps the full copy", () => {
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
    expect(usage?.state).toBe("records");
    expect(usage?.cost_usd).toBeCloseTo(0.023, 10);
    expect(usage?.tokens).toBe(12500);
    expect(usage?.calls).toBe(2);
    expect(usage).not.toHaveProperty("cost_partial");
    expect(usage?.assembly_error).toBeNull();
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

  it("reads usage as unavailable, and keeps the completed result, when the run reported none", () => {
    const result = resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", tokens_usages: null },
    });

    expect(result.structuredContent.state).toBe("completed");
    expect(result.structuredContent.usage?.state).toBe("unavailable");
    expect(result.structuredContent.usage?.assembly_error).toBeNull();
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

  it("projects a failed run with no problem as a produced ok verdict with its status", () => {
    const failedArm = relayingArmOf(RUN_ID, null);
    const result = resultsResult(failedArm, runRead({ status: "FAILED", error: null }));

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "FAILED",
      available_view_specs: [],
    });
    expect(result.summary).toContain(`Run \`${RUN_ID}\` ended FAILED.`);
    expect(result.summary).toContain("The run stored no problem saying why it ended");
    expect(result.summary).toMatch(/no graph/i);
  });

  it("bounds the run's problem the failed arm relays", () => {
    const result = resultsResult(
      relayingArmOf(RUN_ID, { ...TIMED_OUT_RUN_PROBLEM, detail: "y".repeat(100_000) }),
    );

    expect(result.structuredContent.run_error?.detail.length).toBeLessThan(2_100);
    expect(result.structuredContent.run_error?.detail).toMatch(/more characters left out\]$/);
    expect(result.summary.length).toBeLessThan(3_000);
    expect(mthdsRunResultsOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it("says the reason is unknown, not missing, when the status read after a bare failed arm failed", () => {
    const result = resultsResult(relayingArmOf(RUN_ID, null));

    expect(result.summary).toContain("Why it ended is unknown for now");
    expect(result.summary).not.toContain("stored no problem");
  });

  it("carries neither the arm's own sentence nor its run.failed problem, only the run's own", () => {
    // The arm's `message` is the `run.failed` detail, and its `problem` says only
    // that the run did not succeed, which `state` and `run_status` already say:
    // neither reaches the result, whatever text the arm holds.
    const arm: FailedRunState = {
      ...relayingArmOf(RUN_ID, null, "TIMED_OUT"),
      message: "Run finished with status TIMED_OUT: Traceback (most recent call last): …",
    };

    const result = resultsResult(arm);

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "TIMED_OUT",
      available_view_specs: [],
    });
    expect(JSON.stringify(result)).not.toContain("Traceback");
    expect(result.summary).not.toContain("run.failed");
  });

  it("reads the platform's 409 through the SDK into the run's own problem, in the caller's view", async () => {
    const runError = {
      ...TIMED_OUT_RUN_PROBLEM,
      pipeline_run_id: RUN_ID,
      diagnostics: { text: "engine text" },
    };
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          buildProblem(
            "run.failed",
            { pipeline_run_id: RUN_ID, run_status: "TIMED_OUT" },
            { status: 409, pipeline_run_id: RUN_ID, extra: { run_error: runError } },
          ),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
      ),
    );
    try {
      const arm = await createPipelexApiClient({ baseUrl: DEFAULT_API_URL }).getRunResult(RUN_ID);
      if (arm.state !== "failed") throw new Error("the SDK did not read the 409 as a failed arm");

      expect(arm.status).toBe("TIMED_OUT");
      const { diagnostics: _operatorOnly, ...callerView } = runError;
      expect(resultsResult(arm).structuredContent).toEqual({
        status: "ok",
        run_id: RUN_ID,
        state: "failed",
        run_status: "TIMED_OUT",
        run_error: callerView,
        available_view_specs: [],
      });
      expect(JSON.stringify(resultsResult(arm))).not.toContain("engine text");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries the problem the failed arm relays, with when the run ended from the status read", () => {
    const { relayedArm, statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
    const result = resultsResult(relayedArm, { ...statusRead, error: null });

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: statusRead.pipeline_run_id,
      state: "failed",
      run_status: "FAILED",
      run_error: statusRead.error,
      available_view_specs: [],
    });
    expect(result.summary).toContain("# Run failed");
    expect(result.summary).toContain("## This deployment serves no backend for the model");
    expect(result.summary).toContain("**Next step** (`change_model`)");
    expect(result.summary).toContain("- Code: `model.unavailable` (domain operator, retry no)");
    expect(result.summary).toContain(
      `For support: Run ${statusRead.pipeline_run_id} · model.unavailable · ended ${statusRead.finished_at ?? ""}`,
    );
  });

  it("drops the operator's diagnostics from a problem the failed arm relays", () => {
    const arm = relayingArmOf(RUN_ID, OPERATOR_VIEW_LLM_COMPLETION_PROBLEM);
    const result = resultsResult(
      arm,
      runRead({ status: "FAILED", finished_at: "2026-07-15T10:05:00Z", error: null }),
    );

    const { diagnostics: _operatorOnly, ...callerView } = OPERATOR_VIEW_LLM_COMPLETION_PROBLEM;
    expect(result.structuredContent.run_error).toEqual(callerView);
    expect(JSON.stringify(result)).not.toContain("not allowed for this integration");
  });

  it("relays the problem the platform writes for a run it timed out, its next step included", () => {
    const arm = relayingArmOf(RUN_ID, TIMED_OUT_RUN_PROBLEM, "TIMED_OUT");
    const result = resultsResult(
      arm,
      runRead({ status: "TIMED_OUT", finished_at: "2026-07-15T10:05:00Z", error: null }),
    );

    expect(result.structuredContent).toEqual({
      status: "ok",
      run_id: RUN_ID,
      state: "failed",
      run_status: "TIMED_OUT",
      run_error: TIMED_OUT_RUN_PROBLEM,
      available_view_specs: [],
    });
    expect(result.summary).toContain(`Run \`${RUN_ID}\` ended TIMED_OUT.`);
    expect(result.summary).toContain(
      "**Next step** (`contact_owner`): Ask the method's owner to make the method end within the deployment's run limit.",
    );
  });

  it("takes the problem from the status read when the failed arm carries none", () => {
    const { resultsArm, statusRead } = RECORDED_FAILED_RUNS.sandboxProvisioning;
    const result = resultsResult(resultsArm, statusRead);

    expect(resultsArm.error).toBeNull();
    expect(result.structuredContent.run_error).toEqual(statusRead.error);
    expect(result.summary).toContain(
      "- Code: `pipelex.sandbox.unavailable` (domain runtime, retry yes)",
    );
  });
});

describe("projectRunUsage", () => {
  function summary(overrides: Partial<UsageSummary> = {}): UsageSummary {
    return {
      state: "records",
      total_cost_usd: 0.03,
      cost_partial: false,
      tokens: { input: 100, output: 50 },
      calls: 2,
      assembly_error: null,
      by_pipe: [],
      ...overrides,
    };
  }

  it("keeps this tool's field names over the SDK's summary, with the state first", () => {
    expect(projectRunUsage(summary())).toEqual({
      state: "records",
      cost_usd: 0.03,
      tokens: 150,
      calls: 2,
      assembly_error: null,
    });
  });

  it("adds the input and output totals into one figure, null only when both are null", () => {
    expect(projectRunUsage(summary({ tokens: { input: 100, output: null } })).tokens).toBe(100);
    expect(projectRunUsage(summary({ tokens: { input: null, output: 7 } })).tokens).toBe(7);
    expect(projectRunUsage(summary({ tokens: { input: null, output: null } })).tokens).toBeNull();
    expect(projectRunUsage(summary({ tokens: { input: 0, output: 0 } })).tokens).toBe(0);
  });

  it("reads a blank assembly error as no error", () => {
    // The SDK relays the runner's field verbatim; a non-null value here means
    // "assembly failed", so a runner reporting an empty string must not be
    // reported as a run whose usage assembly broke.
    expect(
      projectRunUsage(summary({ state: "unavailable", assembly_error: "" })).assembly_error,
    ).toBeNull();
    expect(
      projectRunUsage(summary({ state: "unavailable", assembly_error: "   " })).assembly_error,
    ).toBeNull();
    expect(
      projectRunUsage(summary({ state: "unavailable", assembly_error: "collector timed out" }))
        .assembly_error,
    ).toBe("collector timed out");
  });

  it("carries cost_partial only when it is true", () => {
    expect(projectRunUsage(summary({ cost_partial: true })).cost_partial).toBe(true);
    expect(projectRunUsage(summary())).not.toHaveProperty("cost_partial");
  });

  it("never carries the per-pipe rollup — that rides _meta only", () => {
    const usage = projectRunUsage(
      summary({
        by_pipe: [
          {
            pipe_code: "a",
            total_cost_usd: 0.03,
            cost_partial: false,
            tokens: { input: 100, output: 50 },
            calls: 2,
          },
        ],
      }),
    );

    expect(usage).not.toHaveProperty("by_pipe");
  });
});

describe("projectUsageByPipe", () => {
  it("projects each SDK row onto this tool's row shape, keeping the SDK's order", () => {
    expect(
      projectUsageByPipe([
        {
          pipe_code: "pricey",
          total_cost_usd: 0.07,
          cost_partial: false,
          tokens: { input: 140, output: 60 },
          calls: 2,
        },
        {
          pipe_code: null,
          total_cost_usd: null,
          cost_partial: false,
          tokens: { input: null, output: null },
          calls: 1,
        },
      ]),
    ).toEqual([
      { pipe_code: "pricey", cost_usd: 0.07, tokens: 200, calls: 2 },
      { pipe_code: null, cost_usd: null, tokens: null, calls: 1 },
    ]);
  });
});

describe("usage through the SDK's summarizeUsage", () => {
  function completedWith(overrides: Partial<RunResults>) {
    return resultsResult({
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: "done", ...overrides },
    });
  }

  function record(overrides: Partial<TokensUsageRecord> = {}): TokensUsageRecord {
    return {
      pipe_code: "demo",
      cost: 0.01,
      nb_tokens_by_category: { input: 100, output: 50 },
      ...overrides,
    };
  }

  it("reads an empty list as no inference: zero cost, zero tokens, an empty rollup", () => {
    const result = completedWith({ tokens_usages: [] });

    expect(result.structuredContent.usage).toEqual({
      state: "no_inference",
      cost_usd: 0,
      tokens: 0,
      calls: 0,
      assembly_error: null,
    });
    expect(result.usageByPipe).toEqual([]);
  });

  it("branches on usage_assembly_error, not the null list, when assembly broke", () => {
    const result = completedWith({
      tokens_usages: null,
      usage_assembly_error: "artifact read failed",
    });

    expect(result.structuredContent.usage).toEqual({
      state: "unavailable",
      cost_usd: null,
      tokens: null,
      calls: 0,
      assembly_error: "artifact read failed",
    });
  });

  it("returns a null cost (not 0) when calls happened but none were priced", () => {
    const usage = completedWith({
      tokens_usages: [record({ cost: null }), record({ cost: undefined })],
    }).structuredContent.usage;

    expect(usage?.state).toBe("records");
    expect(usage?.cost_usd).toBeNull();
    expect(usage?.tokens).toBe(300);
    expect(usage).not.toHaveProperty("cost_partial");
  });

  it("flags cost_partial when the run mixes priced and unpriced calls", () => {
    const usage = completedWith({
      tokens_usages: [record({ cost: 0.02 }), record({ cost: null })],
    }).structuredContent.usage;

    expect(usage?.cost_usd).toBeCloseTo(0.02, 10);
    expect(usage?.cost_partial).toBe(true);
  });

  it("returns null tokens when no record reported input or output counts", () => {
    const usage = completedWith({
      tokens_usages: [
        record({ nb_tokens_by_category: null }),
        record({ nb_tokens_by_category: {} }),
      ],
    }).structuredContent.usage;

    expect(usage?.tokens).toBeNull();
  });

  it("orders the per-pipe rollup the SDK's way — unattributed calls last on a tie", () => {
    const result = completedWith({
      tokens_usages: [
        record({ pipe_code: null, cost: 0.01 }),
        record({ pipe_code: "named", cost: 0.01 }),
        record({ pipe_code: "pricey", cost: 0.05 }),
      ],
    });

    expect(result.usageByPipe?.map((row) => row.pipe_code)).toEqual(["pricey", "named", null]);
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
  getRunStatus(runId: string, options?: { signal?: AbortSignal }): Promise<RunRead>;
  getRunProgress(runId: string, options?: { signal?: AbortSignal }): Promise<RunProgress>;
  getRunResult(runId: string, options?: GetRunResultOptions): Promise<RunResultState>;
  version?(): Promise<unknown>;
}

const NEVER_CLIENT: FakeRunClient = {
  start: () => Promise.reject(new Error("start must not be called")),
  getRunStatus: () => Promise.reject(new Error("getRunStatus must not be called")),
  getRunProgress: () => Promise.reject(new Error("getRunProgress must not be called")),
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

    // The contents cross as a tree, under the uri's file name.
    expect(await comparableRequest(seen)).toEqual({
      tree: { "demo.mthds": 'domain = "demo"' },
      pipe_code: "main",
      inputs: { question: "why?" },
    });
    expect(result.structuredContent.files_sent).toEqual(["demo.mthds"]);
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

    expect(await comparableRequest(seen)).toEqual({ tree: { "bundle.mthds": 'domain = "demo"' } });
    expect(seen).not.toHaveProperty("pipe_code");
    expect(seen).not.toHaveProperty("inputs");
  });

  it("does not call the client when request validation fails", async () => {
    const result = await startMthdsRun({ files: [] }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
    });
    expect(result.structuredContent.available_view_specs).toEqual([]);
  });

  it("relays an unreachable API as client.unreachable, retryable, saying where its base URL came from", async () => {
    const context = {
      ...contextWith({
        start: () =>
          Promise.reject(
            new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
          ),
      }),
      apiNotes: API_NOTES,
    };

    const result = await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);

    expect(result.structuredContent.status).toBe("error");
    // Refused before it was sent: no run exists, so a retry is safe.
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.unreachable",
      retry: "yes",
    });
    expect(result.summary).toContain(API_NOTES.baseUrl);
    expect(result.summary).not.toMatch(/may have started/);
  });

  /**
   * The error `@pipelex/sdk`'s own `start` raises for `answer`, a response or a
   * transport failure: built by the client itself, so it carries the
   * `runMayHaveStarted` reading the SDK gives a start, which a hand-built error
   * does not.
   */
  async function startFailure(answer: () => Promise<Response>): Promise<unknown> {
    vi.stubGlobal("fetch", answer);
    try {
      await createPipelexApiClient({ baseUrl: DEFAULT_API_URL }).start({
        files: { "main.mthds": 'domain = "demo"' },
      });
    } catch (err) {
      return err;
    } finally {
      vi.unstubAllGlobals();
    }
    throw new Error("the start did not fail");
  }

  /** An answer of `status` whose body is no problem document, holding `members`. */
  function answered(status: number, members: Record<string, unknown> = {}) {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify({ status, detail: "Failed to start pipeline", ...members }), {
          status,
          headers: { "content-type": "application/problem+json" },
        }),
      );
  }

  /** An answer of `status` whose body is the problem document `problem`. */
  function problemAnswer(status: number, problem: Problem) {
    return () =>
      Promise.resolve(
        new Response(JSON.stringify(problem), {
          status,
          headers: { "content-type": "application/problem+json" },
        }),
      );
  }

  /** A transport failure as undici reports it: fetch's `TypeError`, the socket's error as its cause. */
  function cutOff(code: string, syscall: string) {
    return () =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error(code), { code, syscall }),
        }),
      );
  }

  /** What the summary of a start that may have created a run opens with, read from its `retry`. */
  const MAY_HAVE_STARTED = /^Run may have started: /;

  it("relays client.outcome_unknown when the failed start may have created a run, and reads its retry", async () => {
    // A start creates a paid run and sends no idempotency key: after a dropped
    // connection, or a gateway's 502/504, a 408, a 500 or a 503 whose body is
    // no problem document, the SDK reads the run as one that may exist.
    const answers = [
      cutOff("ECONNRESET", "read"),
      answered(504),
      answered(502),
      answered(408),
      answered(500),
      answered(503),
    ];
    for (const answer of answers) {
      const failure = await startFailure(answer);
      const result = await startMthdsRun(
        { files: [{ content: 'domain = "demo"' }] },
        contextWith({ start: () => Promise.reject(failure) }),
      );

      expect(result.structuredContent.problem).toMatchObject({
        code: "client.outcome_unknown",
        retry: "outcome_unknown",
        next_step: { kind: "read_run" },
      });
      // The headline some hosts show alone must not say the run did not start.
      expect(result.summary).toMatch(MAY_HAVE_STARTED);
      expect(result.summary).not.toMatch(/could not (be )?start/);
      // The problem's own rendering follows the opening line.
      expect(result.summary).toContain("## The call may have created a run");
    }
  });

  it("reads an answer that is no problem document as an unknown outcome, and a problem document as the server's own verdict", async () => {
    // The runner's old catch-all 500 body, no problem document: the SDK still
    // reads the run as one that may exist, whatever the body says of retrying.
    const legacy = await startFailure(
      answered(500, {
        error_type: "UnexpectedError",
        detail: "An unexpected error occurred",
        error_domain: "runtime",
        retryable: false,
      }),
    );
    const legacyResult = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith({ start: () => Promise.reject(legacy) }),
    );
    expect(legacyResult.structuredContent.problem?.code).toBe("client.outcome_unknown");
    expect(legacyResult.summary).toMatch(MAY_HAVE_STARTED);

    // A problem document is the server's own word on the start, relayed as it came.
    const stated = await startFailure(
      problemAnswer(500, buildProblem("runtime.unexpected", {}, { status: 500 })),
    );
    const statedResult = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith({ start: () => Promise.reject(stated) }),
    );
    expect(statedResult.structuredContent.problem).toMatchObject({
      code: "runtime.unexpected",
      retry: "no",
    });
    expect(statedResult.summary).not.toMatch(/may have started/);
  });

  it("reads an unknown outcome on the start alone, never on a read", async () => {
    // A 500 from the status route reads nothing into being.
    const status = await getMthdsRunStatus(
      { run_id: RUN_ID },
      contextWith({
        getRunStatus: () =>
          Promise.reject(
            new ApiResponseError(
              "HTTP 500",
              `${DEFAULT_API_URL}/v1/runs/${RUN_ID}/status`,
              500,
              "Server Error",
              "{}",
            ),
          ),
      }),
    );

    expect(status.structuredContent.problem?.code).not.toBe("client.outcome_unknown");
    expect(status.structuredContent.problem?.retry).not.toBe("outcome_unknown");
    expect(status.summary).not.toMatch(/may have started/);
  });

  it("keeps a start the server refused before running anything retryable", async () => {
    // The platform's own refusal before reaching the runner, a throttle, and a
    // refused connection that sent nothing.
    for (const answer of [
      problemAnswer(503, buildProblem("runtime.unavailable", {}, { status: 503 })),
      answered(429),
      cutOff("ECONNREFUSED", "connect"),
    ]) {
      const failure = await startFailure(answer);
      const refused = await startMthdsRun(
        { files: [{ content: 'domain = "demo"' }] },
        contextWith({ start: () => Promise.reject(failure) }),
      );

      expect(refused.structuredContent.problem?.retry).toBe("yes");
      expect(refused.summary).not.toMatch(/may have started/);
    }
  });

  it("says the run may exist when the start's acknowledgement came back unreadable", async () => {
    // A 2xx the SDK could not read is a start the server accepted: the run
    // exists all the same, and the SDK reads it as an unknown outcome. The
    // handshake that decides how the tree travels is answered first: a
    // deployment with no blob store, which takes it inline.
    vi.stubGlobal("fetch", (input: string | URL | Request) =>
      Promise.resolve(
        String(input instanceof Request ? input.url : input).endsWith("/v1/version")
          ? Response.json({ version: "1.0.0" })
          : new Response("", { status: 202 }),
      ),
    );
    try {
      const real = createPipelexApiClient({ baseUrl: DEFAULT_API_URL });
      const result = await startMthdsRun(
        { files: [{ content: 'domain = "demo"' }] },
        contextWith({ start: (options: PipelexStartOptions) => real.start(options) }),
      );

      expect(result.structuredContent.problem).toMatchObject({
        code: "client.outcome_unknown",
        retry: "outcome_unknown",
      });
      expect(result.summary).toMatch(MAY_HAVE_STARTED);
      expect(runToolResult(result).content[0].text).toMatch(MAY_HAVE_STARTED);
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      location: { field: "method_ref" },
    });
  });

  it("rejects method_ref beside method_id without calling the client", async () => {
    const result = await startMthdsRun(
      { method_ref: ADDRESS, method_id: "mt_abc123" },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      domain: "input",
      location: { field: "method_id" },
    });
    expect(result.structuredContent.problem?.message).toContain("provenance");
  });

  it("relays a structures refusal as the deployment answered it, the method's to change", async () => {
    const refusal = pipelexProblem("pipelex.deployment.python_structures_refused", {
      title: "Python structure classes are not allowed here",
      status: 422,
      detail:
        "The method declares structures as Python classes, which this runner does not import.",
      domain: "method",
      retry: "no",
      next_step: {
        kind: "change_method",
        detail:
          "Declare the structures as concepts in the method in place of Python classes, then run it again.",
      },
      params: { files: ["structures.py"] },
    });

    const result = await startMthdsRun(
      { method_ref: ADDRESS },
      contextWith({ start: () => Promise.reject(answeredWith("/v1/start", refusal)) }),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(refusal);
    expect(result.summary).toContain("Declare the structures as concepts in the method");
  });

  it("relays a sandbox refusal alike whatever named the method, locating it nowhere of its own", async () => {
    const refusal = pipelexProblem("pipelex.deployment.custom_code_requires_sandbox", {
      title: "Custom code needs a sandbox-hosted deployment",
      status: 501,
      detail:
        "The method ships Python code in its bundle, and this deployment runs none outside the Daytona sandbox.",
      domain: "operator",
      retry: "no",
      next_step: { kind: "report", detail: "Report this to whoever runs the runtime." },
      params: { origin: "bundle" },
    });
    const start = () => Promise.reject(answeredWith("/v1/start", refusal));

    const byRef = await startMthdsRun({ method_ref: ADDRESS }, contextWith({ start }));
    const byFiles = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }] },
      contextWith({ start }),
    );

    for (const result of [byRef, byFiles]) {
      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toEqual(refusal);
      expect(result.summary).toContain("Daytona sandbox");
    }
  });

  it("relays a refused registry-form reference with the API's own location", async () => {
    const refusal = buildProblem(
      "request.unsupported",
      { field: "method_ref", reason: "registry_reference" },
      { status: 501, location: { field: "method_ref" } },
    );

    const result = await startMthdsRun(
      { method_ref: ADDRESS },
      contextWith({ start: () => Promise.reject(answeredWith("/v1/start", refusal)) }),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(refusal);
    expect(result.structuredContent.problem?.location).toEqual({ field: "method_ref" });
  });
});

describe("startMthdsRun by method_id", () => {
  /** The catalog's miss of the method `mt_missing`. */
  const METHOD_NOT_FOUND = pipelexProblem("pipelex.catalog.not_found", {
    title: "The saved method does not exist",
    status: 404,
    detail:
      "The organization's catalog holds no method matching the request for the method 'mt_missing'.",
    domain: "input",
    retry: "no",
    next_step: {
      kind: "change_input",
      detail:
        "List the organization's catalog to find the method, then send the request again with one that exists.",
    },
    params: { resource: "method", method_id: "mt_missing" },
  });

  function notFound(): ApiResponseError {
    return answeredWith("/v1/start", METHOD_NOT_FOUND);
  }

  it("starts by id alone — method_id crosses as a named option, no tree", async () => {
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
    expect(seen).not.toHaveProperty("tree");
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

    expect(await comparableRequest(seen)).toEqual({
      tree: { "bundle.mthds": 'domain = "demo"' },
      method_id: "mt_abc123",
    });
  });

  it("does not call the client when neither files nor method_id is supplied", async () => {
    const result = await startMthdsRun({}, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      location: { field: "files" },
    });
    expect(result.structuredContent.problem?.message).toContain(
      "Provide a method folder, MTHDS files, a method_ref address, or a method_id.",
    );
  });

  it("does not call the client on a blank method_id", async () => {
    const result = await startMthdsRun({ method_id: "   " }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem?.location?.field).toBe("method_id");
  });

  it("relays an unknown method as the catalog's miss, not retryable", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const result = await startMthdsRun({ method_id: "mt_missing" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toEqual(METHOD_NOT_FOUND);
    expect(result.structuredContent.problem?.retry).toBe("no");
    expect(result.summary).toContain("List the organization's catalog to find the method");
  });

  it("relays the same problem whatever selector named the method, rewriting no location by request shape", async () => {
    const context = contextWith({ start: () => Promise.reject(notFound()) });

    const filesOnly = await startMthdsRun({ files: [{ content: 'domain = "demo"' }] }, context);
    const mixed = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_missing" },
      context,
    );

    for (const result of [filesOnly, mixed]) {
      expect(result.structuredContent.problem).toEqual(METHOD_NOT_FOUND);
      expect(result.structuredContent.problem).not.toHaveProperty("location");
    }
  });

  it("relays an organization out of credit as the account's problem, with no note about the key or the API", async () => {
    const context = {
      ...contextWith({ start: () => Promise.reject(outOfCredit("/v1/start")) }),
      apiNotes: API_NOTES,
    };

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.billing.credit_exhausted",
      domain: "account",
      retry: "no",
    });
    // A headline-only host shows just the first line, which names the credit.
    expect(result.summary.startsWith("## The organization is out of credit")).toBe(true);
    expect(result.summary).not.toContain(API_NOTES.apiKey);
    expect(result.summary).not.toContain(API_NOTES.baseUrl);
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("relays a refused key (401) as the key's problem, saying where the key came from", async () => {
    const context = {
      ...contextWith({ start: () => Promise.reject(refusedKey("/v1/start")) }),
      apiNotes: API_NOTES,
    };

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    expect(result.structuredContent.problem).toMatchObject({
      code: "auth.invalid_credential",
      domain: "account",
    });
    expect(result.summary).toContain(API_NOTES.apiKey);
    expect(result.summary).not.toMatch(/may have started/);
  });

  it("relays a mixed request's refusal at the location the API names", async () => {
    const invalid = buildProblem(
      "request.pipe_not_found",
      { pipe: "missing_pipe", suggestions: ["main_pipe"] },
      { status: 422 },
    );
    const context = contextWith({
      start: () => Promise.reject(answeredWith("/v1/start", invalid)),
    });

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "demo"' }], method_id: "mt_abc123" },
      context,
    );

    expect(result.structuredContent.problem).toEqual(invalid);
    expect(result.structuredContent.problem?.retry).toBe("no");
  });

  it("relays a by-id refusal of a stored method with no source to run, as the API answered it", async () => {
    const refusal = buildProblem(
      "request.invalid",
      { field: "method_id" },
      { status: 422, location: { field: "method_id" } },
    );
    const context = contextWith({
      start: () => Promise.reject(answeredWith("/v1/start", refusal)),
    });

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    expect(result.structuredContent.problem).toEqual(refusal);
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
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
      location: { field: "run_id" },
    });
  });

  it("relays an unknown id as run.not_found, the caller's to change", async () => {
    const context = contextWith({
      getRunStatus: () =>
        Promise.reject(
          answeredWith(
            `/v1/runs/${RUN_ID}/status`,
            buildProblem("run.not_found", { pipeline_run_id: RUN_ID }, { status: 404 }),
          ),
        ),
    });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "run.not_found",
      domain: "input",
    });
  });

  it("relays an organization out of credit as the account's problem, not as connectivity", async () => {
    const context = contextWith({
      getRunStatus: () => Promise.reject(outOfCredit(`/v1/runs/${RUN_ID}/status`)),
    });

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.problem?.code).toBe("pipelex.billing.credit_exhausted");
    expect(result.summary.startsWith("## The organization is out of credit")).toBe(true);
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("relays a refused key (401) as the key's problem, saying where the key came from", async () => {
    const context = {
      ...contextWith({
        getRunStatus: () => Promise.reject(refusedKey(`/v1/runs/${RUN_ID}/status`)),
      }),
      apiNotes: API_NOTES,
    };

    const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

    expect(result.structuredContent.problem?.code).toBe("auth.invalid_credential");
    expect(result.summary).toContain(API_NOTES.apiKey);
  });

  describe("the progress read after it", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** A context whose status read answers `read`, recording the order of the reads. */
    function progressContext(
      read: RunRead,
      getRunProgress: (runId: string, options?: { signal?: AbortSignal }) => Promise<RunProgress>,
    ): { context: RunContext; calls: string[] } {
      const calls: string[] = [];
      const context = contextWith({
        getRunStatus: (runId: string) => {
          calls.push(`status ${runId}`);
          return Promise.resolve(read);
        },
        getRunProgress: (runId: string, options?: { signal?: AbortSignal }) => {
          calls.push(`progress ${runId}`);
          return getRunProgress(runId, options);
        },
      });
      return { context, calls };
    }

    it("reads a running run's progress after its status and relays it", async () => {
      const { context, calls } = progressContext(runRead({ status: "RUNNING" }), () =>
        Promise.resolve(MID_RUN_SNAPSHOT),
      );

      const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

      expect(calls).toEqual([`status ${RUN_ID}`, `progress ${RUN_ID}`]);
      expect(result.structuredContent.status).toBe("ok");
      expect(result.structuredContent.progress).toEqual(MID_RUN_SNAPSHOT);
      expect(result.summary).toContain(`\n\nProgress: ${MID_RUN_SUMMARY}`);
    });

    it("reads a pending run's progress", async () => {
      const { context, calls } = progressContext(runRead({ status: "PENDING" }), () =>
        Promise.resolve(PENDING_SNAPSHOT),
      );

      const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

      expect(calls).toHaveLength(2);
      expect(result.structuredContent.progress?.status).toBe("pending");
      expect(result.summary).toContain("Progress: Waiting to start");
    });

    it("reads an ended run's progress too, for where it stopped", async () => {
      const { statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
      const { context, calls } = progressContext(statusRead, () =>
        Promise.resolve(FAILED_RUN_SNAPSHOT),
      );

      const result = await getMthdsRunStatus({ run_id: statusRead.pipeline_run_id }, context);

      expect(calls).toEqual([
        `status ${statusRead.pipeline_run_id}`,
        `progress ${statusRead.pipeline_run_id}`,
      ]);
      expect(result.structuredContent.run_status).toBe("FAILED");
      expect(result.structuredContent.error).toBeDefined();
      expect(result.summary).toContain(
        "Progress: Failed at condense_filing (step 3 of 4, item 2 of 3, step 2 of 2)",
      );
    });

    it("answers the status without progress when the progress read fails, never as an error", async () => {
      const failures = [
        answeredWith(
          `/v1/runs/${RUN_ID}/progress`,
          buildProblem("runtime.unavailable", {}, { status: 503 }),
        ),
        new ApiUnreachableError("connection reset", DEFAULT_API_URL, "ECONNRESET"),
        new Error("an answer the SDK could not read"),
      ];
      for (const failure of failures) {
        const { context } = progressContext(runRead({ status: "RUNNING" }), () =>
          Promise.reject(failure),
        );

        const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

        expect(result.structuredContent.status).toBe("ok");
        expect(result.structuredContent.run_status).toBe("RUNNING");
        expect(result.structuredContent).not.toHaveProperty("progress");
        expect(result.structuredContent).not.toHaveProperty("problem");
        expect(result.summary).not.toContain("Progress");
      }
    });

    it("answers the status without progress on a server older than the progress route", async () => {
      const { context } = progressContext(runRead({ status: "RUNNING" }), () =>
        Promise.reject(
          new RunLifecycleUnavailableError(
            "The progress route is not served: the server is a bare runner, or a hosted API older than the progress route.",
            `${DEFAULT_API_URL}/v1/runs/${RUN_ID}/progress`,
          ),
        ),
      );

      const result = await getMthdsRunStatus({ run_id: RUN_ID }, context);

      expect(result.structuredContent.status).toBe("ok");
      expect(result.structuredContent).not.toHaveProperty("progress");
      expect(result.structuredContent).not.toHaveProperty("problem");
      expect(result.summary).toMatch(
        /^Run `[^`]+` is RUNNING — not terminal yet\. Check again in ~\d+s\.$/,
      );
    });

    it("sends the status without the progress once the deadline passes", async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const { context } = progressContext(runRead({ status: "RUNNING" }), (_runId, options) => {
        signal = options?.signal;
        // A read that never answers and ignores its signal: the deadline must hold anyway.
        return new Promise<RunProgress>(() => undefined);
      });

      const pending = getMthdsRunStatus({ run_id: RUN_ID }, context);
      await vi.advanceTimersByTimeAsync(PROGRESS_READ_TIMEOUT_MS);
      const result = await pending;

      expect(signal?.aborted).toBe(true);
      expect(result.structuredContent.run_status).toBe("RUNNING");
      expect(result.structuredContent).not.toHaveProperty("progress");
    });

    it("returns the snapshot when it answers in time, and aborts nothing", async () => {
      let signal: AbortSignal | undefined;

      const progress = await readRunProgress(
        {
          getRunProgress: (_runId, options) => {
            signal = options?.signal;
            return Promise.resolve(MID_RUN_SNAPSHOT);
          },
        },
        RUN_ID,
      );

      expect(progress).toBe(MID_RUN_SNAPSHOT);
      expect(signal?.aborted).toBe(false);
    });
  });
});

describe("getMthdsRunResults", () => {
  it("follows a failed arm with one status read, for the run's problem and when the run ended", async () => {
    const { resultsArm, statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
    const statusReads: string[] = [];
    const context = contextWith({
      getRunResult: () => Promise.resolve(resultsArm),
      getRunStatus: (runId: string) => {
        statusReads.push(runId);
        return Promise.resolve(statusRead);
      },
    });

    const result = await getMthdsRunResults({ run_id: statusRead.pipeline_run_id }, context);

    expect(statusReads).toEqual([statusRead.pipeline_run_id]);
    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("failed");
    expect(result.structuredContent).not.toHaveProperty("failure_message");
    expect(result.structuredContent.run_error).toEqual(statusRead.error);
    expect(result.summary).toContain(
      `For support: Run ${statusRead.pipeline_run_id} · model.unavailable · ended ${statusRead.finished_at ?? ""}`,
    );
    expect(result.summary).toContain("**Next step** (`change_model`)");
  });

  it("keeps the failed verdict when the status read that follows it fails", async () => {
    const { relayedArm } = RECORDED_FAILED_RUNS.extractJobFailure;
    const context = contextWith({
      getRunResult: () => Promise.resolve(relayedArm),
      getRunStatus: () =>
        Promise.reject(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
    });

    const result = await getMthdsRunResults({ run_id: relayedArm.pipeline_run_id }, context);

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.state).toBe("failed");
    expect(result.structuredContent.run_error).toMatchObject({
      code: "provider.failed",
      retry: "yes",
      next_step: { kind: "retry" },
    });
    expect(result.summary).toContain("- Code: `provider.failed` (domain runtime, retry yes)");
    // The arm does not carry when the run ended, so the support line goes without it.
    expect(result.summary).toContain(
      `For support: Run ${relayedArm.pipeline_run_id} · provider.failed\n`,
    );
    expect(result.summary).not.toContain("· ended");
  });

  it("says the reason is unknown when neither the arm nor the failed status read carries a problem", async () => {
    const { resultsArm } = RECORDED_FAILED_RUNS.llmCompletion;
    const context = contextWith({
      getRunResult: () => Promise.resolve(resultsArm),
      getRunStatus: () =>
        Promise.reject(
          new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
        ),
    });

    const result = await getMthdsRunResults({ run_id: resultsArm.pipeline_run_id }, context);

    expect(result.structuredContent.state).toBe("failed");
    expect(result.structuredContent).not.toHaveProperty("run_error");
    expect(result.summary).toContain("Why it ended is unknown for now");
    expect(result.summary).not.toContain("stored no problem");
  });

  describe("the status read's deadline", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends the failed verdict without the read once the deadline passes", async () => {
      vi.useFakeTimers();
      const { relayedArm } = RECORDED_FAILED_RUNS.llmCompletion;
      let signal: AbortSignal | undefined;
      const context = contextWith({
        getRunResult: () => Promise.resolve(relayedArm),
        // A read that never answers and ignores its signal: the deadline must hold anyway.
        getRunStatus: (_runId: string, options?: { signal?: AbortSignal }) => {
          signal = options?.signal;
          return new Promise<RunRead>(() => undefined);
        },
      });

      const pending = getMthdsRunResults({ run_id: relayedArm.pipeline_run_id }, context);
      await vi.advanceTimersByTimeAsync(FAILED_RUN_READ_TIMEOUT_MS);
      const result = await pending;

      expect(signal?.aborted).toBe(true);
      expect(result.structuredContent.state).toBe("failed");
      expect(result.structuredContent.run_error).toMatchObject({ code: "model.unavailable" });
      expect(result.summary).not.toContain("· ended");
    });

    it("returns the read when it answers in time, and aborts nothing", async () => {
      const { statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
      let signal: AbortSignal | undefined;

      const read = await readFailedRun(
        {
          getRunStatus: (_runId, options) => {
            signal = options?.signal;
            return Promise.resolve(statusRead);
          },
        },
        statusRead.pipeline_run_id,
      );

      expect(read).toBe(statusRead);
      expect(signal?.aborted).toBe(false);
    });
  });

  it("reads no status for a completed or a running result", async () => {
    const running: RunResultState = {
      state: "running",
      pipeline_run_id: RUN_ID,
      retry_after_seconds: 3,
    };
    const result = await getMthdsRunResults(
      { run_id: RUN_ID },
      contextWith({ getRunResult: () => Promise.resolve(running) }),
    );

    expect(result.structuredContent.state).toBe("running");
  });

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
  });

  it("does not call the client on a blank run_id", async () => {
    const result = await getMthdsRunResults({ run_id: "" }, contextWith({}));

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.argument_invalid",
      domain: "input",
    });
  });

  it("relays the SDK's MissingMainStuffError as an answer it could not read, naming the run", async () => {
    const context = contextWith({
      getRunResult: () =>
        Promise.reject(new MissingMainStuffError("completed run has no main stuff", RUN_ID)),
    });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      pipeline_run_id: RUN_ID,
    });
  });

  it("reads a reachable but malformed completed result as an answer it could not read, not as unreachable", async () => {
    const state: RunResultState = {
      state: "completed",
      pipeline_run_id: RUN_ID,
      result: { pipeline_run_id: RUN_ID, main_stuff: null },
    };
    const context = contextWith({ getRunResult: () => Promise.resolve(state) });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      params: { status: 200 },
      pipeline_run_id: RUN_ID,
      message: "Completed run results did not include main_stuff.",
    });
    expect(result.summary).toContain("## The runtime's answer could not be read");
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("reads a 409 that is no run.failed as no verdict, never as a failed run", async () => {
    // The platform's 409 for a stored result it refuses to read names no run
    // status; the SDK no longer reads it as a failed arm, so it is no verdict.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          {
            type: "about:blank",
            title: "Conflict",
            status: 409,
            detail:
              "The run's recorded result location does not belong to this run; its results cannot be served.",
          },
          { status: 409, headers: { "content-type": "application/problem+json" } },
        ),
      ),
    );
    try {
      const result = await getMthdsRunResults({ run_id: RUN_ID }, { baseUrl: DEFAULT_API_URL });

      expect(result.structuredContent.status).toBe("error");
      expect(result.structuredContent.problem).toMatchObject({
        code: "client.response_unreadable",
        params: { status: 409 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("relays an organization out of credit as the account's problem, not as connectivity", async () => {
    const context = contextWith({
      getRunResult: () => Promise.reject(outOfCredit(`/v1/runs/${RUN_ID}/results`)),
    });

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.problem?.code).toBe("pipelex.billing.credit_exhausted");
    expect(result.summary.startsWith("## The organization is out of credit")).toBe(true);
    expect(result.summary).not.toMatch(/unreachable/);
  });

  it("relays a refused key (401) as the key's problem, saying where the key came from", async () => {
    const context = {
      ...contextWith({
        getRunResult: () => Promise.reject(refusedKey(`/v1/runs/${RUN_ID}/results`)),
      }),
      apiNotes: API_NOTES,
    };

    const result = await getMthdsRunResults({ run_id: RUN_ID }, context);

    expect(result.structuredContent.problem?.code).toBe("auth.invalid_credential");
    expect(result.summary).toContain(API_NOTES.apiKey);
  });
});

describe("getMthdsRunResults artifact selection", () => {
  const TOKENS_USAGES: TokensUsageRecord[] = [
    { pipe_code: "extract", cost: 0.01, nb_tokens_by_category: { input: 100, output: 50 } },
  ];
  const FULL: RunResults = {
    pipeline_run_id: RUN_ID,
    main_stuff: { answer: 42 },
    working_memory: { root: {}, aliases: {} },
    graph_spec: { nodes: [] },
    pipe_io_contracts: CONTRACTS,
    output_form: OUTPUT_FORM,
    input_form: INPUT_FORM,
    tokens_usages: TOKENS_USAGES,
    usage_assembly_error: null,
  };

  /**
   * A results read the way the SDK answers a narrowed one: every artifact the
   * selection left out is absent, and `tokens_usages` brings
   * `usage_assembly_error` with it. A projection reading an artifact it did
   * not ask for then finds nothing, which the assertions below would see.
   */
  function narrowedRead(selections: (readonly RunResultArtifact[] | undefined)[]) {
    return (_runId: string, options?: GetRunResultOptions): Promise<RunResultState> => {
      selections.push(options?.artifacts);
      const selected = new Set<string>(options?.artifacts ?? []);
      if (selected.has("tokens_usages")) selected.add("usage_assembly_error");
      const result = Object.fromEntries(
        Object.entries(FULL).filter(
          ([key]) =>
            key === "pipeline_run_id" || options?.artifacts === undefined || selected.has(key),
        ),
      ) as unknown as RunResults;
      return Promise.resolve({ state: "completed", pipeline_run_id: RUN_ID, result });
    };
  }

  it("asks for the output and the usage alone", async () => {
    const selections: (readonly RunResultArtifact[] | undefined)[] = [];
    const context = contextWith({ getRunResult: narrowedRead(selections) });

    const toolResult = runResultsToolResult(await getMthdsRunResults({ run_id: RUN_ID }, context));

    expect(selections).toEqual([["main_stuff", "tokens_usages"]]);
    expect(toolResult.structuredContent.main_stuff).toEqual({ answer: 42 });
    expect(toolResult.structuredContent.usage?.calls).toBe(1);
    expect(toolResult._meta.tokens_usages).toEqual(TOKENS_USAGES);
  });

  it("names only artifacts the SDK knows, and never the working memory", () => {
    const artifacts = RUN_RESULTS_ARTIFACTS;
    expect(artifacts.length).toBeGreaterThan(0);
    expect(artifacts).toContain("main_stuff");
    expect(artifacts).not.toContain("working_memory");
  });
});

describe("runResultsToolResult", () => {
  it("delivers the full output on _meta, never on structuredContent", async () => {
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
    expect(toolResult._meta.main_stuff).toBeUndefined();
    expect(toolResult._meta.tokens_usages).toBeUndefined();
    expect(toolResult._meta.usage_by_pipe).toBeUndefined();
  });
});

describe("startMthdsRun path submissions", () => {
  it("reads { path } items through the context resolver and starts them as one tree", async () => {
    const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    let seen: PipelexStartOptions | undefined;
    const context: RunContext = {
      ...contextWith({
        start: (options: PipelexStartOptions) => {
          seen = options;
          return Promise.resolve({ pipeline_run_id: RUN_ID });
        },
      }),
      resolver: fakeMethodResolver({
        files: {
          "methods/invoice.mthds": 'domain = "invoice"',
          "methods/templates/invoice.xlsx": XLSX,
        },
      }),
    };

    const result = await startMthdsRun(
      { files: [{ path: "methods/invoice.mthds" }, { path: "methods/templates/invoice.xlsx" }] },
      context,
    );

    // Each file under its path from the deepest directory holding them all.
    expect(seen?.tree?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "templates/invoice.xlsx",
    ]);
    expect(await seen?.tree?.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      run_id: RUN_ID,
      files_sent: ["methods/invoice.mthds", "methods/templates/invoice.xlsx"],
    });
  });

  it("refuses files holding a key before starting, naming the file and never the key", async () => {
    const fakeKey = ["plx_sk_", "f".repeat(32)].join("");

    const result = await startMthdsRun(
      { files: [{ path: "methods/invoice.mthds" }, { path: "methods/report.html" }] },
      {
        ...contextWith({}),
        resolver: fakeMethodResolver({
          files: {
            "methods/invoice.mthds": 'domain = "invoice"',
            "methods/report.html": `<p>${fakeKey}</p>`,
          },
        }),
      },
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      domain: "input",
      location: { field: "files[1].path" },
      retry: "no",
    });
    expect(result.structuredContent.problem?.message).toContain("methods/report.html");
    expect(result.structuredContent.problem?.message).toContain("nothing was sent");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  /** The problem a deployment answers a start too large for it with. */
  const TOO_LARGE = buildProblem(
    "request.too_large",
    { limit: 10 * 1024 * 1024, size: 12 * 1024 * 1024 },
    { status: 413 },
  );

  /** A context whose start answers a 413, its handshake counted and answering `version`. */
  function refusingStart(
    version: () => Promise<unknown>,
    files: Record<string, string | Uint8Array> = {},
  ): { context: RunContext; versionCalls: () => number } {
    let calls = 0;
    return {
      context: {
        ...contextWith({
          start: () => Promise.reject(answeredWith("/v1/start", TOO_LARGE)),
          version: () => {
            calls += 1;
            return version();
          },
        }),
        resolver: fakeMethodResolver({ files }),
      },
      versionCalls: () => calls,
    };
  }

  const noBlobStore = () => Promise.resolve({ version: "1.0.0", blob_store: false });
  const blobStore = () => Promise.resolve({ version: "1.0.0", blob_store: true });

  /** The problem of a refused start: the deployment's own, with the workshop's account in `message`. */
  function tooLargeProblem(result: Awaited<ReturnType<typeof startMthdsRun>>): Problem {
    const problem = result.structuredContent.problem;
    expect(problem).toMatchObject({
      code: TOO_LARGE.code,
      domain: TOO_LARGE.domain,
      retry: TOO_LARGE.retry,
      next_step: TOO_LARGE.next_step,
      params: TOO_LARGE.params,
    });
    expect(problem).not.toHaveProperty("location");
    return problem as Problem;
  }

  it("names both causes of a 413 on a start carrying a small tree and no inputs, keeping the API's problem", async () => {
    const { context, versionCalls } = refusingStart(noBlobStore);

    const result = await startMthdsRun({ files: [{ content: 'domain = "invoice"' }] }, context);

    const message = String(tooLargeProblem(result).message);
    expect(message).toContain("cannot be told from here");
    expect(message).toContain("mthds_prepare_inputs");
    expect(message).toContain("the run carries no inputs");
    expect(message).not.toContain("its inputs did");
    expect(result.summary).toContain(message);
    // A tree within the inline threshold rode inline wherever it went: no handshake asks.
    expect(versionCalls()).toBe(0);
  });

  it("names both causes of a 413 on a start carrying inputs beside a small tree, with what it measured", async () => {
    const { context } = refusingStart(noBlobStore);

    const result = await startMthdsRun(
      { files: [{ content: 'domain = "invoice"' }], inputs: { question: "why?" } },
      context,
    );

    const message = String(tooLargeProblem(result).message);
    expect(message).toContain("cannot be told from here");
    expect(message).toMatch(/the method's files weigh \d+\.\d KiB inline/);
    expect(message).toMatch(/its inputs weigh \d+\.\d KiB as JSON/);
  });

  it("blames a start's inputs for a 413 when it sent no tree", async () => {
    const { context, versionCalls } = refusingStart(noBlobStore);

    const result = await startMthdsRun(
      { method_ref: "github.com/Pipelex/methods/documents@v0.1.0", inputs: { question: "why?" } },
      context,
    );

    expect(tooLargeProblem(result).message).toContain("its inputs did");
    expect(versionCalls()).toBe(0);
  });

  it("blames a heavy tree a deployment without a blob store took inline, and the inputs when it went by hash", async () => {
    const heavy = "x".repeat(INLINE_TREE_MAX_BYTES + 1);
    const folder = { "methods/invoice.mthds": 'domain = "invoice"', "methods/report.html": heavy };
    const files = [{ path: "methods/invoice.mthds" }, { path: "methods/report.html" }];

    const inline = await startMthdsRun({ files }, refusingStart(noBlobStore, folder).context);
    const inlineMessage = String(tooLargeProblem(inline).message);
    expect(inlineMessage).toContain("The method's files travelled inline in this request");
    expect(inlineMessage).toContain("without a blob store");

    // The same tree went by hash to a deployment keeping a blob store, so the
    // inputs riding the start take the blame, and with none, nothing does.
    const withInputs = await startMthdsRun(
      { files, inputs: { question: "why?" } },
      refusingStart(blobStore, folder).context,
    );
    expect(tooLargeProblem(withInputs).message).toContain("its inputs did");
    const withoutInputs = await startMthdsRun({ files }, refusingStart(blobStore, folder).context);
    expect(tooLargeProblem(withoutInputs).message).toContain("the run carries no inputs");
  });

  it("weighs a binary file as the base64 it travels inline as", async () => {
    // Raw, the workbook is under the inline threshold; as base64 it is over,
    // so a deployment without a blob store took it inline at that weight.
    const workbook = new Uint8Array(Math.floor(INLINE_TREE_MAX_BYTES * 0.9)).fill(0xff);
    const { context, versionCalls } = refusingStart(noBlobStore, {
      "methods/invoice.mthds": 'domain = "invoice"',
      "methods/templates/invoice.xlsx": workbook,
    });

    const result = await startMthdsRun(
      { files: [{ path: "methods/invoice.mthds" }, { path: "methods/templates/invoice.xlsx" }] },
      context,
    );

    expect(versionCalls()).toBe(1);
    expect(tooLargeProblem(result).message).toContain("travelled inline in this request");
  });

  it("blames neither cause of a 413 when the handshake that would tell how a heavy tree went fails", async () => {
    const heavy = "x".repeat(INLINE_TREE_MAX_BYTES + 1);
    const { context, versionCalls } = refusingStart(
      () =>
        Promise.reject(new ApiUnreachableError("connection reset", DEFAULT_API_URL, "ECONNRESET")),
      { "methods/invoice.mthds": 'domain = "invoice"', "methods/report.html": heavy },
    );

    const result = await startMthdsRun(
      {
        files: [{ path: "methods/invoice.mthds" }, { path: "methods/report.html" }],
        inputs: { question: "why?" },
      },
      context,
    );

    expect(versionCalls()).toBe(1);
    const message = String(tooLargeProblem(result).message);
    expect(message).toContain("cannot be told from here");
    expect(message).not.toContain("its inputs did");
  });

  it("rejects { path } items instructively without a resolver (hosted)", async () => {
    const result = await startMthdsRun(
      { files: [{ path: "methods/bundle.mthds" }] },
      contextWith({}),
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      domain: "input",
      location: { field: "files[0].path" },
    });
    expect(result.structuredContent.problem?.message).toContain("npx @pipelex/mcp");
    const problem = result.structuredContent.problem;
    if (problem === undefined) throw new Error("the refusal carried no problem");
    expect(result.summary).toBe(problemSummary(problem));
  });
});

describe("startMthdsRun by method_id, on both platforms", () => {
  /** `GET /v1/version` on a platform that resolves version selectors. */
  const versionsSupported = (): Promise<unknown> =>
    Promise.resolve({ version: "1.0.0", extensions: ["runs", "method_versions"] });
  /** `GET /v1/version` on a platform that does not yet. */
  const versionsUnsupported = (): Promise<unknown> =>
    Promise.resolve({ version: "1.0.0", extensions: ["runs"] });

  function starting(
    ack: Record<string, unknown>,
    version: () => Promise<unknown>,
    seen: { options?: PipelexStartOptions; versionCalls: number },
  ): RunContext {
    return contextWith({
      start: (options: PipelexStartOptions) => {
        seen.options = options;
        return Promise.resolve({ pipeline_run_id: RUN_ID, ...ack });
      },
      version: () => {
        seen.versionCalls += 1;
        return version();
      },
    });
  }

  it("reports the version a bare id ran, from the acknowledgement, without a handshake", async () => {
    const seen = { versionCalls: 0 } as { options?: PipelexStartOptions; versionCalls: number };
    const result = await startMthdsRun(
      { method_id: "mt_abc123" },
      starting({ method_version: 4 }, versionsSupported, seen),
    );

    expect(seen.options).toEqual({ method_id: "mt_abc123" });
    expect(seen.versionCalls).toBe(0);
    expect(result.structuredContent).toMatchObject({ status: "ok", method_version: 4 });
    expect(result.summary).toContain("It runs version 4 of `mt_abc123`, the latest published");
  });

  it("reports the draft for a bare id on a platform whose acknowledgement names no version", async () => {
    const seen = { versionCalls: 0 } as { options?: PipelexStartOptions; versionCalls: number };
    const result = await startMthdsRun(
      { method_id: "mt_abc123" },
      starting({}, versionsUnsupported, seen),
    );

    expect(seen.options).toEqual({ method_id: "mt_abc123" });
    expect(result.structuredContent).toMatchObject({ method_version: "draft" });
    expect(result.summary).toContain("It runs the draft of `mt_abc123`");
  });

  it("forgets a cached supported when a bare id's acknowledgement names no version", async () => {
    // Round 2: the run reported the draft while the memory kept `supported`,
    // so for its lifetime every tooling tool read the same bare id as `latest`.
    const seen = { versionCalls: 0 } as { options?: PipelexStartOptions; versionCalls: number };
    const context = {
      ...starting({}, versionsUnsupported, seen),
      methodVersions: createMethodVersionsMemories(),
    };
    const memory = methodVersionsOf(context);
    noteMethodVersionsSupported(memory);

    const result = await startMthdsRun({ method_id: "mt_abc123" }, context);

    expect(result.structuredContent).toMatchObject({ method_version: "draft" });
    expect(memory?.cached).toBeUndefined();
  });

  it("keeps a cached supported when an accepted suffix's acknowledgement names no version", async () => {
    // Only a platform that resolves suffixes accepts one, so the acknowledgement
    // naming no version contradicts nothing.
    const seen = { versionCalls: 0 } as { options?: PipelexStartOptions; versionCalls: number };
    const context = {
      ...starting({}, versionsSupported, seen),
      methodVersions: createMethodVersionsMemories(),
    };
    const memory = methodVersionsOf(context);
    noteMethodVersionsSupported(memory);

    await startMthdsRun({ method_id: "mt_abc123@draft" }, context);

    expect(memory?.cached?.support).toBe("supported");
  });

  it("sends @draft and @n as given on every platform, without asking", async () => {
    // Rewritten by a stale answer, @draft sent bare would run the latest
    // published version; a platform that cannot read a suffix refuses it.
    for (const version of [versionsSupported, versionsUnsupported]) {
      for (const methodId of ["mt_abc123@draft", "mt_abc123@3"]) {
        const seen = { versionCalls: 0 } as {
          options?: PipelexStartOptions;
          versionCalls: number;
        };
        await startMthdsRun({ method_id: methodId }, starting({}, version, seen));
        expect(seen.options).toEqual({ method_id: methodId });
        expect(seen.versionCalls).toBe(0);
      }
    }

    const seen = { versionCalls: 0 } as { options?: PipelexStartOptions; versionCalls: number };
    const pinned = await startMthdsRun(
      { method_id: "mt_abc123@3" },
      starting({ method_version: 3 }, versionsSupported, seen),
    );
    expect(pinned.structuredContent).toMatchObject({ method_version: 3 });
  });

  it("says a platform that refused a suffix by its pattern does not resolve suffixes", async () => {
    // Such a platform's run route refuses the `@` by its body pattern, with a
    // 422 the SDK cannot read as a problem document.
    const result = await startMthdsRun(
      { method_id: "mt_abc123@draft" },
      contextWith({
        start: () =>
          Promise.reject(
            new ApiResponseError(
              "HTTP 422",
              `${DEFAULT_API_URL}/v1/start`,
              422,
              "Unprocessable Entity",
              JSON.stringify({
                status: 422,
                code: "validation_failed",
                errors: [{ field: "method_id", code: "string_pattern_mismatch" }],
              }),
              { mayStartRun: true },
            ),
          ),
        version: versionsUnsupported,
      }),
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "client.response_unreadable",
      params: { status: 422 },
    });
    expect(result.structuredContent.problem?.message).toContain(
      "this platform refused `mt_abc123@draft` because it does not resolve version suffixes yet",
    );
  });

  it("relays a run of the draft refused by role as the platform answered it", async () => {
    const forbidden = buildProblem(
      "auth.forbidden",
      { requirement: "a role that runs drafts" },
      { status: 403 },
    );
    const result = await startMthdsRun(
      { method_id: "mt_abc123@draft" },
      contextWith({ start: () => Promise.reject(answeredWith("/v1/start", forbidden)) }),
    );

    expect(result.structuredContent.problem).toEqual(forbidden);
    // A refusal is an answer: nothing ran, so it is neither a may-have-run start
    // nor a refused suffix, and the key that was accepted is not in question.
    expect(result.summary.startsWith(`## ${forbidden.title}`)).toBe(true);
    const text = runToolResult(result).content[0].text;
    expect(text).toContain(forbidden.detail);
    expect(text).not.toMatch(/PIPELEX_API_KEY|log ?in|version suffixes|may have started/i);
  });

  it("explains a never-published method's bare id", async () => {
    const notPublished = pipelexProblem("pipelex.catalog.not_published", {
      title: "The saved method has no published version",
      status: 409,
      detail: "The method 'mt_abc123' has no published version.",
      domain: "input",
      retry: "no",
      next_step: {
        kind: "change_input",
        detail:
          "Publish a version of the method 'mt_abc123', or name its draft as 'mt_abc123@draft', then send the request again.",
      },
      params: { method_id: "mt_abc123" },
    });
    const result = await startMthdsRun(
      { method_id: "mt_abc123" },
      contextWith({ start: () => Promise.reject(answeredWith("/v1/start", notPublished)) }),
    );

    expect(result.structuredContent.problem).toMatchObject({
      code: "pipelex.catalog.not_published",
      domain: "input",
    });
    expect(result.structuredContent.problem?.message).toContain("`mt_abc123@draft`");
  });

  it("surfaces the version a run ran on its status read", async () => {
    const read = {
      pipeline_run_id: RUN_ID,
      status: "RUNNING",
      degraded: false,
      created_at: "2026-09-20T12:00:00Z",
      method_version: 4,
    } as unknown as RunRead;

    expect(statusResult(read).structuredContent.method_version).toBe(4);
    expect(
      statusResult({ ...read, method_version: null } as unknown as RunRead).structuredContent,
    ).not.toHaveProperty("method_version");
  });
});

describe("startMthdsRun from a method folder", () => {
  const tempDirs: string[] = [];
  const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const BUNDLE = [
    'domain = "invoice"',
    'main_pipe = "render_invoice"',
    "",
    "[pipe.render_invoice]",
    'type = "PipeDocGen"',
    'description = "Fill the invoice workbook"',
    'inputs = { invoice = "Invoice" }',
    'output = "Document"',
    'template_file = "templates/invoice.xlsx"',
    "",
  ].join("\n");

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function methodFolder(): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-run-dir-")));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, "invoice", "templates"), { recursive: true });
    await fs.writeFile(path.join(root, "invoice", "invoice.mthds"), BUNDLE);
    await fs.writeFile(path.join(root, "invoice", "templates", "invoice.xlsx"), XLSX);
    await fs.writeFile(path.join(root, "invoice", "notes.md"), "part of the method's tree");
    await fs.writeFile(path.join(root, "invoice", ".env"), "LEFT=out\n");
    return root;
  }

  const SENT = [
    path.join("invoice", "invoice.mthds"),
    path.join("invoice", "notes.md"),
    path.join("invoice", "templates", "invoice.xlsx"),
  ];

  it("runs the folder with a bare method_id as linkage, and lists every file it sent", async () => {
    const root = await methodFolder();
    let seen: PipelexStartOptions | undefined;
    const context: RunContext = {
      ...contextWith({
        start: (options: PipelexStartOptions) => {
          seen = options;
          return Promise.resolve({ pipeline_run_id: RUN_ID });
        },
      }),
      resolver: localMethodFileResolver(root),
    };

    const result = await startMthdsRun({ method_dir: "invoice", method_id: "mt_abc123" }, context);

    // The whole tree, notes included: a folder sends every file it holds.
    expect(seen?.method_id).toBe("mt_abc123");
    expect(seen?.tree?.files.map((file) => file.path)).toEqual([
      "invoice.mthds",
      "notes.md",
      "templates/invoice.xlsx",
    ]);
    expect((await contentsOf(seen?.tree))["invoice.mthds"]).toBe(BUNDLE);
    expect(await seen?.tree?.readFile("templates/invoice.xlsx")).toEqual(XLSX);
    expect(result.structuredContent).toMatchObject({
      status: "ok",
      run_id: RUN_ID,
      files_sent: SENT,
    });
    const text = runToolResult(result).content[0].text;
    expect(text).toContain("## Files sent");
    expect(text).toContain(`- \`${SENT[2]}\``);
  });

  it("refuses a suffixed method_id beside a folder, in the folder's words, before starting", async () => {
    const root = await methodFolder();
    const context: RunContext = { ...contextWith({}), resolver: localMethodFileResolver(root) };

    const result = await startMthdsRun(
      { method_dir: "invoice", method_id: "mt_abc123@draft" },
      context,
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.problem).toMatchObject({
      domain: "input",
      location: { field: "method_id" },
    });
    expect(result.structuredContent.problem?.message).toContain("Beside method_dir");
    expect(result.structuredContent.problem?.message).toContain("the folder is what runs");
    expect(result.structuredContent.problem?.message).toContain("drop method_dir");
    expect(result.structuredContent).not.toHaveProperty("files_sent");
  });

  it("lists no file of a folder when the start never left the machine", async () => {
    const root = await methodFolder();

    const unbuilt = await startMthdsRun(
      { method_dir: "invoice" },
      { baseUrl: "invalid-no-scheme", resolver: localMethodFileResolver(root) },
    );
    expect(unbuilt.structuredContent.status).toBe("error");
    expect(unbuilt.structuredContent).not.toHaveProperty("files_sent");
    expect(runToolResult(unbuilt).content[0].text).not.toContain("Files sent");

    const refused = await startMthdsRun(
      { method_dir: "invoice" },
      {
        ...contextWith({
          start: () => Promise.reject(new RequestArgumentError("refused before sending")),
        }),
        resolver: localMethodFileResolver(root),
      },
    );
    expect(refused.structuredContent.status).toBe("error");
    expect(refused.structuredContent).not.toHaveProperty("files_sent");
  });

  it("refuses a folder beside method_ref before reading it", async () => {
    const result = await startMthdsRun(
      { method_dir: "invoice", method_ref: "github.com/acme/methods/invoice" },
      { ...contextWith({}), resolver: localMethodFileResolver("/nonexistent-root") },
    );

    // One fault, so the problem is that fault, with no list of several.
    expect(result.structuredContent.problem?.location?.field).toBe("method_ref");
    expect(result.structuredContent.problem).not.toHaveProperty("errors");
  });

  it("relays a refusal of what it sent with the API's own location, and lists the files it sent", async () => {
    const root = await methodFolder();
    const refusal = buildProblem(
      "request.invalid",
      { field: "tree.files" },
      { status: 422, location: { field: "tree.files" } },
    );
    const context: RunContext = {
      ...contextWith({ start: () => Promise.reject(answeredWith("/v1/start", refusal)) }),
      resolver: localMethodFileResolver(root),
    };

    const result = await startMthdsRun({ method_dir: "invoice" }, context);

    // The location names the request's own field, never rewritten to the tool's.
    expect(result.structuredContent.problem).toEqual(refusal);
    // The files left the machine all the same.
    expect(result.structuredContent.files_sent).toEqual(SENT);
    expect(runToolResult(result).content[0].text).toContain("## Files sent");
  });
});
