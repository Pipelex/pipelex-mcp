import { Component } from "react";
import type { ReactNode } from "react";

interface RenderBoundaryProps {
  /** What the wrapped part draws, as the line in its place names it: "The run's graph". */
  what: string;
  /**
   * Anything whose change means new data to draw, such as the run or the
   * artifact being rendered. The boundary tries its children again when it
   * changes, so one bad payload does not hide every later one.
   */
  resetKey?: unknown;
  /** Shown in place of the part, under the line; the line alone when absent. */
  fallback?: ReactNode;
  mutedColor?: string;
  children: ReactNode;
}

interface RenderBoundaryState {
  failed: boolean;
  resetKey: unknown;
}

/**
 * Keeps a renderer's throw to the part it draws. React unmounts the whole tree
 * when a render throws and nothing catches it, and a host then shows an empty
 * frame: on ChatGPT, which drops the `null` values of a tool result it relays
 * to a view, the graph validator's throw on the executed graph took the run's
 * output down with it. So each renderer the views mount from a package —
 * `GraphViewer`, `StuffViewer`, `RunPanel` — sits under one of these, and
 * each view's root under a last one.
 *
 * It says only that the part could not be drawn. The error is not shown: it is
 * a renderer's internal message, not something the person reading the view
 * can act on, and the view has no log to send it to.
 */
export class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  override state: RenderBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<RenderBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: RenderBoundaryProps,
    state: RenderBoundaryState,
  ): Partial<RenderBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { failed: false, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const line = (
      <p className="px-1 py-2 text-xs" style={{ color: this.props.mutedColor ?? "#6b7280" }}>
        {renderFailureLine(this.props.what)}
      </p>
    );
    if (this.props.fallback === undefined) return line;
    return (
      <>
        {line}
        {this.props.fallback}
      </>
    );
  }
}

/** The line a failed part leaves: `The run's graph could not be drawn here.` */
export function renderFailureLine(what: string): string {
  return `${what} could not be drawn here.`;
}
