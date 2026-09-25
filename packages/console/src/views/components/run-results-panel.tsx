// The kernel's result renderer, through `@pipelex/mthds-ui/form/react`, which
// re-exports it whole and imports its prebuilt stylesheet — never
// `@pipelex/mthds-form` directly, which would put a second copy of its React
// contexts in the tree (`FieldPresentationProvider` among them).
import {
  FieldPresentationProvider,
  JsonView,
  ResultEnvProvider,
  StuffViewer,
} from "@pipelex/mthds-ui/form/react";
import { GraphViewer } from "@pipelex/mthds-ui/graph/react";
import { TOOLBAR_POSITION } from "@pipelex/mthds-ui";
import type { GraphSpec, ToolbarPosition } from "@pipelex/mthds-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSendFollowUpMessage } from "skybridge/web";

import { CONSOLE_TOOL_NAMES } from "@pipelex/mcp-core/capabilities/tool-names.js";
import { terminalFollowUpPrompt } from "../run-notify.js";
import {
  completedHeadline,
  executedPipeRefOf,
  failedHeadline,
  hasExecutedGraph,
  outputFieldFor,
  outputToRender,
} from "../run-results.js";
import type { RunResultsView } from "../run-results.js";
import { ToolbarButton } from "./toolbar-button.js";

const TOOLBAR_POSITION_FOR_VIEW: ToolbarPosition = TOOLBAR_POSITION.TOP_LEFT;

/**
 * How tall the output may grow inline before it fades out. Skybridge's inline
 * guidance is no inner scrolling, so past this the output is cut with a fade
 * and fullscreen is the way to read the rest.
 */
const INLINE_OUTPUT_MAX_PX = 360;

const FADE_MASK = "linear-gradient(to bottom, black 72%, transparent)";

/**
 * A run's settled results, as both run views show them: a header line with the
 * duration and the cost, then the output, then — in fullscreen — the executed
 * graph. A failed run shows its failure in the same card, without a graph,
 * since the hosted plane produces none for a failed run.
 *
 * The output is the form kernel's `StuffViewer` in the `app` presentation, the
 * component every other Pipelex surface renders results with, over the field
 * derived from the executed pipe's output descriptor and its contract's payload
 * schema. It is fed the FULL output (`_meta.main_stuff`) rather than the bounded
 * copy the model reads, unless the full output is past the render budget
 * (`outputToRender`), when the bounded copy is shown as JSON and the panel says
 * so. When the result cannot describe its output — an older runner, or a pipe
 * the panel cannot identify — it is shown as JSON too, and the panel says why.
 * The kernel's Download control is hidden: it saves through an object URL and
 * a clicked link, falling back to a popup, and a host's sandboxed view frame
 * blocks all three.
 *
 * Everything shown here was fetched by the view and goes to the view alone:
 * none of it enters the model's context. The model gets one line through
 * `data-llm` and fetches the values itself when a question needs them.
 */
export function RunResultsPanel({
  runId,
  results,
  requestedPipeRef,
  durationSeconds,
  dark,
  isFullscreen,
  onToggleFullscreen,
  showFullscreenAction,
  showGraph,
  graphHeight,
}: {
  runId: string;
  results: RunResultsView;
  /** The pipe the run was started with, when the caller named one. */
  requestedPipeRef: string | null;
  durationSeconds: number | null;
  dark: boolean;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  /** Whether the panel carries its own Fullscreen action, which a view with a toggle of its own leaves out. */
  showFullscreenAction: boolean;
  /** Whether the panel draws the executed graph under the output in fullscreen, which a view drawing it elsewhere leaves out. */
  showGraph: boolean;
  graphHeight: number;
}) {
  const failed = results.content.state === "failed";
  const palette = dark
    ? { text: "#e5e7eb", muted: "#9ca3af", error: "#fca5a5" }
    : { text: "#111827", muted: "#6b7280", error: "#991b1b" };

  const headline = failed
    ? failedHeadline(results.content.run_status, durationSeconds)
    : completedHeadline(durationSeconds, results.content.usage);
  const llm = failed
    ? `Run ${runId}: ${headline.toLowerCase()} — ${results.content.failure_message ?? "no failure message"}.`
    : `Run ${runId}: ${headline.toLowerCase()}. Its output is shown to the user in this view; ${CONSOLE_TOOL_NAMES.runResults} with the run id returns it when a question needs the values.`;

  return (
    <section data-llm={llm} className="w-full space-y-2 px-2 pb-2 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium" style={{ color: failed ? palette.error : palette.text }}>
          <span aria-hidden="true">{failed ? "✕ " : "✓ "}</span>
          {headline}
        </p>
        <div className="flex gap-1">
          <SummarizeButton runId={runId} failed={failed} dark={dark} />
          {showFullscreenAction && (
            <ToolbarButton dark={dark} onClick={onToggleFullscreen}>
              {isFullscreen ? "Collapse" : "Fullscreen"}
            </ToolbarButton>
          )}
        </div>
      </div>
      {failed ? (
        <p className="text-xs" style={{ color: palette.error }}>
          {results.content.failure_message ?? "The run did not complete."}
        </p>
      ) : (
        <>
          <RunOutput
            results={results}
            requestedPipeRef={requestedPipeRef}
            dark={dark}
            bounded={!isFullscreen}
            onReadMore={onToggleFullscreen}
            mutedColor={palette.muted}
          />
          {isFullscreen && showGraph && hasExecutedGraph(results) && (
            <div className="pt-2">
              <p className="pb-1 text-xs font-medium" style={{ color: palette.muted }}>
                Execution graph
              </p>
              <div className="relative w-full overflow-hidden" style={{ height: graphHeight }}>
                <GraphViewer
                  graphspec={results.graphSpec as GraphSpec}
                  // Without these the panel takes the renderer's no-data floor:
                  // the concept's structure table and no data tab. `contracts`
                  // and `outputForm` are read together or not at all.
                  contracts={results.contracts ?? undefined}
                  outputForm={results.outputForm ?? undefined}
                  inputForm={results.inputForm ?? undefined}
                  resolveUrl={results.resolveUrl}
                  initialDirection="LR"
                  initialShowControllers={true}
                  theme={dark ? "dark" : "light"}
                  showThemeToggle={false}
                  toolbarPosition={TOOLBAR_POSITION_FOR_VIEW}
                />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The manual handoff to the assistant: the same run-id-bearing prompt the
 * automatic one sends, for a host that declined it, a view that sends none, or
 * a user who wants a second pass.
 */
function SummarizeButton({
  runId,
  failed,
  dark,
}: {
  runId: string;
  failed: boolean;
  dark: boolean;
}) {
  const sendFollowUpMessage = useSendFollowUpMessage();
  const [requested, setRequested] = useState(false);
  return (
    <ToolbarButton
      dark={dark}
      disabled={requested}
      onClick={() => {
        setRequested(true);
        void sendFollowUpMessage(
          terminalFollowUpPrompt(runId, failed ? "failed" : "completed"),
        ).catch(() => setRequested(false));
      }}
    >
      {requested ? "Asked in chat" : "Summarize in chat"}
    </ToolbarButton>
  );
}

/** The output, rendered by the kernel; cut with a fade past the inline bound. */
function RunOutput({
  results,
  requestedPipeRef,
  dark,
  bounded,
  onReadMore,
  mutedColor,
}: {
  results: RunResultsView;
  requestedPipeRef: string | null;
  dark: boolean;
  bounded: boolean;
  onReadMore: () => void;
  mutedColor: string;
}) {
  const pipeRef = executedPipeRefOf(results.graphSpec, requestedPipeRef);
  // One derivation per result: the kernel treats the field as the identity of
  // what it renders.
  const field = useMemo(
    () => outputFieldFor(results.contracts, results.outputForm, pipeRef),
    [results.contracts, results.outputForm, pipeRef],
  );
  // The full output rides `_meta`; the bounded copy stands in past the render
  // budget, and for a response that somehow carried none.
  const { value, oversizedLength } = useMemo(
    () => outputToRender(results.mainStuff, results.content.main_stuff),
    [results.mainStuff, results.content.main_stuff],
  );

  const contentRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  // Measured rather than assumed: images and previews load after the first
  // paint and grow the output, so the check follows the content's own size.
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setOverflowing(element.scrollHeight > INLINE_OUTPUT_MAX_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cut = bounded && overflowing;
  return (
    <div>
      <div
        style={
          bounded
            ? {
                maxHeight: INLINE_OUTPUT_MAX_PX,
                overflow: "hidden",
                ...(cut ? { maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK } : {}),
              }
            : undefined
        }
      >
        {/* `.dark` re-resolves the kernel's token bridge against the host
            theme's dark block, as `RunPanel` does for the form. */}
        <div
          ref={contentRef}
          className={["text-foreground", dark && "dark"].filter(Boolean).join(" ")}
        >
          <FieldPresentationProvider presentation="app">
            {/* Files paint from the fresh links the results carried, not the
                payload's baked `public_url`; see `resolveUrlFor`. */}
            <ResultEnvProvider resolveUrl={results.resolveUrl}>
              {field && oversizedLength === null ? (
                <StuffViewer field={field} value={value} hideDownload />
              ) : (
                <JsonView value={value} />
              )}
            </ResultEnvProvider>
          </FieldPresentationProvider>
        </div>
      </div>
      {cut && (
        <button
          type="button"
          onClick={onReadMore}
          className="mt-1 cursor-pointer text-xs underline"
          style={{ color: mutedColor }}
        >
          Open fullscreen to read the rest
        </button>
      )}
      {oversizedLength !== null ? (
        <p className="mt-1 text-xs" style={{ color: mutedColor }}>
          This output is about {Math.ceil(oversizedLength / 1024)} KiB, more than this view renders
          at once, so only its first part is shown, as JSON.
        </p>
      ) : (
        !field && (
          <p className="mt-1 text-xs" style={{ color: mutedColor }}>
            Shown as JSON: this result does not describe its output&apos;s structure.
          </p>
        )
      )}
    </div>
  );
}
