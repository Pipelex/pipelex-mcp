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
import type { ResolveUrl } from "@pipelex/mthds-ui/form/react";

import type { RunResultsStructuredContent, RunUsage } from "@pipelex/mcp-core/capabilities/run.js";
import type { ToolError } from "@pipelex/mcp-core/capabilities/shared.js";
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
  /** The fresh links the results carried (`_meta.resolved_urls`), each stored reference to its link. */
  links: ReadonlyMap<string, string>;
  /**
   * The kernel's resolver over {@link links}, for the output and the executed
   * graph alike, or undefined when there are none. Built once per set of
   * links, so it keeps one identity for as long as they are on screen.
   */
  resolveUrl: ResolveUrl | undefined;
  /**
   * Whether a failed request left some reference without a link
   * (`_meta.resolved_urls_partial`), which `useRunResults` reads the results
   * again for, and the panel says while it holds.
   */
  linksPartial: boolean;
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
    ...withLinks(linksOf(meta?.resolved_urls)),
    linksPartial: meta?.resolved_urls_partial === true,
  };
}

/**
 * A view already on screen, with the links a later read of the same run
 * minted for references it had none for. Everything else stays as it was,
 * the artifacts' identities included, so the output and the graph repaint
 * their files without being derived again; a link already held is kept rather
 * than swapped for a new one, which would reload a picture that painted. The
 * partial flag is the later read's, since it answers for the latest request.
 */
export function withLinksFrom(shown: RunResultsView, later: RunResultsView): RunResultsView {
  let merged: Map<string, string> | undefined;
  for (const [reference, link] of later.links) {
    if (shown.links.has(reference)) continue;
    merged ??= new Map(shown.links);
    merged.set(reference, link);
  }
  return {
    ...shown,
    ...(merged === undefined ? {} : withLinks(merged)),
    linksPartial: later.linksPartial,
  };
}

/** The links and the kernel's resolver over them, built together so they never disagree. */
function withLinks(
  links: ReadonlyMap<string, string>,
): Pick<RunResultsView, "links" | "resolveUrl"> {
  return { links, resolveUrl: resolverOver(links) };
}

/**
 * The kernel's `resolveUrl` over `_meta.resolved_urls`, the fresh link the
 * console minted for each stored file when it read the results. A lookup,
 * because the kernel's resolver is synchronous by design: a host that must
 * presign resolves the run's references in one batch and closes over the map.
 *
 * The files have to paint from these. The payload's own `public_url` is signed
 * path-style on the shared regional S3 host, which no host's CSP scoped to a
 * bucket, and it expires an hour after the run; these are signed on each
 * bucket's own host, which the views' CSP names, and a remount reads new ones.
 * A reference with no link answers `undefined`, which the kernel reads as "use
 * the payload's `public_url`". Anything but a map of `https:` strings reads as
 * no links, since the value lands in an `<img src>`.
 */
export function resolveUrlFor(value: unknown): ResolveUrl | undefined {
  return resolverOver(linksOf(value));
}

/** `_meta.resolved_urls` narrowed to a map of `https:` links; anything else reads as none. */
function linksOf(value: unknown): Map<string, string> {
  const links = new Map<string, string>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) return links;
  for (const [reference, link] of Object.entries(value)) {
    if (typeof link === "string" && link.startsWith("https://")) links.set(reference, link);
  }
  return links;
}

function resolverOver(links: ReadonlyMap<string, string>): ResolveUrl | undefined {
  if (links.size === 0) return undefined;
  return (url) => links.get(url);
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
  // Compared after rounding to the tenth it is written at, so 59.97 s reads
  // `1 min` rather than `60.0 s`.
  if (Math.round(seconds * 10) < 600) return `${seconds.toFixed(1)} s`;
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
 * Nor for a partial cost too small to write, since a lower bound that rounds
 * to nothing says nothing, and `≥ $0.0000` would read as free.
 * No token count appears, because the counts are wrong upstream today while
 * the cost is sound.
 */
export function formatRunCost(usage: RunUsage | undefined): string | null {
  if (!usage || usage.state !== "records" || usage.calls === 0) return null;
  const cost = usage.cost_usd;
  if (cost === null || !Number.isFinite(cost)) return null;
  if (usage.cost_partial === true) return cost < 0.0001 ? null : `≥ $${cost.toFixed(4)}`;
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

/**
 * How much of a run's output, serialized, the panel renders whole. The kernel
 * renders eagerly — one element per list row, one span per JSON token — inside
 * a frame in the conversation, so an output past this is not handed to it; the
 * panel shows the bounded copy the model reads instead, as JSON. Set an order
 * of magnitude above that copy's 32 KiB and past anything a person reads in a
 * chat; it is a guard against a pathological output, not a measured frame
 * budget.
 */
export const FULL_OUTPUT_RENDER_BUDGET = 256 * 1024;

/** What the panel renders for the output, and the full output's size when it was too large to render. */
export interface OutputToRender {
  value: unknown;
  /** The full output's serialized length, in characters, when it is over the budget; `null` when the value is it. */
  oversizedLength: number | null;
}

/**
 * The output the panel renders: the full one (`_meta.main_stuff`) when it is
 * within {@link FULL_OUTPUT_RENDER_BUDGET}, else the bounded copy
 * (`structuredContent.main_stuff`). The bounded copy is also the floor for a
 * response that carried no full output at all.
 */
export function outputToRender(full: unknown, bounded: unknown): OutputToRender {
  if (full === undefined) return { value: bounded, oversizedLength: null };
  let length: number;
  try {
    length = JSON.stringify(full)?.length ?? 0;
  } catch {
    return { value: bounded, oversizedLength: null };
  }
  return length > FULL_OUTPUT_RENDER_BUDGET
    ? { value: bounded, oversizedLength: length }
    : { value: full, oversizedLength: null };
}

/**
 * How many times one run's results are read before the fetch stops and says
 * so. On the poll ladder that is a little over two minutes, longer when the
 * server hints a wait, and far past the mid-write race a retry exists for. A
 * fetch that never settled would hold the form's Run button for as long as the
 * view stayed open, and again after every remount, since the run it follows is
 * persisted.
 */
export const RESULTS_FETCH_MAX_ATTEMPTS = 40;

/**
 * When a completed result's links came back partial, how long `useRunResults`
 * waits before each further read for the missing ones, in order; the list's
 * length is how many it makes. The output stays on screen meanwhile, so these
 * are spaced for a route that is recovering rather than hammered at the poll
 * ladder's first rung, and they stop after the last: a route that is still
 * failing a minute on is not coming back while the view is open, and a
 * remount reads again.
 */
export const LINK_REREAD_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

/**
 * The error a results fetch settles on once {@link RESULTS_FETCH_MAX_ATTEMPTS}
 * reads have not produced the results, naming what the last one ran into. It
 * is not retryable in the view; a remount starts a fresh fetch.
 */
export function resultsFetchExhausted(lastProblem: string): ToolError {
  return {
    class: "runtime",
    message: `The results were still unreadable after ${RESULTS_FETCH_MAX_ATTEMPTS} attempts (${lastProblem}).`,
    hint: "Reopen this view to try again, or ask the assistant for this run's results.",
    retryable: false,
  };
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
