import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildProblem } from "@pipelex/sdk";
import type { Problem, RunRead, RunResultState, RunStatus } from "@pipelex/sdk";

import type { FailedRunState } from "./run.js";

/**
 * Failed runs for the hermetic tests of every failed arm in the run family.
 *
 * Each one holds two reads of one real run of the dev plane, recorded as the
 * SDK returned them on 2026-09-26: its status read (`getRunStatus`) and its
 * results read (`getRunResult`). The identifiers of the organization, the user
 * and the workflow were left out. The run's error then was the runner's old
 * error report, which no reader takes any more, so each status read's `error`
 * was rewritten by hand into the problem the platform serves for that failure
 * now, in the caller's view, and each failed arm into the `run.failed` the
 * results route answers, with its `detail` as the arm's `message`. Those arms
 * nest no `run_error`, as the platform's did not then, so a test can tell the
 * problem the status read carries from one the arm relays.
 *
 * - `llmCompletion` — a model the inference gateway refused (HTTP 412):
 *   `model.unavailable`, operator domain, not retryable, its caller's step
 *   `change_model`.
 * - `sandboxProvisioning` — a Daytona sandbox that could not be provisioned
 *   while its snapshot was building: `pipelex.sandbox.unavailable`, a Pipelex
 *   code, retryable.
 * - `extractJobFailure` — a provider's 500 on a document extraction:
 *   `provider.failed`, retryable.
 *
 * Written by hand beside them: {@link OPERATOR_VIEW_LLM_COMPLETION_PROBLEM},
 * the `llmCompletion` problem as a runtime serving its operator's view would
 * give it, the provider's raw answer in its `diagnostics`;
 * {@link TIMED_OUT_RUN_PROBLEM}, the problem the platform writes for a run it
 * timed out; and {@link relayingArmOf}, for the failed arm that relays one.
 */
export interface RecordedFailedRun {
  statusRead: RunRead;
  resultsArm: FailedRunState;
  /**
   * The same failed arm as the results route answers it once it nests the
   * run's problem: the status read's problem as the `run_error` of its
   * `run.failed`, which the SDK's failed arm carries as `error`.
   */
  relayedArm: FailedRunState;
}

function load(name: string): RecordedFailedRun {
  const path = fileURLToPath(new URL(`./__fixtures__/failed-runs/${name}.json`, import.meta.url));
  const recorded = JSON.parse(readFileSync(path, "utf8")) as {
    status_read: RunRead;
    results_arm: RunResultState;
  };
  const resultsArm = recorded.results_arm;
  if (resultsArm.state !== "failed") throw new Error(`${name}: the recording is not a failed arm`);
  const runError = recorded.status_read.error ?? null;
  return {
    statusRead: recorded.status_read,
    resultsArm,
    relayedArm: relayingArmOf(resultsArm.pipeline_run_id, runError, resultsArm.status),
  };
}

/**
 * The `llmCompletion` recording's problem in the operator's view, as a runtime
 * serving that view gives it: the operator's step rather than the caller's,
 * and `diagnostics` holding the provider's raw answer, which no result may
 * carry to the model.
 */
export const OPERATOR_VIEW_LLM_COMPLETION_PROBLEM: Problem = buildProblem(
  "model.unavailable",
  { model: "claude-4.8-opus", model_type: "llm", reason: "not_allowed" },
  {
    reader: "actor",
    pipeline_run_id: "run_aa422fd5-59ef-4801-a585-09e6a961e80f",
    extra: {
      diagnostics: {
        provider: "openai",
        status_code: "412",
        message:
          "Error code: 412 - {'error': {'message': 'Model global.anthropic.claude-opus-4-8 is not allowed for this integration', 'type': 'model_not_allowed_error', 'param': None, 'code': None}}",
      },
    },
  },
);

/** The problem the platform writes for a run it stopped at the deployment's run limit of one hour. */
export const TIMED_OUT_RUN_PROBLEM: Problem = buildProblem(
  "run.timed_out",
  { timeout: 3600 },
  { pipeline_run_id: "run_x" },
);

/**
 * The failed arm of a run that ended with `status` whose results read nests
 * `runError`, as the platform's `409` answers it: `run.failed`, its `detail`
 * as the arm's `message`, with the run's problem as its `run_error` and as the
 * arm's `error`.
 */
export function relayingArmOf(
  pipelineRunId: string,
  runError: Problem | null,
  status: RunStatus = "FAILED",
): FailedRunState {
  const problem = buildProblem(
    "run.failed",
    { pipeline_run_id: pipelineRunId, run_status: status },
    {
      status: 409,
      pipeline_run_id: pipelineRunId,
      extra: { run_error: runError ?? undefined },
    },
  );
  return {
    state: "failed",
    pipeline_run_id: pipelineRunId,
    status,
    message: problem.detail,
    problem,
    error: runError,
  };
}

export const RECORDED_FAILED_RUNS = {
  llmCompletion: load("llm-completion-error"),
  sandboxProvisioning: load("sandbox-provisioning-error"),
  extractJobFailure: load("extract-job-failure-error"),
} as const;
