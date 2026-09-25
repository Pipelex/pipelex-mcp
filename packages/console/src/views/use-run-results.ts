import { useEffect, useRef, useState } from "react";

import type { RunResultsStructuredContent } from "@pipelex/mcp-core/capabilities/run.js";
import type { ToolError } from "@pipelex/mcp-core/capabilities/shared.js";
import { isTransientPollError, nextPollDelayMs } from "./run-polling.js";
import { runResultsViewOf } from "./run-results.js";
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
    const retry = (retryAfterSeconds?: number | null) => {
      if (cancelled || done || document.visibilityState === "hidden") {
        return;
      }
      timer = setTimeout(
        () => void fetchOnce(),
        nextPollDelayMs(Date.now() - firstAttemptAt, retryAfterSeconds),
      );
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
      let content: RunResultsStructuredContent;
      let meta: Record<string, unknown> | undefined;
      try {
        const response = await fetchRef.current({ run_id: runId });
        content = response.structuredContent;
        meta = response.meta;
      } catch {
        inFlight = false;
        retry();
        return;
      }
      inFlight = false;
      if (cancelled) {
        return;
      }
      if (content.status === "error") {
        const error = content.errors?.[0] ?? {
          class: "runtime" as const,
          message: "pipelex_run_results produced no verdict.",
          retryable: false,
        };
        if (isTransientPollError(error)) {
          retry();
        } else {
          done = true;
          setSettled({ runId, results: null, error });
        }
        return;
      }
      if (content.state === "running") {
        retry(content.retry_after_seconds);
        return;
      }
      done = true;
      setSettled({ runId, results: runResultsViewOf(content, meta), error: null });
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
