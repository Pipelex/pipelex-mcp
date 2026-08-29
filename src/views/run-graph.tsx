import "@/index.css";
import "@pipelex/mthds-ui/form/react/RunPanel.css";

import { getPipeInputForm, getPipeIOContract } from "@pipelex/mthds-form";
import type { InputForm, PipeIOContracts } from "@pipelex/mthds-form";
import { RunPanel } from "@pipelex/mthds-ui/form/react";
import { GraphViewer } from "@pipelex/mthds-ui/graph/react";
import { TOOLBAR_POSITION } from "@pipelex/mthds-ui";
import type { GraphNodeData, GraphSpec, ToolbarPosition } from "@pipelex/mthds-ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDisplayMode, useLayout, useSendFollowUpMessage } from "skybridge/web";

import { useCallTool, useToolInfo } from "../helpers.js";
import { ToolbarButton } from "./components/toolbar-button.js";
import { terminalFollowUpPrompt } from "./run-notify.js";
import { useRunPolling } from "./use-run-polling.js";

/**
 * The graph toolbar's anchor is ours to control — mthds-ui defaults to
 * `top-right`, but this view owns the choice. Pinned to `top-left` for now.
 */
const TOOLBAR_POSITION_FOR_VIEW: ToolbarPosition = TOOLBAR_POSITION.TOP_LEFT;

/** A pipe picked for the form: the bare code `mthds_run` takes, plus its domain for the contract lookup. */
interface SelectedPipe {
  domain?: string;
  code: string;
}

/** `domain.code` → `{ domain, code }`. Pipe codes carry no dots, so the last one splits. */
function parsePipeRef(ref: string): SelectedPipe {
  const dot = ref.lastIndexOf(".");
  return dot === -1 ? { code: ref } : { domain: ref.slice(0, dot), code: ref.slice(dot + 1) };
}

/**
 * The run-graph Skybridge view. A view is a tool with a UI, so this renders a
 * method's run graph (delivered view-only on `_meta`, read here as
 * `responseMetadata.graph_spec`) with mthds-ui's `GraphViewer`, the same
 * component `pipelex-app` ships. It is the generic renderer for any run graph:
 * today `mthds_validate` feeds it the **dry-run graph** (the method structure
 * from the validation dry run); a future `mthds_run` can register the same
 * component to surface a **live-run graph** (with execution status). Invalid
 * verdicts, pending-signature verdicts with no graph, and `include_graph: false`
 * calls fall back to a compact, non-crashing empty state.
 *
 * On a runnable verdict it also renders the method's **input form** below the
 * graph — mthds-ui's `RunPanel` over the wire input-form descriptor riding
 * `responseMetadata.input_form` (the derivation, since kernel 0.5.0), with the
 * per-pipe IO contracts (`responseMetadata.pipe_io_contracts`) co-walked
 * beside it. The form defaults to the main pipe
 * (`responseMetadata.main_pipe_ref`); clicking a pipe node in the graph
 * switches it. Run starts the method through `mthds_run` with the same
 * `files` / `method_ref` / `method_id` the validation was called with, then follows the run
 * by polling `mthds_run_status` and hands the conversation back to the model
 * on the terminal outcome, exactly as `run-follow` does.
 */
export default function RunGraphView() {
  // Hooks run unconditionally before any early return.
  const toolInfo = useToolInfo<"mthds_validate">();
  const { callToolAsync: startRun } = useCallTool("mthds_run");
  const { callToolAsync: statusAsync } = useCallTool("mthds_run_status");
  const { theme, maxHeight, safeArea } = useLayout();
  const [displayMode, setDisplayMode] = useDisplayMode();
  const sendFollowUpMessage = useSendFollowUpMessage();

  const responseMetadata = toolInfo.isSuccess ? toolInfo.responseMetadata : undefined;
  // All three are opaque on the wire; the standard owns both per-pipe artifact
  // types (re-exported by `@pipelex/mthds-form`), and a malformed map degrades
  // to "no form" rather than throwing — the lookups below just miss.
  const contracts = (responseMetadata?.pipe_io_contracts ?? null) as PipeIOContracts | null;
  const inputForm = (responseMetadata?.input_form ?? null) as InputForm | null;
  const mainPipeRef =
    typeof responseMetadata?.main_pipe_ref === "string" ? responseMetadata.main_pipe_ref : null;

  const [pickedPipe, setPickedPipe] = useState<SelectedPipe | null>(null);
  const selectedPipe = useMemo<SelectedPipe | null>(() => {
    if (pickedPipe) return pickedPipe;
    if (mainPipeRef) return parsePipeRef(mainPipeRef);
    const firstRef = contracts ? Object.keys(contracts)[0] : undefined;
    return firstRef ? parsePipeRef(firstRef) : null;
  }, [pickedPipe, mainPipeRef, contracts]);
  // `RunPanel` treats `contract` as referentially significant (uploads in
  // flight are abandoned on a new reference), so look it up once per selection.
  const contract = useMemo(
    () =>
      selectedPipe
        ? getPipeIOContract(contracts, selectedPipe.domain, selectedPipe.code)
        : undefined,
    [contracts, selectedPipe],
  );
  // The descriptor selector — `getPipeIOContract`'s twin over the same
  // `pipe_ref` key set. Kept as the one lookup line so the wire descriptor has
  // a single point of entry into the view; `RunPanel` requires it (the kernel
  // derives the fields from it), so no descriptor for the pipe means no form.
  const descriptor = useMemo(
    () =>
      selectedPipe
        ? getPipeInputForm(inputForm, selectedPipe.domain, selectedPipe.code)
        : undefined,
    [inputForm, selectedPipe],
  );

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [startError, setStartError] = useState<string | null>(null);
  const polling = useRunPolling(runId, statusAsync);

  // Completion handoff: one follow-up per run, on the terminal status. Unlike
  // `run-follow` this view does not fetch results itself — the prompt tells
  // the model to, which lands the results (and their graph) as its own turn.
  const notifiedRunRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!runId || polling.phase !== "terminal" || notifiedRunRef.current === runId) {
      return;
    }
    notifiedRunRef.current = runId;
    const outcome = polling.runStatus === "COMPLETED" ? "completed" : "failed";
    void sendFollowUpMessage(terminalFollowUpPrompt(runId, outcome)).catch(() => {
      notifiedRunRef.current = undefined;
    });
  }, [runId, polling.phase, polling.runStatus, sendFollowUpMessage]);

  if (!toolInfo.isSuccess) {
    return <EmptyState message="Validating…" maxHeight={maxHeight} />;
  }

  const { output, input } = toolInfo;
  // `graph_spec` is opaque on the wire; mthds-ui owns `GraphSpec`. `GraphViewer`
  // re-validates it internally (`validateGraphSpec`), so a malformed or null
  // spec degrades to its own empty state rather than throwing.
  const graphSpec = (toolInfo.responseMetadata.graph_spec ?? null) as GraphSpec | null;

  if (output.status !== "ok" || !output.is_valid) {
    return <EmptyState message="Validation failed — no graph to display." maxHeight={maxHeight} />;
  }
  const hasGraph = Boolean(graphSpec && graphSpec.nodes?.length);
  // The form needs both artifacts: the descriptor drives the derivation, the
  // contract is co-walked beside it (and is what the run gate validates on).
  const hasForm = Boolean(contract && descriptor && selectedPipe);
  if (!hasGraph && !hasForm) {
    return <EmptyState message="No graph for this verdict." maxHeight={maxHeight} />;
  }

  const isFullscreen = displayMode === "fullscreen";
  const { top, right, bottom, left } = safeArea.insets;
  // ReactFlow needs an explicit pixel height. Fill the host when fullscreen;
  // keep a compact preview inline (no inline overflow scroll — fullscreen is
  // the sanctioned mode for exploring the graph). Floor it so a small host
  // height or large insets can't collapse the canvas to nothing. With a form
  // below, the fullscreen graph takes roughly half the host and the whole view
  // scrolls.
  const available = (maxHeight ?? 600) - top - bottom;
  const graphHeight = hasForm
    ? Math.max(isFullscreen ? Math.floor(available * 0.55) : 320, 240)
    : Math.max(isFullscreen ? available : Math.min(available, 420), 240);

  const dark = theme === "dark";
  const running = starting || (runId !== undefined && polling.phase === "polling");

  const handleNodeSelect = (_nodeId: string, nodeData: GraphNodeData) => {
    if (!nodeData.isPipe || !nodeData.pipeCode) return;
    const next: SelectedPipe = { domain: nodeData.nodeData?.domain_code, code: nodeData.pipeCode };
    if (next.code === selectedPipe?.code && next.domain === selectedPipe?.domain) return;
    setPickedPipe(next);
    setValues({});
  };

  const handleRun = (apiInputs: Record<string, unknown>) => {
    if (!selectedPipe) return;
    // Synchronously, before any await — the panel's duplicate-run guard.
    setStarting(true);
    setStartError(null);
    setRunId(undefined);
    void (async () => {
      try {
        // Forward the validation's own selector: a run started from the form
        // executes exactly what was validated — files, an address, or an id.
        const response = await startRun({
          ...(input?.files ? { files: input.files } : {}),
          ...(input?.method_ref ? { method_ref: input.method_ref } : {}),
          ...(input?.method_id ? { method_id: input.method_id } : {}),
          pipe_code: selectedPipe.code,
          inputs: apiInputs,
        });
        const ack = response.structuredContent;
        if (ack.status === "ok" && ack.run_id) {
          setRunId(ack.run_id);
        } else {
          setStartError(ack.errors?.[0]?.message ?? "The run could not be started.");
        }
      } catch (err) {
        setStartError(err instanceof Error ? err.message : "The run could not be started.");
      } finally {
        setStarting(false);
      }
    })();
  };

  const pipeLabel = selectedPipe
    ? selectedPipe.domain
      ? `${selectedPipe.domain}.${selectedPipe.code}`
      : selectedPipe.code
    : undefined;
  const llmSummary = [
    hasGraph ? `Showing the dry-run graph of the method: ${graphSpec?.nodes.length} nodes` : null,
    `runnable=${output.is_runnable}`,
    hasForm ? `input form shown for pipe ${pipeLabel}` : null,
    runId ? `run ${runId} ${polling.runStatus ?? "starting"}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      data-llm={llmSummary}
      className="relative w-full overflow-y-auto"
      style={{
        paddingTop: top,
        paddingRight: right,
        paddingBottom: bottom,
        paddingLeft: left,
        maxHeight: isFullscreen ? available : undefined,
      }}
    >
      <ToolbarButton
        dark={dark}
        onClick={() => void setDisplayMode(isFullscreen ? "inline" : "fullscreen")}
        className="absolute right-2 top-2 z-10"
      >
        {isFullscreen ? "Collapse" : "Fullscreen"}
      </ToolbarButton>
      {hasGraph && graphSpec ? (
        <div className="relative w-full overflow-hidden" style={{ height: graphHeight }}>
          <GraphViewer
            graphspec={graphSpec}
            initialDirection="LR"
            initialShowControllers={true}
            theme={theme}
            showThemeToggle={false}
            toolbarPosition={TOOLBAR_POSITION_FOR_VIEW}
            onNodeSelect={handleNodeSelect}
          />
        </div>
      ) : null}
      {contract && descriptor && selectedPipe ? (
        <div className="mt-3">
          <RunPanel
            key={pipeLabel}
            contract={contract}
            descriptor={descriptor}
            values={values}
            onValuesChange={setValues}
            onRun={handleRun}
            running={running}
            title={pipeLabel}
            theme={theme}
          />
          <RunStatusLine
            runId={runId}
            starting={starting}
            phase={polling.phase}
            runStatus={polling.runStatus}
            health={polling.health}
            hardError={polling.hardError?.message ?? null}
            startError={startError}
          />
        </div>
      ) : null}
    </div>
  );
}

/** One line under the form: what the run started from it is doing. */
function RunStatusLine({
  runId,
  starting,
  phase,
  runStatus,
  health,
  hardError,
  startError,
}: {
  runId: string | undefined;
  starting: boolean;
  phase: ReturnType<typeof useRunPolling>["phase"];
  runStatus: ReturnType<typeof useRunPolling>["runStatus"];
  health: ReturnType<typeof useRunPolling>["health"];
  hardError: string | null;
  startError: string | null;
}) {
  let text: string | null = null;
  if (startError) {
    text = `Could not start the run: ${startError}`;
  } else if (starting) {
    text = "Starting the run…";
  } else if (runId) {
    if (phase === "hard_error") {
      text = `Run ${runId}: lost track of it (${hardError ?? "status unavailable"}).`;
    } else if (phase === "terminal") {
      text =
        runStatus === "COMPLETED"
          ? `Run ${runId} completed — the assistant is fetching the results.`
          : `Run ${runId} ended with status ${runStatus ?? "unknown"}.`;
    } else {
      const suffix =
        health === "reconnecting"
          ? " (reconnecting…)"
          : health === "retrying"
            ? " (retrying…)"
            : "";
      text = `Run ${runId}: ${runStatus ?? "starting"}${suffix}`;
    }
  }
  if (!text) return null;
  return (
    <p className="mt-2 px-1 text-xs" style={{ color: startError ? "#b91c1c" : "#6b7280" }}>
      {text}
    </p>
  );
}

/** Compact, non-crashing fallback shown when there is no graph to render. */
function EmptyState({ message, maxHeight }: { message: string; maxHeight: number | undefined }) {
  return (
    <div
      className="flex w-full items-center justify-center px-4 text-center text-xs"
      style={{ height: Math.min(maxHeight ?? 160, 160), color: "#6b7280" }}
    >
      {message}
    </div>
  );
}
