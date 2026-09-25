/**
 * The run-graph view's stages, kept pure so they are unit-testable in the Node
 * Vitest environment. The view owns the run, the poll and the results fetch;
 * this module owns what the view shows at each point: the form, then the run
 * going, then the results in the form's place.
 */

import type { RunPollingSnapshot } from "./use-run-polling.js";

/** How a run started from the form ended, once its results have been read: `null` until then. */
export type FormRunOutcome = "completed" | "failed" | null;

export interface FormViewStage {
  /** The graph at the top: the method's dry run, or the executed graph of the run whose results are shown. */
  graph: "dry_run" | "executed";
  /** Whether the results panel is shown, in the form's place. */
  showPanel: boolean;
  /** Whether the input form is shown. */
  showForm: boolean;
  /** Whether "Edit inputs and run again" is offered, which unfolds the form. */
  showEditToggle: boolean;
}

/**
 * What the view shows, from how the current run ended and whether the user
 * asked for the form back.
 *
 * Before a run, and while one is going, the form stays in view: the panel holds
 * the Run button disabled while the run is live, and the status line under it
 * says where the run stands. Once a completed run's results are read, the
 * results take the form's place and the form folds behind "Edit inputs and run
 * again", which brings it back with the values the user entered; the dry-run
 * graph gives way to the executed one, which carries the values and each
 * step's status. A failed run shows its failure and keeps the form open, since
 * changing the inputs is the likely next step, and keeps the dry-run graph,
 * since the hosted plane produces no graph for a failed run.
 *
 * The toggle is offered only where there is a form to unfold, and never while
 * it is already unfolded.
 */
export function formViewStage({
  outcome,
  executedGraph,
  hasForm,
  editing,
}: {
  outcome: FormRunOutcome;
  /** Whether the results carry an executed graph with nodes to draw. */
  executedGraph: boolean;
  hasForm: boolean;
  editing: boolean;
}): FormViewStage {
  const completed = outcome === "completed";
  return {
    graph: completed && executedGraph ? "executed" : "dry_run",
    showPanel: outcome !== null,
    showForm: hasForm && (!completed || editing),
    showEditToggle: hasForm && completed && !editing,
  };
}

/** The status line under the form: what the run started from it is doing, or `null` for nothing to say. */
export interface RunStatusLine {
  text: string;
  tone: "info" | "error";
}

/**
 * The line under the form while a run started from it has no results to show.
 * Once the results are read, the panel says everything and the line goes.
 */
export function runStatusLineFor({
  runId,
  starting,
  startError,
  polling,
  hasResults,
  resultsError,
}: {
  runId: string | undefined;
  starting: boolean;
  startError: string | null;
  polling: Pick<RunPollingSnapshot, "phase" | "runStatus" | "health" | "hardError">;
  hasResults: boolean;
  resultsError: string | null;
}): RunStatusLine | null {
  if (startError) return { text: `Could not start the run: ${startError}`, tone: "error" };
  if (starting) return { text: "Starting the run…", tone: "info" };
  if (!runId || hasResults) return null;
  if (polling.phase === "hard_error") {
    return {
      text: `Run ${runId}: lost track of it (${polling.hardError?.message ?? "status unavailable"}).`,
      tone: "error",
    };
  }
  if (polling.phase === "terminal") {
    return resultsError === null
      ? {
          text: `Run ${runId} ${endedWords(polling.runStatus)}. Fetching the results…`,
          tone: "info",
        }
      : {
          text: `Run ${runId} ${endedWords(polling.runStatus)}, but its results could not be fetched: ${resultsError}`,
          tone: "error",
        };
  }
  const suffix =
    polling.health === "reconnecting"
      ? " (reconnecting…)"
      : polling.health === "retrying"
        ? " (retrying…)"
        : "";
  return { text: `Run ${runId}: ${polling.runStatus ?? "starting"}${suffix}`, tone: "info" };
}

function endedWords(runStatus: RunPollingSnapshot["runStatus"]): string {
  return runStatus === "COMPLETED" ? "completed" : `ended with status ${runStatus ?? "unknown"}`;
}
