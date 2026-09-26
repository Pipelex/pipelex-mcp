import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { RunRead, RunResultState } from "@pipelex/sdk";

import type { FailedRunState } from "./run.js";

/**
 * Failed runs recorded from the dev plane, for the hermetic tests of every
 * failed arm in the run family and of the console's failure display.
 *
 * Each recording holds two reads of one real run, as the SDK returned them on
 * 2026-09-26: its status read (`getRunStatus`), which carries the error report
 * the runner stored, and its results read (`getRunResult`), whose failed arm
 * carried no report yet because the platform did not relay it on the results
 * route's `409`. The identifiers of the organization, the user and the workflow
 * were left out; everything else is verbatim, the provider's raw text in
 * `message` and `provider_metadata` included, since that text is exactly what
 * the tests prove stays out of a person's view.
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

export const RECORDED_FAILED_RUNS = {
  llmCompletion: load("llm-completion-error"),
  sandboxProvisioning: load("sandbox-provisioning-error"),
  extractJobFailure: load("extract-job-failure-error"),
} as const;
