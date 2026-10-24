import type { ProgressInvocation, RunDegradation, RunProgress } from "@pipelex/sdk";

/**
 * Progress snapshots for the hermetic tests of the status tool's progress.
 *
 * {@link MID_RUN_SNAPSHOT} is the worked example of the hosted progress
 * contract (`conformance/specs/pipelex-platform-api.md`, "Run progress" →
 * "Worked example"), copied member for member: a run of `filings.review_filings`
 * over three filings, step 3's batch running, item 2's second step retried and
 * item 3 stuck, so the status read reports the run degraded. Its `summary` is
 * the line the contract's rule words from it, which the status tool must relay
 * as it is. The degradation's message is abbreviated there and here alike.
 * The other snapshots are written by hand in the same shape.
 */

const RUN_ID = "run_7Qd2kV";

/** The `workflow_task_failing` degradation of the worked example, as the status read serves it. */
export const STUCK_ITEM_DEGRADATION: RunDegradation = {
  reason: "workflow_task_failing",
  message:
    "One of this run's batch branches, …, has failed 4 times in a row, so the run is not making progress. …",
  failed_attempts: 4,
  failing_since: "2026-10-12T09:30:33.480Z",
  ends_at: "2026-10-12T09:45:33.480Z",
};

/**
 * The latest failure of item 2's second step in the worked example, as the
 * hosted contract serves it: `{ problem, at }`, the problem an engine-observed
 * failure is served as, `runtime.unexpected`. `@pipelex/sdk`'s
 * `ProgressFailure` still types `last_failure` as `{ message, at }`, a shape
 * the platform no longer serves, and relays the member untouched, so the
 * snapshot carries it cast to that type.
 */
export const RETRIED_STEP_FAILURE = {
  problem: {
    type: "https://mthds.ai/errors/runtime.unexpected",
    title: "An unexpected error occurred",
    detail: "The runtime met an unexpected error.",
    code: "runtime.unexpected",
    domain: "runtime",
    retry: "no",
    next_step: { kind: "report", detail: "Report this to whoever runs the runtime." },
  },
  at: "2026-10-12T09:30:52.317Z",
};

/** The summary the contract words from {@link MID_RUN_SNAPSHOT}. */
export const MID_RUN_SUMMARY =
  "Running summarize_filing_batch (step 3 of 4): 1 of 3 items done, 2 running; not progressing at summarize_filing (step 3 of 4, item 3 of 3) after 4 failed attempts";

function invocation(
  path: string,
  pipeCode: string,
  pipeType: string,
  status: ProgressInvocation["status"],
  startedAt: string | null,
  endedAt: string | null,
  extra: Partial<ProgressInvocation> = {},
): ProgressInvocation {
  return {
    path,
    pipe_code: pipeCode,
    pipe_ref: `filings.${pipeCode}`,
    pipe_type: pipeType,
    status,
    started_at: startedAt,
    ended_at: endedAt,
    ...extra,
  };
}

const ROOT = "filings.review_filings";

/** The worked example's mid-run snapshot. */
export const MID_RUN_SNAPSHOT: RunProgress = {
  pipeline_run_id: RUN_ID,
  mode: "live",
  status: "running",
  version: 26,
  assembled_at: "2026-10-12T09:31:20.512Z",
  summary: MID_RUN_SUMMARY,
  degradation: STUCK_ITEM_DEGRADATION,
  invocations: [
    invocation(
      ROOT,
      "review_filings",
      "PipeSequence",
      "running",
      "2026-10-12T09:30:00.104Z",
      null,
      {
        step_count: 4,
      },
    ),
    invocation(
      `${ROOT}/step_1`,
      "extract_filings",
      "PipeExtract",
      "succeeded",
      "2026-10-12T09:30:00.131Z",
      "2026-10-12T09:30:06.870Z",
    ),
    invocation(
      `${ROOT}/step_2`,
      "choose_depth",
      "PipeCondition",
      "succeeded",
      "2026-10-12T09:30:06.902Z",
      "2026-10-12T09:30:19.415Z",
      { condition: { selected_outcome: "detailed" } },
    ),
    invocation(
      `${ROOT}/step_2/outcome_detailed`,
      "deep_checks",
      "PipeParallel",
      "succeeded",
      "2026-10-12T09:30:07.020Z",
      "2026-10-12T09:30:19.401Z",
      { branch_count: 2 },
    ),
    invocation(
      `${ROOT}/step_2/outcome_detailed/branch_1`,
      "check_figures",
      "PipeLLM",
      "succeeded",
      "2026-10-12T09:30:07.034Z",
      "2026-10-12T09:30:15.660Z",
    ),
    invocation(
      `${ROOT}/step_2/outcome_detailed/branch_2`,
      "check_wording",
      "PipeLLM",
      "succeeded",
      "2026-10-12T09:30:07.036Z",
      "2026-10-12T09:30:19.388Z",
    ),
    invocation(
      `${ROOT}/step_3`,
      "summarize_filing_batch",
      "PipeBatch",
      "running",
      "2026-10-12T09:30:19.440Z",
      null,
      { batch: { total: 3, done: 1, running: 2, failed: 0 } },
    ),
    invocation(
      `${ROOT}/step_3/item_1`,
      "summarize_filing",
      "PipeSequence",
      "succeeded",
      "2026-10-12T09:30:19.611Z",
      "2026-10-12T09:30:41.022Z",
      { step_count: 2 },
    ),
    invocation(
      `${ROOT}/step_3/item_1/step_1`,
      "read_filing",
      "PipeLLM",
      "succeeded",
      "2026-10-12T09:30:19.630Z",
      "2026-10-12T09:30:30.118Z",
    ),
    invocation(
      `${ROOT}/step_3/item_1/step_2`,
      "condense_filing",
      "PipeLLM",
      "succeeded",
      "2026-10-12T09:30:30.140Z",
      "2026-10-12T09:30:41.010Z",
    ),
    invocation(
      `${ROOT}/step_3/item_2`,
      "summarize_filing",
      "PipeSequence",
      "running",
      "2026-10-12T09:30:19.640Z",
      null,
      { step_count: 2 },
    ),
    invocation(
      `${ROOT}/step_3/item_2/step_1`,
      "read_filing",
      "PipeLLM",
      "succeeded",
      "2026-10-12T09:30:19.655Z",
      "2026-10-12T09:30:31.902Z",
    ),
    invocation(
      `${ROOT}/step_3/item_2/step_2`,
      "condense_filing",
      "PipeLLM",
      "running",
      "2026-10-12T09:30:31.930Z",
      null,
      {
        attempts: 2,
        last_failure: RETRIED_STEP_FAILURE as unknown as ProgressInvocation["last_failure"],
      },
    ),
    invocation(
      `${ROOT}/step_3/item_3`,
      "summarize_filing",
      "PipeSequence",
      "running",
      "2026-10-12T09:30:19.702Z",
      null,
      { step_count: 2, degradation: STUCK_ITEM_DEGRADATION },
    ),
    invocation(
      `${ROOT}/step_3/item_3/step_1`,
      "read_filing",
      "PipeLLM",
      "running",
      "2026-10-12T09:30:19.720Z",
      null,
    ),
  ],
};

/** A pending run's snapshot: no invocation, and the contract's pending sentence. */
export const PENDING_SNAPSHOT: RunProgress = {
  pipeline_run_id: RUN_ID,
  mode: "live",
  status: "pending",
  version: 0,
  assembled_at: "2026-10-12T09:29:58.004Z",
  summary: "Waiting to start",
  invocations: [],
};

/**
 * The snapshot of the same run once it has failed at item 2's second step, whose
 * summary is the contract's failed sentence naming the deepest failed
 * invocation. Its invocations are left out, since the tests read its summary.
 */
export const FAILED_RUN_SNAPSHOT: RunProgress = {
  pipeline_run_id: RUN_ID,
  mode: "live",
  status: "failed",
  version: 29,
  assembled_at: "2026-10-12T09:32:04.100Z",
  summary: "Failed at condense_filing (step 3 of 4, item 2 of 3, step 2 of 2)",
  invocations: [],
};

/**
 * A batch of `itemCount` items, each a two-step sequence, with every item done
 * but the one at `runningItem` (1-based), whose second step is running: a
 * snapshot far wider than the status tool lists.
 */
export function wideBatchSnapshot(itemCount: number, runningItem: number): RunProgress {
  const invocations: ProgressInvocation[] = [
    invocation(
      ROOT,
      "review_filings",
      "PipeSequence",
      "running",
      "2026-10-12T09:30:00.104Z",
      null,
      {
        step_count: 2,
      },
    ),
    invocation(`${ROOT}/step_1`, "summarize_filing_batch", "PipeBatch", "running", null, null, {
      batch: { total: itemCount, done: itemCount - 1, running: 1, failed: 0 },
    }),
  ];
  for (let item = 1; item <= itemCount; item += 1) {
    const running = item === runningItem;
    const itemPath = `${ROOT}/step_1/item_${item}`;
    invocations.push(
      invocation(
        itemPath,
        "summarize_filing",
        "PipeSequence",
        running ? "running" : "succeeded",
        null,
        null,
      ),
      invocation(`${itemPath}/step_1`, "read_filing", "PipeLLM", "succeeded", null, null),
      invocation(
        `${itemPath}/step_2`,
        "condense_filing",
        "PipeLLM",
        running ? "running" : "succeeded",
        null,
        null,
      ),
    );
  }
  return {
    pipeline_run_id: RUN_ID,
    mode: "live",
    status: "running",
    version: invocations.length,
    assembled_at: "2026-10-12T09:31:20.512Z",
    summary: `Running condense_filing (step 1 of 2, item ${runningItem} of ${itemCount}, step 2 of 2)`,
    invocations,
  };
}
