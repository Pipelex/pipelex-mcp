import type { ToolError } from "../capabilities/shared.js";

/**
 * The cadence/backoff decision core of the run-follow view's status polling,
 * kept pure so it is unit-testable in the Node Vitest environment. The
 * `useRunPolling` hook owns the timers; this module owns the decisions.
 */

/** First poll fires quickly so a fast run feels live. */
export const INITIAL_POLL_DELAY_MS = 2_000;

/** Ceiling of the elapsed-time backoff ladder. */
export const MAX_POLL_DELAY_MS = 10_000;

/** Bounds applied to a server-sent `retry_after_seconds` hint. */
const MIN_SERVER_HINT_MS = 1_000;
const MAX_SERVER_HINT_MS = 30_000;

/**
 * Gentle backoff as the run gets older: fast at first (a short run should
 * feel live), sparser once the run has clearly settled into a long execution.
 */
const BACKOFF_LADDER: Array<{ upToElapsedMs: number; delayMs: number }> = [
  { upToElapsedMs: 30_000, delayMs: INITIAL_POLL_DELAY_MS },
  { upToElapsedMs: 120_000, delayMs: 4_000 },
  { upToElapsedMs: 300_000, delayMs: 7_000 },
];

/**
 * Delay until the next status poll. A server-sent `retry_after_seconds` hint
 * always wins (clamped to sane bounds); otherwise the delay grows with the
 * elapsed wall-clock since the run started, capped at
 * {@link MAX_POLL_DELAY_MS}.
 */
export function nextPollDelayMs(elapsedMs: number, retryAfterSeconds?: number | null): number {
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)) {
    return Math.min(Math.max(retryAfterSeconds * 1_000, MIN_SERVER_HINT_MS), MAX_SERVER_HINT_MS);
  }

  for (const rung of BACKOFF_LADDER) {
    if (elapsedMs < rung.upToElapsedMs) {
      return rung.delayMs;
    }
  }
  return MAX_POLL_DELAY_MS;
}

/**
 * Split a no-verdict `ToolError` from `mthds_run_status` into transient
 * (keep polling — the run is still executing server-side) vs hard (stop and
 * show the classified message), mirroring the starter's
 * `isTransientPollError`:
 *
 * - `runtime` (5xx, unknown faults) → transient.
 * - `config` on `PIPELEX_BASE_URL` (API unreachable) → transient: a network
 *   blip between the MCP server and the API does not affect the run itself.
 * - `config` on `PIPELEX_API_KEY` (auth) and `input_domain` (unknown or
 *   malformed run id) → hard: retrying cannot fix these.
 */
export function isTransientPollError(error: ToolError): boolean {
  if (error.class === "runtime") {
    return true;
  }
  return error.class === "config" && error.location === "PIPELEX_BASE_URL";
}
