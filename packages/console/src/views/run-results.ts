/**
 * The results decision core both run views share, kept pure so it is
 * unit-testable in the Node Vitest environment. `useRunResults` owns the fetch
 * loop and `RunResultsPanel` the rendering; this module owns what a completed
 * or failed result reads as: which pipe ran, the field its output renders
 * through, and the header line.
 */

// Through `@pipelex/mthds-ui/form`, which re-exports the kernel whole — never
// `@pipelex/mthds-form` directly, which would put a second copy in the tree.
import { buildResultField, getPipeIOContract, getPipeOutputForm } from "@pipelex/mthds-ui/form";
import type { InputForm, OutputForm, PipeIOContracts, RunField } from "@pipelex/mthds-ui/form";
import type { GraphSpec } from "@pipelex/mthds-ui";

import type { RunResultsStructuredContent, RunUsage } from "@pipelex/mcp-core/capabilities/run.js";
import { graphPipeRefOf, parsePipeRef } from "./run-graph-selection.js";

/** A settled results fetch: the structured verdict plus the view-only artifacts it carried on `_meta`. */
export interface RunResultsView {
  content: RunResultsStructuredContent;
  graphSpec: GraphSpec | null;
  /**
   * The graph's data artifacts. `contracts` and `outputForm` are a pair by the
   * renderer's own rule — `GraphViewer` shows a data node's VALUE only when it
   * holds both, and the concept's structure table otherwise — and the
   * capability ships them as one, so a half-populated pair never reaches here.
   * `inputForm` is optional given the pair: it is what lets the method's own
   * inputs show their value.
   */
  contracts: PipeIOContracts | null;
  outputForm: OutputForm | null;
  inputForm: InputForm | null;
  /** The full, unbounded main output (`_meta.main_stuff`); `content.main_stuff` is the bounded copy. */
  mainStuff: unknown;
}

/**
 * Read a results response into the view's shape. Every artifact is opaque on
 * the wire — the standard owns their types and nothing validates them at
 * runtime — so each is a cast, exactly as the graph spec has always been; the
 * lookups downstream miss on a malformed map rather than throw.
 */
export function runResultsViewOf(
  content: RunResultsStructuredContent,
  meta: Record<string, unknown> | undefined,
): RunResultsView {
  return {
    content,
    graphSpec: (meta?.graph_spec ?? null) as GraphSpec | null,
    contracts: (meta?.pipe_io_contracts ?? null) as PipeIOContracts | null,
    outputForm: (meta?.output_form ?? null) as OutputForm | null,
    inputForm: (meta?.input_form ?? null) as InputForm | null,
    mainStuff: meta?.main_stuff,
  };
}

/** Whether the result carries an executed graph with at least one node to draw. */
export function hasExecutedGraph(results: RunResultsView): boolean {
  return (results.graphSpec?.nodes?.length ?? 0) > 0;
}

/**
 * The pipe the run executed, as a qualified `domain.pipe_code`: the one the
 * executed graph names, else the one the run was asked for, else `null`.
 *
 * The results carry an output descriptor for every pipe the library declares,
 * so rendering the output needs to know which one ran. The executed graph comes
 * first because it is the runtime's own statement: a live run stamps
 * `pipeline_ref` with the entry pipe it resolved and traced, manifest included,
 * which the caller cannot always know — `run-follow` does not when the model ran
 * the method's entry pipe without naming it. The requested ref is what the run
 * was started with, and stands in when the runner assembled no graph.
 *
 * There is deliberately no third arm reaching for the only entry of a
 * one-pipe descriptor map: a guess that renders the wrong pipe's shape over
 * the payload is worse than the JSON view the panel falls back to.
 */
export function executedPipeRefOf(
  graphSpec: unknown,
  requestedPipeRef: string | null | undefined,
): string | null {
  const fromGraph = graphPipeRefOf(graphSpec);
  if (fromGraph) return fromGraph;
  const requested = requestedPipeRef?.trim();
  return requested ? requested : null;
}

/**
 * The field the kernel renders the output through, or `null` when the result
 * cannot describe it — the panel then shows the payload as JSON.
 *
 * The kernel's own reference wiring (`mthds-form`'s `result-view` harness):
 * look the pipe up in both artifacts, pair the output descriptor with the
 * payload schema off the contract (`output.json_schema`, which names the
 * property a native payload sits under), derive one field. Every step can miss
 * on an older runner or a malformed map, and `buildResultField` walks a node
 * nothing validated, so a throw is a miss too: a result view has no business
 * failing to show a payload it holds.
 */
export function outputFieldFor(
  contracts: PipeIOContracts | null,
  outputForm: OutputForm | null,
  pipeRef: string | null,
): RunField | null {
  if (!pipeRef || !contracts || !outputForm) return null;
  const { domain, code } = parsePipeRef(pipeRef);
  try {
    const descriptor = getPipeOutputForm(outputForm, domain, code);
    const schema = getPipeIOContract(contracts, domain, code)?.output?.json_schema;
    if (!descriptor || !isRecord(schema)) return null;
    return buildResultField(descriptor, schema);
  } catch {
    return null;
  }
}

/**
 * The run's wall-clock duration in seconds, from its record's own timestamps
 * (`created_at` to `finished_at`, as the status read reports them), or `null`
 * when either is missing or unreadable. Measured from creation, so a run that
 * sat in the queue reports the time the user actually waited.
 */
export function runDurationSeconds(
  createdAt: string | undefined,
  finishedAt: string | null | undefined,
): number | null {
  if (!createdAt || !finishedAt) return null;
  const started = Date.parse(createdAt);
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) return null;
  return (finished - started) / 1000;
}

/** `23.6 s`, `2 min 5 s`, `1 h 3 min`. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const rest = totalSeconds % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * The run's cost as the header writes it, or `null` when there is nothing
 * honest to print.
 *
 * Written at the four-decimal precision `@pipelex/mthds-ui`'s graph panel uses
 * (its `formatCost`, not exported yet), so the header and the node panel agree
 * on how a cost reads; a cost too small to show is `<$0.0001`, never a rounded
 * zero. A partial cost — some calls unpriced — is a lower bound and says so
 * with `≥`. Nothing is printed when no call was priced, when the run made no
 * inference, or when usage is unknown: a missing dollar is never a zero one.
 * No token count appears, because the counts are wrong upstream today while
 * the cost is sound.
 */
export function formatRunCost(usage: RunUsage | undefined): string | null {
  if (!usage || usage.state !== "records" || usage.calls === 0) return null;
  const cost = usage.cost_usd;
  if (cost === null || !Number.isFinite(cost)) return null;
  if (usage.cost_partial === true) return `≥ $${cost.toFixed(4)}`;
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(4)}`;
}

/** The completed header: `Completed in 23.6 s · $0.0138`, each half only when it is known. */
export function completedHeadline(
  durationSeconds: number | null,
  usage: RunUsage | undefined,
): string {
  const head =
    durationSeconds === null ? "Completed" : `Completed in ${formatDuration(durationSeconds)}`;
  const cost = formatRunCost(usage);
  return cost === null ? head : `${head} · ${cost}`;
}

/** Friendly words for the terminal statuses a run can fail with. */
const FAILURE_WORDS: Partial<Record<RunStatus, string>> = {
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  TERMINATED: "Terminated",
  TIMED_OUT: "Timed out",
};

/** The failed header: `Failed after 12.1 s`, or the status alone when the duration is unknown. */
export function failedHeadline(
  runStatus: RunStatus | undefined,
  durationSeconds: number | null,
): string {
  const words = (runStatus && FAILURE_WORDS[runStatus]) ?? "Failed";
  return durationSeconds === null ? words : `${words} after ${formatDuration(durationSeconds)}`;
}

/** A terminal (or any) lifecycle status, as the results tool reports it. */
type RunStatus = NonNullable<RunResultsStructuredContent["run_status"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
