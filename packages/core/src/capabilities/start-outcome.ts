/**
 * The words for a start whose outcome is unknown: a start that failed in a way
 * that may still have created the run, which {@link classifyStartError} in
 * `run.ts` marks not retryable. They live apart from `run.ts` because the
 * console's views read them too, and `run.ts` imports the SDK and zod, which a
 * view cannot bundle; this module imports nothing.
 *
 * The hint is the marker: `classifyStartError` is the only place that sets it,
 * so the tool's headline and both views recognise a may-have-run start by it.
 */

/** The hint on a start that may have run, worded for a lost answer, a gateway's answer and the runner's own 500. */
export const START_MAY_HAVE_RUN_HINT =
  "The request may have reached the server, so the run may have started before this failure. Check before starting it again: a second start would be a second run, spending inference credit again.";

/** The headline of a start that may have run, which must not say the run did not start. */
export const START_MAY_HAVE_RUN_SUMMARY =
  "Run may have started: the start failed after the request may have reached the Pipelex API, so check before starting it again.";

/** Whether a start error is one after which the run may exist. */
export function startMayHaveRunError(error: { hint?: string } | undefined): boolean {
  return error?.hint === START_MAY_HAVE_RUN_HINT;
}
