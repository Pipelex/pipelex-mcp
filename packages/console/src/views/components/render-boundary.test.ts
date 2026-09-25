import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { RenderBoundary, renderFailureLine } from "./render-boundary.js";

// The Node suite has no DOM to mount a throwing child in, so these drive the
// boundary's own halves: the state React gives it on a throw and on new
// props, and what it renders in each state.
describe("RenderBoundary", () => {
  it("marks itself failed when a child throws", () => {
    expect(RenderBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("tries its children again when the data changes, and only then", () => {
    const failed = { failed: true, resetKey: "run_1" };
    expect(
      RenderBoundary.getDerivedStateFromProps(
        { what: "x", resetKey: "run_1", children: null },
        failed,
      ),
    ).toBeNull();
    expect(
      RenderBoundary.getDerivedStateFromProps(
        { what: "x", resetKey: "run_2", children: null },
        failed,
      ),
    ).toEqual({ failed: false, resetKey: "run_2" });
  });

  it("renders its children until one throws, then the line and the fallback", () => {
    const boundary = new RenderBoundary({
      what: "The rendered output",
      fallback: "the JSON view",
      children: "the rendered output",
    });
    expect(boundary.render()).toBe("the rendered output");

    boundary.state = { failed: true, resetKey: undefined };
    const rendered = boundary.render();
    expect(isValidElement(rendered)).toBe(true);
    const [line, fallback] = (rendered as ReactElement<{ children: ReactNode[] }>).props.children;
    expect((line as ReactElement<{ children: string }>).props.children).toBe(
      "The rendered output could not be drawn here.",
    );
    expect(fallback).toBe("the JSON view");
  });

  it("renders the line alone when there is no fallback", () => {
    const boundary = new RenderBoundary({ what: "The run's graph", children: "graph" });
    boundary.state = { failed: true, resetKey: undefined };
    const rendered = boundary.render() as ReactElement<{ children: string }>;
    expect(rendered.props.children).toBe(renderFailureLine("The run's graph"));
  });
});
