import { describe, expect, it } from "vitest";

import { parsePipeRef, selectedPipeFor } from "./run-graph-selection.js";

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
