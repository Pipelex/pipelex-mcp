import "@/index.css";

import { useEffect, useMemo, useRef } from "react";
import { useDisplayMode, useLayout, useSendFollowUpMessage, useViewState } from "skybridge/web";

import { failureDisplayOf } from "@pipelex/mcp-core/capabilities/run-failure.js";
import type { RunFailureDisplay } from "@pipelex/mcp-core/capabilities/run-failure.js";

import { useCallTool, useToolInfo } from "../helpers.js";
import { FailureDetails } from "./components/failure-details.js";
import { RenderBoundary } from "./components/render-boundary.js";
import { RunResultsPanel } from "./components/run-results-panel.js";
import { terminalFollowUpPrompt } from "./run-notify.js";
import { runDurationSeconds } from "./run-results.js";
import { useElapsedSeconds, useRunPolling } from "./use-run-polling.js";
import { useRunResults } from "./use-run-results.js";

/**
 * Friendly labels for the hosted run statuses. `COMPLETED` maps to
 * "Finalizing" because the card only shows it during the brief window between
 * the terminal status read and the results fetch.
 */
const STATUS_LABELS: Record<string, string> = {
  PENDING: "Queued",
  STARTED: "Starting",
  RUNNING: "Running",
  COMPLETED: "Finalizing",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  TERMINATED: "Terminated",
  TIMED_OUT: "Timed out",
};

/**
 * Reassuring, cause-specific note for a non-fatal poll state: both mean the
 * run is still executing server-side and the card is still following it.
 */
const HEALTH_NOTES = {
  reconnecting: "Reconnecting to the run tracker — your run is still going.",
  retrying: "Network hiccup — retrying. Your run is still going.",
} as const;

/**
 * Host-persisted view state: the status mirror the assistant reads to answer
 * "is it done?", plus the once-per-run completion-handoff guard — `notified`
 * must survive remounts, or reopening the conversation would re-fire the
 * follow-up turn.
 */
type RunFollowViewState = {
  run_id?: string;
  last_known?: string;
  notified?: boolean;
};

/**
 * The run-follow Skybridge view, registered on `pipelex_run`. It follows a
 * durable run on its own — polling the read-only `pipelex_run_status` through
 * `useCallTool` (no model turns, no conversation noise), then fetching
 * `pipelex_run_results` once the run is terminal and showing it in the results
 * panel the form view shares: the output rendered by the form kernel, and the
 * executed graph in fullscreen, on success; on a failed run, why it failed,
 * what to do next and a line to copy for support, from the run's stored error
 * report, and never the report's message or the provider's raw text. On resolving the terminal outcome it hands the conversation back to the
 * model once (the completion handoff — see the notify effect), since here the
 * model started the run and is expected to report on it. On remount it
 * re-resolves by id — one status poll; if terminal, one results fetch — so the
 * card is as resumable as the run itself.
 */
export default function RunFollowView() {
  return (
    <RenderBoundary what="This view">
      <RunFollow />
    </RenderBoundary>
  );
}

function RunFollow() {
  // Hooks run unconditionally before any early return.
  const toolInfo = useToolInfo<"pipelex_run">();
  const { callToolAsync: statusAsync } = useCallTool("pipelex_run_status");
  const { callToolAsync: resultsAsync } = useCallTool("pipelex_run_results");
  const { theme, maxHeight, safeArea } = useLayout();
  const [displayMode, setDisplayMode] = useDisplayMode();
  const [viewState, setViewState] = useViewState<RunFollowViewState>({});
  const sendFollowUpMessage = useSendFollowUpMessage();

  const output = toolInfo.isSuccess ? toolInfo.output : undefined;
  const runId = output?.status === "ok" ? output.run_id : undefined;

  // Elapsed counts from the server-side start when the ack carries one, so a
  // reopened conversation shows the run's true age, not the remount's.
  const startedAtMs = useMemo(() => {
    const created = output?.created_at ? Date.parse(output.created_at) : Number.NaN;
    return Number.isNaN(created) ? Date.now() : created;
  }, [runId, output?.created_at]);

  const polling = useRunPolling(runId, statusAsync);

  const { results, error: resultsError } = useRunResults(
    runId,
    polling.phase === "terminal",
    resultsAsync,
  );

  const elapsedSeconds = useElapsedSeconds(
    startedAtMs,
    polling.phase === "polling" || (polling.phase === "terminal" && results === null),
  );

  // Mirror the last-known snapshot into host-persisted view state so the
  // assistant can answer "is it done?" from what the user is looking at. A
  // functional update so the mirror never clobbers the `notified` flag.
  const mirroredStatus = results?.content.state ?? polling.runStatus ?? "starting";
  useEffect(() => {
    if (!runId) {
      return;
    }
    void setViewState((prev) => ({ ...prev, run_id: runId, last_known: mirroredStatus }));
  }, [runId, mirroredStatus, setViewState]);

  // §6.6 (revised) — completion handoff. Once the terminal outcome is resolved
  // (the results fetch settled on completed or failed), hand the conversation
  // back to the model so it reports without the user prompting. At most one
  // handoff per run: `notified` rides host-persisted view state so a remount
  // of an already-notified run stays silent, and the ref guards this mount
  // while the view-state write round-trips. Best-effort: a host that declines
  // the view-initiated turn gets no in-session retry (the ref stays set — a
  // reject-rollback loop otherwise), but the persisted flag rolls back so a
  // later remount may try once more; the manual "Summarize in chat" button
  // remains the fallback. Hard poll errors and results-fetch errors never
  // auto-fire — they are follow failures, not run outcomes.
  const notifyAttemptedRef = useRef(false);
  useEffect(() => {
    if (!runId || !results || notifyAttemptedRef.current || viewState.notified === true) {
      return;
    }
    notifyAttemptedRef.current = true;
    void setViewState((prev) => ({ ...prev, notified: true }));
    const outcome = results.content.state === "failed" ? "failed" : "completed";
    void sendFollowUpMessage(terminalFollowUpPrompt(runId, outcome)).catch(() => {
      void setViewState((prev) => ({ ...prev, notified: false }));
    });
  }, [runId, results, viewState.notified, sendFollowUpMessage, setViewState]);

  if (!toolInfo.isSuccess) {
    return <Card note="Starting run…" maxHeight={maxHeight} dark={theme === "dark"} spinner />;
  }
  const dark = theme === "dark";

  if (!runId) {
    const startError = output?.errors?.[0];
    return (
      <Card
        title="Run did not start"
        note={startError?.message ?? "The run could not be started."}
        hint={startError?.hint}
        tone="error"
        maxHeight={maxHeight}
        dark={dark}
        llm="The run did not start; the tool result carries the error details."
      />
    );
  }

  if (polling.phase === "hard_error" && polling.hardError) {
    return (
      <Card
        title="Lost track of the run"
        note={polling.hardError.message}
        hint={polling.hardError.hint}
        tone="error"
        maxHeight={maxHeight}
        dark={dark}
        llm={`Run ${runId}: status polling stopped on an error (${polling.hardError.class}).`}
      />
    );
  }

  // A run that ended without completing says why from its status read even
  // when its results cannot be fetched: the results would add nothing to it.
  const endedWithoutCompleting =
    polling.phase === "terminal" &&
    polling.runStatus !== undefined &&
    polling.runStatus !== "COMPLETED";

  if (resultsError) {
    return (
      <Card
        title={
          endedWithoutCompleting
            ? `Run ${STATUS_LABELS[polling.runStatus ?? ""]?.toLowerCase() ?? "failed"}`
            : "Could not fetch the results"
        }
        note={resultsError.message}
        hint={resultsError.hint}
        tone="error"
        maxHeight={maxHeight}
        dark={dark}
        failure={
          endedWithoutCompleting
            ? failureDisplayOf(runId, polling.failure, polling.finishedAt)
            : undefined
        }
        llm={`Run ${runId}: terminal (${polling.runStatus ?? "unknown status"}), but the results fetch failed (${resultsError.class}).`}
      />
    );
  }

  if (results) {
    const isFullscreen = displayMode === "fullscreen";
    const { top, right, bottom, left } = safeArea.insets;
    // ReactFlow needs an explicit pixel height; the graph shows in fullscreen
    // only, under the output, and the whole card scrolls there.
    const available = (maxHeight ?? 600) - top - bottom;
    return (
      <div
        className="relative w-full overflow-y-auto"
        style={{
          paddingTop: top,
          paddingRight: right,
          paddingBottom: bottom,
          paddingLeft: left,
          maxHeight: isFullscreen ? available : undefined,
        }}
      >
        <RunResultsPanel
          runId={runId}
          results={results}
          requestedPipeRef={toolInfo.input?.pipe_ref ?? null}
          durationSeconds={runDurationSeconds(polling.createdAt, polling.finishedAt)}
          finishedAt={polling.finishedAt}
          dark={dark}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() => void setDisplayMode(isFullscreen ? "inline" : "fullscreen")}
          showFullscreenAction={true}
          showGraph={true}
          graphHeight={Math.max(Math.floor(available * 0.7), 320)}
        />
      </div>
    );
  }

  // Live (or finalizing) status card.
  const label = polling.runStatus ? (STATUS_LABELS[polling.runStatus] ?? "Running") : "Starting";
  return (
    <Card
      title={`${label}… ${elapsedSeconds}s`}
      note={polling.health ? HEALTH_NOTES[polling.health] : undefined}
      maxHeight={maxHeight}
      dark={dark}
      spinner
      llm={`Run ${runId}: ${polling.runStatus ?? "starting"}, ${elapsedSeconds}s elapsed. The card follows it live.`}
    />
  );
}

/** Shared compact card for live, error, and failure states. */
function Card({
  title,
  note,
  hint,
  tone = "info",
  spinner = false,
  maxHeight,
  dark,
  failure,
  llm,
}: {
  title?: string;
  note?: string;
  hint?: string;
  tone?: "info" | "error";
  spinner?: boolean;
  maxHeight: number | undefined;
  dark: boolean;
  /** Why the run failed, shown above the note when the run ended without completing. */
  failure?: RunFailureDisplay;
  llm?: string;
}) {
  const palette =
    tone === "error"
      ? {
          border: dark ? "#7f1d1d" : "#fecaca",
          background: dark ? "rgba(127,29,29,0.15)" : "#fef2f2",
          color: dark ? "#fca5a5" : "#991b1b",
        }
      : {
          border: dark ? "#1e3a5f" : "#bfdbfe",
          background: dark ? "rgba(30,58,138,0.15)" : "#eff6ff",
          color: dark ? "#93c5fd" : "#1e3a8a",
        };
  return (
    <div
      role="status"
      aria-live="polite"
      data-llm={llm}
      className="m-2 flex items-center gap-3 rounded-lg border p-4 text-sm"
      style={{
        borderColor: palette.border,
        background: palette.background,
        color: palette.color,
        maxHeight: failure ? undefined : Math.min(maxHeight ?? 160, 160),
      }}
    >
      {spinner && (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2"
          style={{ borderColor: palette.border, borderTopColor: palette.color }}
        />
      )}
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {failure && (
          <FailureDetails
            failure={failure}
            color={palette.color}
            mutedColor={palette.color}
            dark={dark}
          />
        )}
        {note && <p className="text-xs opacity-90">{note}</p>}
        {hint && <p className="text-xs opacity-75">{hint}</p>}
      </div>
    </div>
  );
}
