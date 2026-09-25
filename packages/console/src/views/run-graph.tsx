import "@/index.css";

// The form kernel is reached through `@pipelex/mthds-ui/form`, which re-exports it
// whole, and never as a direct dependency: since mthds-ui 0.20.0 the kernel is an
// ordinary dependency of it, so a second declaration here would put a second COPY
// in the tree. The kernel ships React contexts (`FieldStringsProvider`,
// `FieldPresentationProvider`), so two copies mean a provider mounted above the
// panel silently fails to resolve inside it — and mthds-ui pins `^0.8.0` while this
// repo had pinned `^0.5.0`, which a sub-1.0 caret cannot bridge.
import { getPipeInputForm, getPipeIOContract } from "@pipelex/mthds-ui/form";
import type { InputForm, PipeIOContracts } from "@pipelex/mthds-ui/form";
import { RunPanel } from "@pipelex/mthds-ui/form/react";
import { GraphViewer } from "@pipelex/mthds-ui/graph/react";
import { TOOLBAR_POSITION } from "@pipelex/mthds-ui";
import type { GraphNodeData, GraphSpec, ToolbarPosition } from "@pipelex/mthds-ui";
import { useCallback, useMemo, useRef, useState } from "react";
import { useDisplayMode, useLayout } from "skybridge/web";

import { useCallTool, useToolInfo } from "../helpers.js";
import { RunResultsPanel } from "./components/run-results-panel.js";
import { ToolbarButton } from "./components/toolbar-button.js";
import { graphCaptionFor, graphPipeRefOf, selectedPipeFor } from "./run-graph-selection.js";
import type { SelectedPipe } from "./run-graph-selection.js";
import { formViewStage, runStatusLineFor } from "./run-graph-stage.js";
import type { RunStatusLine } from "./run-graph-stage.js";
import {
  UploadFailure,
  clearChangedFields,
  uploadPickedFile,
  withoutField,
} from "./run-graph-upload.js";
import type { GrantRequest, GrantToolResponse, UploadErrors } from "./run-graph-upload.js";
import { hasExecutedGraph, runDurationSeconds } from "./run-results.js";
import { useRunPolling } from "./use-run-polling.js";
import { useRunResults } from "./use-run-results.js";

/**
 * The graph toolbar's anchor is ours to control — mthds-ui defaults to
 * `top-right`, but this view owns the choice. Pinned to `top-left` for now.
 */
const TOOLBAR_POSITION_FOR_VIEW: ToolbarPosition = TOOLBAR_POSITION.TOP_LEFT;

/**
 * The run-graph Skybridge view. A view is a tool with a UI, so this renders a
 * method's run graph (delivered view-only on `_meta`, read here as
 * `responseMetadata.graph_spec`) with mthds-ui's `GraphViewer`, the same
 * component `pipelex-app` ships. It is the generic renderer for any run graph:
 * today `pipelex_show_method` feeds it the **dry-run graph** (the method
 * structure from the validation dry run); a future run tool can register the
 * same component to surface a **live-run graph** (with execution status).
 * Invalid verdicts and pending-signature verdicts with no graph fall back to a
 * compact, non-crashing empty state.
 *
 * On a runnable verdict it also renders the method's **input form** below the
 * graph — mthds-ui's `RunPanel` over the wire input-form descriptor riding
 * `responseMetadata.input_form` (the derivation, since kernel 0.5.0), with the
 * per-pipe IO contracts (`responseMetadata.pipe_io_contracts`) co-walked
 * beside it. The form is for the pipe the show named, else the effective entry
 * pipe (`responseMetadata.form_pipe_ref`, then `main_pipe_ref`); clicking a
 * pipe node in the graph switches it. With no entry pipe settled no form opens on its own —
 * `selectedPipeFor` never substitutes a pipe of the view's own choosing — but
 * the artifacts still ride, so clicking a pipe node still produces its form.
 * The graph is the bundle's declared main pipe, which a `method_ref` package's
 * manifest can override as the entry pipe: when the two differ the graph stays
 * and a caption under it names both (`graphCaptionFor`), so the diagram is
 * never silently of a different pipe from the form below it.
 * A file-bearing input takes a file the user picks: the form asks the console
 * for an upload grant (`pipelex_request_upload`) and sends the file straight
 * to Pipelex storage, so the bytes never cross the conversation or the server
 * (`./run-graph-upload.ts`). A failed upload is said under the form, because
 * the panel itself discards the failure silently.
 * Run starts the method through `pipelex_run` with the same `method_ref` or
 * `method_id` the show was called with and the pipe the form is for, then
 * follows the run by polling `pipelex_run_status`, fetches `pipelex_run_results`
 * itself once the run is terminal, and shows them in the results panel it
 * shares with `run-follow`: the output rendered by the form kernel takes the
 * form's place, the dry-run graph gives way to the executed one, and the form
 * folds behind "Edit inputs and run again", which brings it back with the
 * values entered (`./run-graph-stage.ts` holds those transitions). A call the
 * view makes returns to the view alone and mounts no other view, which is why
 * it fetches and shows the results itself. It sends the model no completion
 * message: the user started this run and is reading its output, so an
 * automatic turn would be noise, and "Summarize in chat" is there for a user
 * who wants one.
 */
export default function RunGraphView() {
  // Hooks run unconditionally before any early return.
  const toolInfo = useToolInfo<"pipelex_show_method">();
  const { callToolAsync: startRun } = useCallTool("pipelex_run");
  const { callToolAsync: statusAsync } = useCallTool("pipelex_run_status");
  const { callToolAsync: resultsAsync } = useCallTool("pipelex_run_results");
  const { callToolAsync: requestUploadAsync } = useCallTool("pipelex_request_upload");
  const { theme, maxHeight, safeArea } = useLayout();
  const [displayMode, setDisplayMode] = useDisplayMode();

  const responseMetadata = toolInfo.isSuccess ? toolInfo.responseMetadata : undefined;
  // All three are opaque on the wire; the standard owns both per-pipe artifact
  // types (re-exported by `@pipelex/mthds-form`), and a malformed map degrades
  // to "no form" rather than throwing — the lookups below just miss.
  const contracts = (responseMetadata?.pipe_io_contracts ?? null) as PipeIOContracts | null;
  const inputForm = (responseMetadata?.input_form ?? null) as InputForm | null;
  // The method's entry pipe, which the caption names, and the pipe the form
  // opens on, which is the one the show named when it named one.
  const mainPipeRef =
    typeof responseMetadata?.main_pipe_ref === "string" ? responseMetadata.main_pipe_ref : null;
  const formPipeRef =
    typeof responseMetadata?.form_pipe_ref === "string"
      ? responseMetadata.form_pipe_ref
      : mainPipeRef;

  const [pickedPipe, setPickedPipe] = useState<SelectedPipe | null>(null);
  // Clicked node, else the entry pipe, else nothing — never the first pipe the
  // contract map happens to hold (see `selectedPipeFor`).
  const selectedPipe = useMemo<SelectedPipe | null>(
    () => selectedPipeFor(pickedPipe, formPipeRef),
    [pickedPipe, formPipeRef],
  );
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
  // The pipe the current run was started for, which the results panel looks
  // its output descriptor up by when the executed graph does not name it.
  const [runPipeRef, setRunPipeRef] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<UploadErrors>({});
  // Whether the user unfolded the form again after a completed run.
  const [editing, setEditing] = useState(false);
  const polling = useRunPolling(runId, statusAsync);
  const { results, error: resultsError } = useRunResults(
    runId,
    polling.phase === "terminal",
    resultsAsync,
  );

  // `useCallTool`'s caller changes identity per render; pin the latest so the
  // upload callback, which `RunPanel` builds its drop handler from, stays put.
  const requestUploadRef = useRef(requestUploadAsync);
  requestUploadRef.current = requestUploadAsync;
  // The cap the last grant reported, so a second oversized file is refused
  // before any call. The first one is refused by the grant route itself.
  const maxBytesRef = useRef<number | undefined>(undefined);
  // Bumped when the form switches pipe, as the panel's own generation is: an
  // upload still in flight from the previous form must not post its failure
  // under the new one.
  const uploadGenerationRef = useRef(0);
  const uploadFile = useCallback(async (file: File, fieldId: string) => {
    const generation = uploadGenerationRef.current;
    setUploadErrors((current) => withoutField(current, fieldId));
    try {
      const uploaded = await uploadPickedFile(file, {
        requestGrant: async (request: GrantRequest): Promise<GrantToolResponse> =>
          requestUploadRef.current(request),
        knownMaxBytes: maxBytesRef.current,
      });
      maxBytesRef.current = uploaded.maxBytes;
      return { url: uploaded.url, filename: uploaded.filename };
    } catch (err) {
      if (generation === uploadGenerationRef.current) {
        const message =
          err instanceof UploadFailure ? err.message : `Could not upload "${file.name}".`;
        setUploadErrors((current) => ({ ...current, [fieldId]: message }));
      }
      // Rethrown so the panel clears the field's busy state and leaves it empty.
      throw err;
    }
  }, []);

  // A field the user fixes another way — a pasted link, a cleared field, a
  // later upload — loses its failure. The previous values are read off a ref so
  // the callback stays put: the panel rebuilds its drop handler from it.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const handleValuesChange = useCallback((next: Record<string, unknown>) => {
    const previous = valuesRef.current;
    // Two commits in one tick (an upload landing as the user types) must each
    // compare against the one before, not both against the last render.
    valuesRef.current = next;
    setUploadErrors((current) => clearChangedFields(current, previous, next));
    setValues(next);
  }, []);

  if (!toolInfo.isSuccess) {
    return <EmptyState message="Loading the method…" maxHeight={maxHeight} />;
  }

  const { output, input } = toolInfo;
  // `graph_spec` is opaque on the wire; mthds-ui owns `GraphSpec`. `GraphViewer`
  // re-validates it internally (`validateGraphSpec`), so a malformed or null
  // spec degrades to its own empty state rather than throwing.
  const graphSpec = (toolInfo.responseMetadata.graph_spec ?? null) as GraphSpec | null;

  if (output.status !== "ok" || !output.is_valid) {
    return (
      <EmptyState
        message="The method does not validate — no graph to display."
        maxHeight={maxHeight}
      />
    );
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
  const stage = formViewStage({
    outcome: results?.content.state === "failed" ? "failed" : results ? "completed" : null,
    executedGraph: results ? hasExecutedGraph(results) : false,
    hasForm,
    editing,
  });
  const executedGraph = stage.graph === "executed" && results ? results : null;

  const handleNodeSelect = (_nodeId: string, nodeData: GraphNodeData) => {
    if (!nodeData.isPipe || !nodeData.pipeCode) return;
    const next: SelectedPipe = { domain: nodeData.nodeData?.domain_code, code: nodeData.pipeCode };
    if (next.code === selectedPipe?.code && next.domain === selectedPipe?.domain) return;
    setPickedPipe(next);
    setValues({});
    uploadGenerationRef.current += 1;
    setUploadErrors({});
  };

  const pipeLabel = selectedPipe
    ? selectedPipe.domain
      ? `${selectedPipe.domain}.${selectedPipe.code}`
      : selectedPipe.code
    : undefined;
  // The method the show was called with, as the result echoes it (the input as
  // a fallback). The run resolves it again, so a method saved again or a tag
  // moved since the show runs its new content: nothing pins a revision yet.
  const methodSelector = methodSelectorOf(output, input);

  const handleRun = (apiInputs: Record<string, unknown>) => {
    if (!selectedPipe || !methodSelector || !pipeLabel) return;
    // Synchronously, before any await — the panel's duplicate-run guard.
    setStarting(true);
    setStartError(null);
    setRunId(undefined);
    setRunPipeRef(pipeLabel);
    // A new run folds the form again once its own results arrive.
    setEditing(false);
    void (async () => {
      try {
        // The pipe goes by its qualified ref, the one the form was built for:
        // `pipelex_run` prepares the inputs against that pipe's signature.
        const response = await startRun({
          ...methodSelector,
          pipe_ref: pipeLabel,
          inputs: apiInputs,
        });
        const ack = response.structuredContent;
        if (ack.status === "ok" && ack.run_id) {
          setRunId(ack.run_id);
        } else {
          // The hint rides along: after a start whose outcome is unknown it is
          // what tells the user the run may exist before they press Run again.
          const error = ack.errors?.[0];
          setStartError(
            error === undefined
              ? "The run could not be started."
              : [error.message, error.hint].filter(Boolean).join(" "),
          );
        }
      } catch (err) {
        setStartError(err instanceof Error ? err.message : "The run could not be started.");
      } finally {
        setStarting(false);
      }
    })();
  };

  // The dry-run graph is built for the bundle's declared main pipe; the form
  // defaults to the entry pipe. Say so when they are not the same pipe. The
  // executed graph gets no caption: it is of the pipe that ran, which is the
  // one the results below it are for.
  const graphCaption =
    hasGraph && executedGraph === null
      ? graphCaptionFor(
          graphPipeRefOf(graphSpec),
          mainPipeRef,
          stage.showForm && hasForm ? (pipeLabel ?? null) : null,
        )
      : null;
  const statusLine = runStatusLineFor({
    runId,
    starting,
    startError,
    polling,
    hasResults: results !== null,
    resultsError: resultsError?.message ?? null,
  });
  const llmSummary = [
    executedGraph
      ? `Showing the executed graph of run ${runId}`
      : hasGraph
        ? `Showing the dry-run graph of the method: ${graphSpec?.nodes.length} nodes`
        : null,
    graphCaption,
    `runnable=${output.is_runnable}`,
    stage.showForm && hasForm ? `input form shown for pipe ${pipeLabel}` : null,
    statusLine?.text,
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
      {executedGraph ? (
        <div className="relative w-full overflow-hidden" style={{ height: graphHeight }}>
          {/* Keyed by run, so a later run's graph mounts fresh rather than
              inheriting the previous one's viewport and selection. */}
          <GraphViewer
            key={runId}
            graphspec={executedGraph.graphSpec as GraphSpec}
            // The executed run's own artifacts, so a data node shows its value
            // rather than its concept's structure table.
            contracts={executedGraph.contracts ?? undefined}
            outputForm={executedGraph.outputForm ?? undefined}
            inputForm={executedGraph.inputForm ?? undefined}
            initialDirection="LR"
            initialShowControllers={true}
            theme={theme}
            showThemeToggle={false}
            toolbarPosition={TOOLBAR_POSITION_FOR_VIEW}
          />
        </div>
      ) : hasGraph && graphSpec ? (
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
      {graphCaption ? (
        <p className="mt-2 px-1 text-xs" style={{ color: "#6b7280" }}>
          {graphCaption}
        </p>
      ) : null}
      {stage.showPanel && results && runId ? (
        <div className="mt-3">
          <RunResultsPanel
            runId={runId}
            results={results}
            requestedPipeRef={runPipeRef}
            durationSeconds={runDurationSeconds(polling.createdAt, polling.finishedAt)}
            dark={dark}
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => void setDisplayMode(isFullscreen ? "inline" : "fullscreen")}
            // The view's own toggle floats over the graph, and the executed
            // graph is at the top already.
            showFullscreenAction={false}
            showGraph={false}
            graphHeight={graphHeight}
          />
        </div>
      ) : null}
      {stage.showEditToggle ? (
        <div className="mt-2 px-2">
          <ToolbarButton dark={dark} onClick={() => setEditing(true)}>
            Edit inputs and run again
          </ToolbarButton>
        </div>
      ) : null}
      {stage.showForm && contract && descriptor && selectedPipe ? (
        <div className="mt-3">
          <RunPanel
            key={pipeLabel}
            contract={contract}
            descriptor={descriptor}
            values={values}
            onValuesChange={handleValuesChange}
            onRun={handleRun}
            running={running}
            uploadFile={uploadFile}
            title={pipeLabel}
            theme={theme}
          />
          {Object.entries(uploadErrors).map(([fieldId, message]) => (
            <p key={fieldId} className="mt-2 px-1 text-xs" style={{ color: "#b91c1c" }}>
              {message}
            </p>
          ))}
          <StatusLine line={statusLine} />
        </div>
      ) : null}
    </div>
  );
}

/** One line under the form: what the run started from it is doing. */
function StatusLine({ line }: { line: RunStatusLine | null }) {
  if (!line) return null;
  return (
    <p
      className="mt-2 px-1 text-xs"
      style={{ color: line.tone === "error" ? "#b91c1c" : "#6b7280" }}
    >
      {line.text}
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

/**
 * The method a show named, as `pipelex_run` takes it: exactly one of
 * `method_id` / `method_ref`. Read from the result's echo first, since that is
 * what the server resolved, and from the call's input otherwise.
 */
function methodSelectorOf(
  output: { method_id?: string; method_ref?: string },
  input: { method_id?: string; method_ref?: string } | undefined,
): { method_id: string } | { method_ref: string } | undefined {
  const methodId = output.method_id ?? input?.method_id;
  if (methodId) return { method_id: methodId };
  const methodRef = output.method_ref ?? input?.method_ref;
  if (methodRef) return { method_ref: methodRef };
  return undefined;
}
