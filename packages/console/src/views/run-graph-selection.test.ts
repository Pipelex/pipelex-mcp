import { describe, expect, it } from "vitest";

import {
  graphCaptionFor,
  graphPipeRefOf,
  parsePipeRef,
  selectedPipeFor,
} from "./run-graph-selection.js";

describe("parsePipeRef", () => {
  it("splits a namespaced ref at its last dot", () => {
    expect(parsePipeRef("demo.main")).toEqual({ domain: "demo", code: "main" });
    // Pipe codes carry no dots, so a dotted domain keeps every segment but the last.
    expect(parsePipeRef("acme.legal.review")).toEqual({ domain: "acme.legal", code: "review" });
  });

  it("keeps a bare code domainless", () => {
    expect(parsePipeRef("main")).toEqual({ code: "main" });
  });
});

describe("selectedPipeFor", () => {
  it("prefers the pipe the user clicked over the entry pipe", () => {
    expect(selectedPipeFor({ domain: "other", code: "shout" }, "demo.main")).toEqual({
      domain: "other",
      code: "shout",
    });
  });

  it("defaults to the effective entry pipe when nothing was clicked", () => {
    expect(selectedPipeFor(null, "demo.main")).toEqual({ domain: "demo", code: "main" });
  });

  it("selects nothing when no entry pipe was settled and nothing was clicked", () => {
    // The case that used to fall through to whichever pipe came first in the
    // contract map: a stated `default_pipe_ref: null` leaves `_meta` with no
    // `main_pipe_ref`, and the honest rendering is no form at all — a Run
    // button must be for a pipe somebody chose.
    expect(selectedPipeFor(null, null)).toBeNull();
    expect(selectedPipeFor(null, "")).toBeNull();
  });
});

describe("graphPipeRefOf", () => {
  it("reads the pipe the dry run stamped on the graph", () => {
    expect(graphPipeRefOf({ pipeline_ref: { domain: "demo", main_pipe: "main" }, nodes: [] })).toBe(
      "demo.main",
    );
  });

  it("is null when the graph does not name both halves of its pipe", () => {
    // No guess at which pipe an unlabelled graph shows: the caption is only
    // worth rendering when the graph states it.
    expect(graphPipeRefOf({ nodes: [] })).toBeNull();
    expect(graphPipeRefOf({ pipeline_ref: { main_pipe: "main" } })).toBeNull();
    expect(graphPipeRefOf({ pipeline_ref: { domain: "demo", main_pipe: "" } })).toBeNull();
    expect(graphPipeRefOf({ pipeline_ref: { domain: 42, main_pipe: "main" } })).toBeNull();
    expect(graphPipeRefOf(null)).toBeNull();
  });
});

describe("graphCaptionFor", () => {
  it("labels the graph and names the form's pipe when the entry pipe differs", () => {
    // A `method_ref` package whose `METHODS.toml` names `other.shout` while the
    // bundle declares `main_pipe = "main"` in `demo`: the graph is the bundle's
    // pipe, the form below is for the manifest's. Both are spelled out.
    expect(graphCaptionFor("demo.main", "other.shout", "other.shout")).toBe(
      "The graph above shows demo.main, the bundle's declared main pipe. The form below runs other.shout, the method's entry pipe.",
    );
  });

  it("renders nothing when the graph is of the entry pipe", () => {
    expect(graphCaptionFor("demo.main", "demo.main", "demo.main")).toBeNull();
    // Agreeing refs stay silent whatever the form is on.
    expect(graphCaptionFor("demo.main", "demo.main", "demo.step")).toBeNull();
  });

  it("stops claiming the form runs the entry pipe once it does not", () => {
    // The user clicked a node, or no form is shown: the graph is still not the
    // entry pipe, but "the form below runs" would now be false.
    const graphOnly =
      "The graph above shows demo.main, the bundle's declared main pipe. The method's entry pipe is other.shout.";
    expect(graphCaptionFor("demo.main", "other.shout", "demo.main")).toBe(graphOnly);
    expect(graphCaptionFor("demo.main", "other.shout", null)).toBe(graphOnly);
  });

  it("renders nothing when either ref is unknown", () => {
    // No settled entry pipe, or a graph that does not name its pipe: there is
    // no divergence to state.
    expect(graphCaptionFor("demo.main", null, null)).toBeNull();
    expect(graphCaptionFor(null, "other.shout", "other.shout")).toBeNull();
  });
});
