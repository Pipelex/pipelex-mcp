/**
 * The run-graph view's stages, kept pure so they are unit-testable in the Node
 * Vitest environment. The view owns the run, the poll and the results fetch;
 * this module owns what the view shows at each point: the form, then the run
 * going, then the results in the form's place.
 */

import { failureDisplayOf } from "@pipelex/mcp-core/capabilities/run-failure.js";
import type { RunFailureDisplay } from "@pipelex/mcp-core/capabilities/run-failure.js";

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
 * again", which brings it back with the values the user entered in this mount
 * (a remount keeps the run and its pipe, not the values); the dry-run
 * graph gives way to the executed one, which carries the values and each
 * step's status. A failed run shows its failure and keeps the form open, since
 * changing the inputs is the likely next step, and keeps the dry-run graph,
 * since the hosted plane produces no graph for a failed run.
 *
 * Unfolding the form brings the dry-run graph back too: it is the graph whose
 * pipe nodes switch the form to another pipe, and the executed graph has no
 * form to switch.
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
    graph: completed && executedGraph && !editing ? "executed" : "dry_run",
    showPanel: outcome !== null,
    showForm: hasForm && (!completed || editing),
    showEditToggle: hasForm && completed && !editing,
  };
}

/**
 * Whether the run started from the form is still in hand, which holds the Run
 * button disabled: while it starts, while it runs, and once it is terminal until
 * its results are read or their fetch has failed for good. That last window can
 * last several retries, and a second Run inside it would drop the only handle
 * on the first run's output before anyone had seen it. A hard poll error frees
 * the button, since the view has lost track of the run.
 */
export function formRunInFlight({
  starting,
  runId,
  phase,
  hasResults,
  resultsFailed,
}: {
  starting: boolean;
  runId: string | undefined;
  phase: RunPollingSnapshot["phase"];
  hasResults: boolean;
  resultsFailed: boolean;
}): boolean {
  if (starting) return true;
  if (runId === undefined) return false;
  if (phase === "polling") return true;
  return phase === "terminal" && !hasResults && !resultsFailed;
}

/** The status line under the form: what the run started from it is doing, or `null` for nothing to say. */
export interface RunStatusLine {
  text: string;
  tone: "info" | "error";
  /**
   * Why a run that ended without completing failed, what to do and the line
   * for support, which the view shows under the line in the same block the
   * results panel uses. Built from the report's title and user action, never
   * its message, which can carry a provider's raw text.
   */
  failure?: RunFailureDisplay;
}

/**
 * The line under the form while a run started from it has no results to show.
 * Once the results are read, the panel says everything and the line goes. A
 * run that ended without completing says why at once, from the status read's
 * report, since its results add nothing to that and may not arrive at all.
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
  polling: Pick<RunPollingSnapshot, "phase" | "runStatus" | "health" | "hardError"> &
    Partial<Pick<RunPollingSnapshot, "failure" | "finishedAt">>;
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
    if (polling.runStatus !== undefined && polling.runStatus !== "COMPLETED") {
      const failure = failureDisplayOf(runId, polling.failure, polling.finishedAt);
      const ended = `Run ${runId} ${endedWords(polling.runStatus)}: ${asSentence(failure.reason)}`;
      return {
        text:
          resultsError === null
            ? `${ended} Fetching the results…`
            : `${ended} Its results could not be fetched: ${resultsError}`,
        tone: "error",
        failure,
      };
    }
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

/** The text with a closing full stop, unless it already ends a sentence. */
function asSentence(text: string): string {
  return /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

function endedWords(runStatus: RunPollingSnapshot["runStatus"]): string {
  return runStatus === "COMPLETED" ? "completed" : `ended with status ${runStatus ?? "unknown"}`;
}
