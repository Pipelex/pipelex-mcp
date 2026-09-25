import { useEffect, useRef, useState } from "react";

import type { RunResultsStructuredContent } from "@pipelex/mcp-core/capabilities/run.js";
import type { ToolError } from "@pipelex/mcp-core/capabilities/shared.js";
import { isTransientPollError, nextPollDelayMs } from "./run-polling.js";
import {
  LINK_REREAD_DELAYS_MS,
  RESULTS_FETCH_MAX_ATTEMPTS,
  resultsFetchExhausted,
  runResultsViewOf,
  withLinksFrom,
} from "./run-results.js";
import type { RunResultsView } from "./run-results.js";

/** The slice of `useCallTool("pipelex_run_results")` the fetch loop consumes. */
export type ResultsFetcher = (args: { run_id: string }) => Promise<{
  structuredContent: RunResultsStructuredContent;
  meta?: Record<string, unknown>;
}>;

export interface RunResultsSnapshot {
  /** The settled results of the run, completed or failed; `null` until they are read. */
  results: RunResultsView | null;
  /** The error that stopped the fetch, when it was not transient. */
  error: ToolError | null;
}

/** What the loop settled on, stamped with the run it is for. */
interface SettledResults extends RunResultsSnapshot {
  runId: string;
}

const NOTHING: RunResultsSnapshot = { results: null, error: null };

/**
 * One results fetch for a run once it is terminal, shared by both run views.
 *
 * A `state: "running"` answer is the mid-write race (the status flipped
 * terminal before the artifacts were written), retried on the server's hint;
 * transient errors are retried too. Retries age along the same elapsed-time
 * ladder as status polls, measured from the first attempt, so a persistent
 * race or hiccup backs off instead of hammering the endpoint at the ladder's
 * first rung. Same visibility discipline as the status loop: nothing is
 * scheduled while the tab is hidden, and one immediate fetch runs on return.
 * After {@link RESULTS_FETCH_MAX_ATTEMPTS} reads without the results, the loop
 * settles on an error naming what the last one ran into, which frees the form's
 * Run button and puts the failure on screen.
 *
 * A completed result whose links came back partial (a request for them failed
 * or ran out of time) settles at once, so the output shows, and is then read
 * again on {@link LINK_REREAD_DELAYS_MS} for the links alone: each later read
 * adds the links it minted to the view on screen and changes nothing else, so
 * a file the first read could not link paints once the route recovers, without
 * a remount. A re-read that fails or answers anything but a completed result
 * spends one and leaves the view as it is.
 *
 * The snapshot is stamped with the run it answers for, so a view that starts
 * another run sees nothing until that run's own results are read — never the
 * previous run's, not even for the render before the effect catches up.
 */
export function useRunResults(
  runId: string | undefined,
  terminal: boolean,
  fetchResults: ResultsFetcher,
): RunResultsSnapshot {
  const [settled, setSettled] = useState<SettledResults | null>(null);

  // The fetcher from useCallTool changes identity per render; pin the latest
  // so the effect depends on the run only and never cancels itself.
  const fetchRef = useRef(fetchResults);
  fetchRef.current = fetchResults;

  useEffect(() => {
    if (!runId || !terminal) {
      return;
    }
    const firstAttemptAt = Date.now();
    let cancelled = false;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    // What the last read ran into, for the error the loop settles on when it stops.
    let lastProblem = "no answer yet";
    // The results on screen once a read has settled them; every later read is
    // a re-read for links the first one could not mint.
    let shown: RunResultsView | null = null;
    let linkRereads = 0;
    const retry = (retryAfterSeconds?: number | null) => {
      if (cancelled || done) {
        return;
      }
      if (attempts >= RESULTS_FETCH_MAX_ATTEMPTS) {
        done = true;
        setSettled({ runId, results: null, error: resultsFetchExhausted(lastProblem) });
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      timer = setTimeout(
        () => void fetchOnce(),
        nextPollDelayMs(Date.now() - firstAttemptAt, retryAfterSeconds),
      );
    };
    const rereadForLinks = () => {
      if (cancelled || done) {
        return;
      }
      const delay = LINK_REREAD_DELAYS_MS[linkRereads];
      if (delay === undefined) {
        done = true;
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      timer = setTimeout(() => void fetchOnce(), delay);
    };
    // At most one results fetch in flight: a hidden→visible flip during a
    // fetch must not start a concurrent one (each would schedule its own
    // retry, orphaning the other's timer).
    let inFlight = false;
    const fetchOnce = async () => {
      if (cancelled || done || inFlight) {
        return;
      }
      inFlight = true;
      const rereading = shown !== null;
      if (rereading) {
        linkRereads += 1;
      } else {
        attempts += 1;
      }
      let content: RunResultsStructuredContent;
      let meta: Record<string, unknown> | undefined;
      try {
        const response = await fetchRef.current({ run_id: runId });
        content = response.structuredContent;
        meta = response.meta;
      } catch (err) {
        inFlight = false;
        if (rereading) {
          rereadForLinks();
          return;
        }
        lastProblem = err instanceof Error ? err.message : "the call failed";
        retry();
        return;
      }
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (shown !== null) {
        // The results are on screen; this read is for their missing links only.
        if (content.status !== "error" && content.state === "completed") {
          shown = withLinksFrom(shown, runResultsViewOf(content, meta));
          setSettled({ runId, results: shown, error: null });
          if (!shown.linksPartial) {
            done = true;
            return;
          }
        }
        rereadForLinks();
        return;
      }
      if (content.status === "error") {
        const error = content.errors?.[0] ?? {
          class: "runtime" as const,
          message: "pipelex_run_results produced no verdict.",
          retryable: false,
        };
        if (isTransientPollError(error)) {
          lastProblem = error.message;
          retry();
        } else {
          done = true;
          setSettled({ runId, results: null, error });
        }
        return;
      }
      if (content.state === "running") {
        lastProblem = "the run was still writing them";
        retry(content.retry_after_seconds);
        return;
      }
      shown = runResultsViewOf(content, meta);
      setSettled({ runId, results: shown, error: null });
      if (shown.linksPartial) {
        rereadForLinks();
        return;
      }
      done = true;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(timer);
      } else if (!done) {
        // Back from a hidden tab: fetch once immediately rather than waiting
        // out a stale delay.
        clearTimeout(timer);
        void fetchOnce();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Honor the pause-while-hidden contract from the very first fetch: if the
    // tab is hidden, the visibilitychange listener fires it on return.
    if (document.visibilityState !== "hidden") {
      void fetchOnce();
    }
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [runId, terminal]);

  if (!runId || settled?.runId !== runId) {
    return NOTHING;
  }
  return { results: settled.results, error: settled.error };
}
