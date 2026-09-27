import { useRef, useState } from "react";

import type { RunFailureDisplay } from "@pipelex/mcp-core/capabilities/run-failure.js";

/**
 * Why a run failed, as a person reads it in either run view: the reason, what
 * to do next, whether trying again can help, and a short line to hand support
 * with a Copy button beside it. The display is built by `failureDisplayOf` from
 * the report's title and user action, so the report's message and the
 * provider's raw text never reach this block.
 *
 * The support line is selectable in one click as well, because a host's
 * sandboxed frame may refuse the clipboard: when the write is refused, the
 * button selects the line instead and says so.
 */
export function FailureDetails({
  failure,
  color,
  mutedColor,
  dark,
}: {
  failure: RunFailureDisplay;
  color: string;
  mutedColor: string;
  dark: boolean;
}) {
  return (
    <div className="space-y-1 text-xs" style={{ color }}>
      <p>
        <span className="font-medium">Why: </span>
        {failure.reason}
      </p>
      <p>
        <span className="font-medium">What to do: </span>
        {failure.nextStep}
        {failure.retry ? ` ${failure.retry}` : ""}
      </p>
      <SupportLine line={failure.support} mutedColor={mutedColor} dark={dark} />
    </div>
  );
}

function SupportLine({
  line,
  mutedColor,
  dark,
}: {
  line: string;
  mutedColor: string;
  dark: boolean;
}) {
  const lineRef = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<"copied" | "selected" | null>(null);

  const selectLine = () => {
    const element = lineRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (!element || !selection) return;
    selection.selectAllChildren(element);
    setCopied("selected");
  };

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) {
      selectLine();
      return;
    }
    clipboard.writeText(line).then(() => setCopied("copied"), selectLine);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" style={{ color: mutedColor }}>
      <span>For support:</span>
      <code
        ref={lineRef}
        className="select-all rounded px-1 py-0.5 font-mono"
        style={{ background: dark ? "rgba(55,65,81,0.6)" : "rgba(229,231,235,0.8)" }}
      >
        {line}
      </code>
      <button
        type="button"
        onClick={copy}
        className="cursor-pointer underline"
        style={{ color: mutedColor }}
      >
        {copied === "copied" ? "Copied" : copied === "selected" ? "Selected, copy it" : "Copy"}
      </button>
    </div>
  );
}
