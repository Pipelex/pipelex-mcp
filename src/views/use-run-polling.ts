import { useEffect, useRef, useState } from "react";

import type { RunStatusStructuredContent } from "../capabilities/run.js";
import type { ToolError } from "../capabilities/shared.js";
import { isTransientPollError, nextPollDelayMs } from "./run-polling.js";

/**
 * Where the follow loop stands. `idle` — no run to follow; `polling` — the
 * run is live and status reads are scheduled; `terminal` — the run reached a
 * terminal status (the view fetches results next); `hard_error` — a poll hit
 * an unrecoverable error (auth, unknown id) and polling stopped.
 */
export type RunPollingPhase = "idle" | "polling" | "terminal" | "hard_error";

/**
 * Why the loop is in a resilient state, for a non-alarming card note:
 * `reconnecting` — the platform served a last-known (degraded) status;
 * `retrying` — a poll tick failed transiently. `null` — polling cleanly.
 */
export type RunPollingHealth = "reconnecting" | "retrying" | null;

export interface RunPollingSnapshot {
  phase: RunPollingPhase;
  /** Last-known coarse run status (e.g. `RUNNING`), once a read succeeded. */
  runStatus: RunStatusStructuredContent["run_status"];
  health: RunPollingHealth;
  /** The classified error that stopped polling, when phase is `hard_error`. */
  hardError: ToolError | null;
}

/** The slice of `useCallTool("mthds_run_status")` the poll loop consumes. */
export type StatusFetcher = (args: {
  run_id: string;
}) => Promise<{ structuredContent: RunStatusStructuredContent }>;

/**
 * Self-polling loop over `mthds_run_status` for one durable run: no model
 * turns, no conversation noise. Cadence and the transient-vs-hard error split
 * live in `run-polling.ts` (pure, unit-tested); this hook owns the timers.
 * Pauses while the tab is hidden (one immediate read on return), stops on a
 * terminal status or a hard error.
 */
export function useRunPolling(
  runId: string | undefined,
  fetchStatus: StatusFetcher,
): RunPollingSnapshot {
  const [snapshot, setSnapshot] = useState<RunPollingSnapshot>({
    phase: runId ? "polling" : "idle",
    runStatus: undefined,
    health: null,
    hardError: null,
  });

  // The fetcher from useCallTool changes identity per render; pin the latest
  // so the poll effect depends on runId only and never cancels itself.
  const fetchRef = useRef(fetchStatus);
  fetchRef.current = fetchStatus;

  useEffect(() => {
    if (!runId) {
      return;
    }
    const startedAt = Date.now();
    let cancelled = false;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (retryAfterSeconds?: number | null) => {
      if (cancelled || stopped || document.visibilityState === "hidden") {
        return;
      }
      timer = setTimeout(
        () => void tick(),
        nextPollDelayMs(Date.now() - startedAt, retryAfterSeconds),
      );
    };

    // At most one status read in flight: a hidden→visible flip during a fetch
    // must not start a concurrent tick (each would schedule its own follow-up,
    // orphaning the other's timer).
    let inFlight = false;

    const tick = async () => {
      if (cancelled || stopped || inFlight) {
        return;
      }
      inFlight = true;
      let content: RunStatusStructuredContent;
      try {
        content = (await fetchRef.current({ run_id: runId })).structuredContent;
      } catch {
        // A transport failure between the view and the MCP server — the run
        // itself is unaffected; keep polling.
        inFlight = false;
        if (!cancelled) {
          setSnapshot((prev) => ({ ...prev, health: "retrying" }));
          schedule();
        }
        return;
      }
      inFlight = false;
      if (cancelled) {
        return;
      }

      if (content.status === "error") {
        const error = content.errors?.[0] ?? {
          class: "runtime" as const,
          message: "mthds_run_status produced no verdict.",
          retryable: false,
        };
        if (isTransientPollError(error)) {
          setSnapshot((prev) => ({ ...prev, health: "retrying" }));
          schedule();
        } else {
          stopped = true;
          setSnapshot((prev) => ({ ...prev, phase: "hard_error", health: null, hardError: error }));
        }
        return;
      }

      const terminal = content.is_terminal === true;
      if (terminal) {
        stopped = true;
      }
      setSnapshot({
        phase: terminal ? "terminal" : "polling",
        runStatus: content.run_status,
        health: terminal ? null : content.degraded ? "reconnecting" : null,
        hardError: null,
      });
      if (!terminal) {
        schedule(content.retry_after_seconds);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearTimeout(timer);
      } else if (!stopped) {
        // Back from a hidden tab: read once immediately rather than waiting
        // out a stale delay.
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    setSnapshot({ phase: "polling", runStatus: undefined, health: null, hardError: null });
    // Honor the pause-while-hidden contract from the very first read: if the
    // view mounts in a hidden tab, the visibilitychange listener fires the
    // immediate read on return instead.
    if (document.visibilityState !== "hidden") {
      void tick();
    }

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [runId]);

  return snapshot;
}

/**
 * Wall-clock seconds since `since`, ticking once per second while `active`.
 * Freezes at its last value when `active` flips false (terminal state).
 */
export function useElapsedSeconds(since: number | undefined, active: boolean): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (since === undefined || !active) {
      return;
    }
    const update = () => setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
    update();
    const interval = setInterval(update, 1_000);
    return () => clearInterval(interval);
  }, [since, active]);

  return elapsed;
}
