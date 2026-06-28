import "@/index.css";

import { GraphViewer } from "@pipelex/mthds-ui/graph/react";
import type { GraphSpec } from "@pipelex/mthds-ui";
import { useDisplayMode, useLayout } from "skybridge/web";

import { useToolInfo } from "../helpers.js";

/**
 * The Skybridge view for `mthds_validate`. A view is a tool with a UI, so this
 * renders the verdict's `graph_spec` (delivered view-only on `_meta`, read here
 * as `responseMetadata.graph_spec`) with mthds-ui's `GraphViewer`, the same
 * component `pipelex-app` ships. Invalid verdicts, pending-signature verdicts
 * with no graph, and `include_graph: false` calls fall back to a compact,
 * non-crashing empty state.
 */
export default function ValidationGraph() {
  // Hooks run unconditionally before any early return.
  const toolInfo = useToolInfo<"mthds_validate">();
  const { theme, maxHeight, safeArea } = useLayout();
  const [displayMode, setDisplayMode] = useDisplayMode();

  if (!toolInfo.isSuccess) {
    return <EmptyState message="Validating…" maxHeight={maxHeight} />;
  }

  const { output, responseMetadata } = toolInfo;
  // `graph_spec` is opaque on the wire; mthds-ui owns `GraphSpec`. `GraphViewer`
  // re-validates it internally (`validateGraphSpec`), so a malformed or null
  // spec degrades to its own empty state rather than throwing.
  const graphSpec = (responseMetadata.graph_spec ?? null) as GraphSpec | null;

  if (output.status !== "ok" || !output.is_valid) {
    return <EmptyState message="Validation failed — no graph to display." maxHeight={maxHeight} />;
  }
  if (!graphSpec || !graphSpec.nodes?.length) {
    return <EmptyState message="No graph for this verdict." maxHeight={maxHeight} />;
  }

  const isFullscreen = displayMode === "fullscreen";
  const { top, right, bottom, left } = safeArea.insets;
  // ReactFlow needs an explicit pixel height. Fill the host when fullscreen;
  // keep a compact preview inline (no inline overflow scroll — fullscreen is
  // the sanctioned mode for exploring the graph). Floor it so a small host
  // height or large insets can't collapse the canvas to nothing.
  const available = (maxHeight ?? 600) - top - bottom;
  const graphHeight = Math.max(isFullscreen ? available : Math.min(available, 420), 240);

  const dark = theme === "dark";

  return (
    <div
      data-llm={`Showing the execution graph of the validated method: ${graphSpec.nodes.length} nodes, runnable=${output.is_runnable}.`}
      className="relative w-full overflow-hidden"
      style={{ paddingTop: top, paddingRight: right, paddingBottom: bottom, paddingLeft: left }}
    >
      <button
        type="button"
        onClick={() => void setDisplayMode(isFullscreen ? "inline" : "fullscreen")}
        className="absolute right-2 top-2 z-10 cursor-pointer rounded-md px-2 py-1 text-xs"
        style={{
          background: dark ? "rgba(31,41,55,0.85)" : "rgba(243,244,246,0.9)",
          color: dark ? "#e5e7eb" : "#111827",
          border: `1px solid ${dark ? "#374151" : "#d1d5db"}`,
        }}
      >
        {isFullscreen ? "Collapse" : "Fullscreen"}
      </button>
      <div className="relative w-full overflow-hidden" style={{ height: graphHeight }}>
        <GraphViewer
          graphspec={graphSpec}
          initialDirection="LR"
          initialShowControllers={true}
          theme={theme}
          showThemeToggle={false}
        />
      </div>
    </div>
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
