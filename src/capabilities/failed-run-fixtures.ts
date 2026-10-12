import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RunErrorReport, RunRead, RunResultState } from "@pipelex/sdk";

import type { FailedRunState } from "./run.js";

/**
 * Failed runs recorded from the dev plane, for the hermetic tests of every
 * failed arm in the run family.
 *
 * Each recording holds two reads of one real run, as the SDK returned them on
 * 2026-09-26: its status read (`getRunStatus`), which carries the error report
 * the runner stored, and its results read (`getRunResult`), whose failed arm
 * carried no report yet because the platform did not relay it on the results
 * route's `409`. The identifiers of the organization, the user and the workflow
 * were left out; everything else is verbatim, the provider's raw text in
 * `message` and `provider_metadata` included, since the tests check which of
 * it reaches the model and which is left out.
 *
 * The platform served the runner's VERBOSE report then, the shape a local loop
 * with a verbose disclosure still serves. None of these reports is flagged
 * `caller_facing_message`, so none of their messages reaches the model, in the
 * `failure` object or in the failed arm's `failure_message`. The shapes the
 * platform serves now, through the runner's STRICT disclosure, are written by
 * hand below them: {@link STRICT_LLM_COMPLETION_REPORT} and
 * {@link CALLER_FACING_TIMEOUT_REPORT}, with {@link relayingArmOf} for the
 * failed arm that relays one.
 *
 * - `llmCompletion` — a model the inference gateway refused (HTTP 412), not
 *   retryable, with a `change_input` user action.
 * - `sandboxProvisioning` — a sandbox that could not be provisioned while its
 *   snapshot was building: a report with no `retryable` and no user action.
 * - `extractJobFailure` — a provider's 500 on a document extraction, retryable,
 *   with a `wait_and_retry` user action.
 */
export interface RecordedFailedRun {
  statusRead: RunRead;
  resultsArm: FailedRunState;
  /**
   * The same failed arm as a platform that relays the stored report on the
   * results route answers it: the report on `error`, and the `detail` sentence
   * naming its message, the shape the SDK's failed arm takes from that release.
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
  const report = recorded.status_read.error ?? null;
  return {
    statusRead: recorded.status_read,
    resultsArm,
    relayedArm: {
      ...resultsArm,
      message: `Run finished with status ${resultsArm.status}: ${report?.message ?? ""}`,
      error: report,
    },
  };
}

/**
 * The `llmCompletion` recording's report as the platform serves it now, through
 * the runner's STRICT disclosure: not flagged caller-facing, so its message is
 * the placeholder, its user action is dropped and its provider metadata keeps
 * the status code alone.
 */
export const STRICT_LLM_COMPLETION_REPORT: RunErrorReport = {
  error_type: "LLMCompletionError",
  title: "LLM completion",
  type_uri: "https://docs.pipelex.com/latest/errors/llm-completion-error/",
  error_domain: "config",
  error_category: "configuration",
  retryable: false,
  message: "An internal error occurred.",
  provider_metadata: { status_code: "412" },
};

/**
 * A report the platform writes itself, here for a run Temporal timed out:
 * caller-facing copy, so the STRICT disclosure keeps its message, its next step
 * and its flag.
 */
export const CALLER_FACING_TIMEOUT_REPORT: RunErrorReport = {
  error_type: "RunTimedOutError",
  title: "Run timed out",
  type_uri: "https://docs.pipelex.com/latest/errors/run_timed_out",
  message:
    "The run did not finish within its time limit of 1 hour, so the workflow engine stopped it. A method that does more work than fits in that limit ends this way. If this one should fit, contact Pipelex support and give them the run id run_x.",
  error_domain: "runtime",
  retryable: false,
  user_action: { kind: "contact_support", detail: "Give support the run id run_x." },
  caller_facing_message: true,
};

/**
 * The failed arm of a FAILED run whose results read relays `report`, worded as
 * the platform's `409` words it: the status, then the served report's message
 * when it has one.
 */
export function relayingArmOf(pipelineRunId: string, report: RunErrorReport): FailedRunState {
  const message =
    typeof report.message === "string" && report.message.trim() !== "" ? report.message : undefined;
  return {
    state: "failed",
    pipeline_run_id: pipelineRunId,
    status: "FAILED",
    message:
      message === undefined
        ? "Run finished with status FAILED; no result available"
        : `Run finished with status FAILED: ${message}`,
    error: report,
  };
}

export const RECORDED_FAILED_RUNS = {
  llmCompletion: load("llm-completion-error"),
  sandboxProvisioning: load("sandbox-provisioning-error"),
  extractJobFailure: load("extract-job-failure-error"),
} as const;
