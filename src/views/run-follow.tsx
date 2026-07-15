import "@/index.css";

import { GraphViewer } from "@pipelex/mthds-ui/graph/react";
import { TOOLBAR_POSITION } from "@pipelex/mthds-ui";
import type { GraphSpec, ToolbarPosition } from "@pipelex/mthds-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDisplayMode, useLayout, useSendFollowUpMessage, useViewState } from "skybridge/web";

import type { RunResultsStructuredContent } from "../capabilities/run.js";
import type { ToolError } from "../capabilities/shared.js";
import { useCallTool, useToolInfo } from "../helpers.js";
import { isTransientPollError, nextPollDelayMs } from "./run-polling.js";
import { ToolbarButton } from "./toolbar-button.js";
import { useElapsedSeconds, useRunPolling } from "./use-run-polling.js";

const TOOLBAR_POSITION_FOR_VIEW: ToolbarPosition = TOOLBAR_POSITION.TOP_LEFT;

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

interface RunResultsView {
  content: RunResultsStructuredContent;
  graphSpec: GraphSpec | null;
  mainStuff: unknown;
}

/**
 * The run-follow Skybridge view, registered on `mthds_run`. It follows a
 * durable run on its own — polling the read-only `mthds_run_status` through
 * `useCallTool` (no model turns, no conversation noise), then fetching
 * `mthds_run_results` once the run is terminal: the executed graph (from the
 * response's view-only `meta.graph_spec`) plus a compact output preview on
 * success, the failure message on a failed run. On remount it re-resolves by
 * id — one status poll; if terminal, one results fetch — so the card is as
 * resumable as the run itself.
 */
export default function RunFollowView() {
  // Hooks run unconditionally before any early return.
  const toolInfo = useToolInfo<"mthds_run">();
  const { callToolAsync: statusAsync } = useCallTool("mthds_run_status");
  const { callToolAsync: resultsAsync } = useCallTool("mthds_run_results");
  const { theme, maxHeight, safeArea } = useLayout();
  const [displayMode, setDisplayMode] = useDisplayMode();
  const [, setViewState] = useViewState({});

  const output = toolInfo.isSuccess ? toolInfo.output : undefined;
  const runId = output?.status === "ok" ? output.run_id : undefined;

  // Elapsed counts from the server-side start when the ack carries one, so a
  // reopened conversation shows the run's true age, not the remount's.
  const startedAtMs = useMemo(() => {
    const created = output?.created_at ? Date.parse(output.created_at) : Number.NaN;
    return Number.isNaN(created) ? Date.now() : created;
  }, [runId, output?.created_at]);

  const polling = useRunPolling(runId, statusAsync);

  const [results, setResults] = useState<RunResultsView | null>(null);
  const [resultsError, setResultsError] = useState<ToolError | null>(null);
  const resultsRef = useRef(resultsAsync);
  resultsRef.current = resultsAsync;

  // One results fetch once the run is terminal. A `state: "running"` answer is
  // the mid-write race (status flipped terminal before the artifacts were
  // written) — retry on the server's hint; transient errors likewise. Retries
  // age along the same elapsed-time ladder as status polls (measured from the
  // first attempt), so a persistent race or hiccup backs off instead of
  // hammering the endpoint at the ladder's first rung forever.
  useEffect(() => {
    if (!runId || polling.phase !== "terminal") {
      return;
    }
    const firstAttemptAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = (retryAfterSeconds?: number | null) => {
      if (!cancelled) {
        timer = setTimeout(
          () => void fetchResults(),
          nextPollDelayMs(Date.now() - firstAttemptAt, retryAfterSeconds),
        );
      }
    };
    const fetchResults = async () => {
      let content: RunResultsStructuredContent;
      let meta: Record<string, unknown> | undefined;
      try {
        const res = await resultsRef.current({ run_id: runId });
        content = res.structuredContent;
        meta = res.meta;
      } catch {
        retry();
        return;
      }
      if (cancelled) {
        return;
      }
      if (content.status === "error") {
        const error = content.errors?.[0] ?? {
          class: "runtime" as const,
          message: "mthds_run_results produced no verdict.",
        };
        if (isTransientPollError(error)) {
          retry();
        } else {
          setResultsError(error);
        }
        return;
      }
      if (content.state === "running") {
        retry(content.retry_after_seconds);
        return;
      }
      setResults({
        content,
        graphSpec: (meta?.graph_spec ?? null) as GraphSpec | null,
        mainStuff: meta?.main_stuff,
      });
    };
    void fetchResults();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, polling.phase]);

  const elapsedSeconds = useElapsedSeconds(
    startedAtMs,
    polling.phase === "polling" || (polling.phase === "terminal" && results === null),
  );

  // Mirror the last-known snapshot into host-persisted view state so the
  // assistant can answer "is it done?" from what the user is looking at.
  const mirroredStatus = results?.content.state ?? polling.runStatus ?? "starting";
  useEffect(() => {
    if (!runId) {
      return;
    }
    void setViewState({ run_id: runId, last_known: mirroredStatus });
  }, [runId, mirroredStatus, setViewState]);

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

  if (resultsError) {
    return (
      <Card
        title="Could not fetch the results"
        note={resultsError.message}
        hint={resultsError.hint}
        tone="error"
        maxHeight={maxHeight}
        dark={dark}
        llm={`Run ${runId}: terminal, but the results fetch failed (${resultsError.class}).`}
      />
    );
  }

  if (results) {
    if (results.content.state === "failed") {
      const status = results.content.run_status ?? "FAILED";
      return (
        <Card
          title={`Run ${STATUS_LABELS[status] ?? status}`}
          note={results.content.failure_message ?? "The run did not complete."}
          hint="No graph is available for failed runs."
          tone="error"
          maxHeight={maxHeight}
          dark={dark}
          llm={`Run ${runId}: ${status} — ${results.content.failure_message ?? "no failure message"}.`}
        />
      );
    }
    return (
      <CompletedCard
        runId={runId}
        results={results}
        dark={dark}
        maxHeight={maxHeight}
        insets={safeArea.insets}
        isFullscreen={displayMode === "fullscreen"}
        onToggleFullscreen={() =>
          void setDisplayMode(displayMode === "fullscreen" ? "inline" : "fullscreen")
        }
      />
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
  llm,
}: {
  title?: string;
  note?: string;
  hint?: string;
  tone?: "info" | "error";
  spinner?: boolean;
  maxHeight: number | undefined;
  dark: boolean;
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
        maxHeight: Math.min(maxHeight ?? 160, 160),
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
        {note && <p className="text-xs opacity-90">{note}</p>}
        {hint && <p className="text-xs opacity-75">{hint}</p>}
      </div>
    </div>
  );
}

/** Terminal success: the executed graph plus a compact output preview. */
function CompletedCard({
  runId,
  results,
  dark,
  maxHeight,
  insets,
  isFullscreen,
  onToggleFullscreen,
}: {
  runId: string;
  results: RunResultsView;
  dark: boolean;
  maxHeight: number | undefined;
  insets: { top: number; right: number; bottom: number; left: number };
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const { top, right, bottom, left } = insets;
  // §6.6 — user-triggered handoff back to the conversation. Opt-in only:
  // auto-firing on completion would create unsolicited model turns.
  const sendFollowUpMessage = useSendFollowUpMessage();
  const [summarizeRequested, setSummarizeRequested] = useState(false);
  const hasGraph = results.graphSpec != null && (results.graphSpec.nodes?.length ?? 0) > 0;
  // Same sizing discipline as run-graph: explicit pixel height for ReactFlow,
  // compact inline, filling the host in fullscreen, floored against collapse.
  const available = (maxHeight ?? 600) - top - bottom;
  const graphHeight = Math.max(isFullscreen ? available - 220 : Math.min(available, 320), 200);

  const imageUrl = narrowImageUrl(results.mainStuff);
  const preview = results.content.main_stuff;

  return (
    <div
      data-llm={`Run ${runId}: COMPLETED — output shown${hasGraph ? " with the executed graph" : ""}.`}
      className="relative w-full overflow-hidden"
      style={{ paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left }}
    >
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        <ToolbarButton
          dark={dark}
          disabled={summarizeRequested}
          onClick={() => {
            setSummarizeRequested(true);
            void sendFollowUpMessage("The run completed — report the results.").catch(() =>
              setSummarizeRequested(false),
            );
          }}
        >
          {summarizeRequested ? "Asked in chat" : "Summarize in chat"}
        </ToolbarButton>
        <ToolbarButton dark={dark} onClick={onToggleFullscreen}>
          {isFullscreen ? "Collapse" : "Fullscreen"}
        </ToolbarButton>
      </div>
      <p
        className="px-2 pb-1 pt-2 text-sm font-medium"
        style={{ color: dark ? "#e5e7eb" : "#111827" }}
      >
        Run completed
      </p>
      {hasGraph && (
        <div className="relative w-full overflow-hidden" style={{ height: graphHeight }}>
          <GraphViewer
            graphspec={results.graphSpec as GraphSpec}
            initialDirection="LR"
            initialShowControllers={true}
            theme={dark ? "dark" : "light"}
            showThemeToggle={false}
            toolbarPosition={TOOLBAR_POSITION_FOR_VIEW}
          />
        </div>
      )}
      <div className="px-2 pb-2">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Run output"
            className="mt-1 rounded-md"
            style={{ maxWidth: "100%", maxHeight: isFullscreen ? 480 : 220 }}
          />
        ) : (
          <pre
            className="mt-1 overflow-auto rounded-md p-2 text-xs"
            style={{
              maxHeight: isFullscreen ? 320 : 160,
              background: dark ? "rgba(31,41,55,0.6)" : "#f3f4f6",
              color: dark ? "#e5e7eb" : "#111827",
            }}
          >
            {formatPreview(preview)}
          </pre>
        )}
        {results.content.truncated === true && (
          <p className="mt-1 text-xs" style={{ color: "#6b7280" }}>
            Preview truncated — ask the assistant for the parts you need.
          </p>
        )}
      </div>
    </div>
  );
}

function formatPreview(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? String(value);
}

const IMAGE_URL_PATTERN = /^https?:\/\/\S+\.(png|jpe?g|gif|webp|svg)(\?\S*)?$/i;

/**
 * Narrow a polymorphic main output to a single displayable image URL: the
 * value itself, or a `url` / `public_url` field on an object that either
 * looks image-shaped or is accompanied by an `image/*` mime hint.
 */
function narrowImageUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return IMAGE_URL_PATTERN.test(value) ? value : null;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const candidate = [record.public_url, record.url].find(
      (entry): entry is string => typeof entry === "string" && /^https?:\/\//.test(entry),
    );
    if (!candidate) {
      return null;
    }
    const mime = [record.mime_type, record.content_type, record.mime].find(
      (entry): entry is string => typeof entry === "string",
    );
    if (mime?.startsWith("image/") || IMAGE_URL_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
