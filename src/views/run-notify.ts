/**
 * The completion-handoff decision core of the run-follow view, kept pure so
 * it is unit-testable in the Node Vitest environment. The view owns the
 * `sendFollowUpMessage` call and the once-per-run guard; this module owns the
 * prompt wording.
 */

/** The two run outcomes that hand the conversation back to the model. */
export type TerminalRunOutcome = "completed" | "failed";

/**
 * The canned prompt the view sends back to the conversation when a run
 * resolves its terminal outcome. It names the run id so the model can
 * disambiguate when several runs share one conversation, and it is also what
 * the manual "Summarize in chat" button sends — one wording, both triggers.
 */
export function terminalFollowUpPrompt(runId: string, outcome: TerminalRunOutcome): string {
  return outcome === "failed"
    ? `Run ${runId} failed — report what went wrong.`
    : `Run ${runId} completed — report the results.`;
}
