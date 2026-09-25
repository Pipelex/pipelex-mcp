import { describe, expect, it } from "vitest";

import { formRunInFlight, formViewStage, runStatusLineFor } from "./run-graph-stage.js";

describe("formViewStage", () => {
  it("shows the form and the dry-run graph before any run, and while one is going", () => {
    expect(
      formViewStage({ outcome: null, executedGraph: false, hasForm: true, editing: false }),
    ).toEqual({ graph: "dry_run", showPanel: false, showForm: true, showEditToggle: false });
  });

  it("puts a completed run's results in the form's place, under the executed graph", () => {
    expect(
      formViewStage({ outcome: "completed", executedGraph: true, hasForm: true, editing: false }),
    ).toEqual({ graph: "executed", showPanel: true, showForm: false, showEditToggle: true });
  });

  it("brings the form back under the results, with the dry-run graph, when the user asks to edit", () => {
    // The dry-run graph is the one whose pipe nodes switch the form's pipe.
    expect(
      formViewStage({ outcome: "completed", executedGraph: true, hasForm: true, editing: true }),
    ).toEqual({ graph: "dry_run", showPanel: true, showForm: true, showEditToggle: false });
  });

  it("keeps the dry-run graph when the completed run carries no graph", () => {
    expect(
      formViewStage({ outcome: "completed", executedGraph: false, hasForm: true, editing: false })
        .graph,
    ).toBe("dry_run");
  });

  it("keeps the form open under a failed run, whose next step is changing the inputs", () => {
    // The hosted plane produces no graph for a failed run, so the dry run stays.
    expect(
      formViewStage({ outcome: "failed", executedGraph: false, hasForm: true, editing: false }),
    ).toEqual({ graph: "dry_run", showPanel: true, showForm: true, showEditToggle: false });
  });

  it("offers no toggle and shows no form when there is no form to show", () => {
    expect(
      formViewStage({ outcome: "completed", executedGraph: true, hasForm: false, editing: false }),
    ).toEqual({ graph: "executed", showPanel: true, showForm: false, showEditToggle: false });
    expect(
      formViewStage({ outcome: null, executedGraph: false, hasForm: false, editing: false })
        .showForm,
    ).toBe(false);
  });
});

describe("formRunInFlight", () => {
  const settled = { starting: false, runId: "run_1", hasResults: false, resultsFailed: false };

  it("holds Run while the run starts and while it runs", () => {
    expect(formRunInFlight({ ...settled, starting: true, runId: undefined, phase: "idle" })).toBe(
      true,
    );
    expect(formRunInFlight({ ...settled, phase: "polling" })).toBe(true);
  });

  it("keeps holding Run once the run is terminal, until its results are read", () => {
    expect(formRunInFlight({ ...settled, phase: "terminal" })).toBe(true);
    expect(formRunInFlight({ ...settled, phase: "terminal", hasResults: true })).toBe(false);
  });

  it("frees Run when the results fetch failed for good, or the view lost the run", () => {
    expect(formRunInFlight({ ...settled, phase: "terminal", resultsFailed: true })).toBe(false);
    expect(formRunInFlight({ ...settled, phase: "hard_error" })).toBe(false);
  });

  it("frees Run before any run", () => {
    expect(formRunInFlight({ ...settled, runId: undefined, phase: "idle" })).toBe(false);
  });
});

describe("runStatusLineFor", () => {
  const idle = { phase: "idle", runStatus: undefined, health: null, hardError: null } as const;
  const base = {
    runId: undefined,
    starting: false,
    startError: null,
    polling: idle,
    hasResults: false,
    resultsError: null,
  };

  it("says nothing before any run", () => {
    expect(runStatusLineFor(base)).toBeNull();
  });

  it("says a start failed, ahead of anything else", () => {
    expect(
      runStatusLineFor({ ...base, startError: "Pipelex API is unreachable.", starting: true }),
    ).toEqual({ text: "Could not start the run: Pipelex API is unreachable.", tone: "error" });
  });

  it("says the run is starting, then where it stands", () => {
    expect(runStatusLineFor({ ...base, starting: true })?.text).toBe("Starting the run…");
    expect(
      runStatusLineFor({
        ...base,
        runId: "run_1",
        polling: { phase: "polling", runStatus: "RUNNING", health: "retrying", hardError: null },
      }),
    ).toEqual({ text: "Run run_1: RUNNING (retrying…)", tone: "info" });
  });

  it("says the results are being fetched once the run is terminal", () => {
    expect(
      runStatusLineFor({
        ...base,
        runId: "run_1",
        polling: { phase: "terminal", runStatus: "COMPLETED", health: null, hardError: null },
      }),
    ).toEqual({ text: "Run run_1 completed. Fetching the results…", tone: "info" });
  });

  it("says the results could not be fetched, with the reason", () => {
    expect(
      runStatusLineFor({
        ...base,
        runId: "run_1",
        polling: { phase: "terminal", runStatus: "FAILED", health: null, hardError: null },
        resultsError: "The session expired.",
      }),
    ).toEqual({
      text: "Run run_1 ended with status FAILED, but its results could not be fetched: The session expired.",
      tone: "error",
    });
  });

  it("says the view lost track of the run", () => {
    expect(
      runStatusLineFor({
        ...base,
        runId: "run_1",
        polling: {
          phase: "hard_error",
          runStatus: "RUNNING",
          health: null,
          hardError: {
            class: "config",
            message: "Not visible to your organization.",
            retryable: false,
          },
        },
      }),
    ).toEqual({
      text: "Run run_1: lost track of it (Not visible to your organization.).",
      tone: "error",
    });
  });

  it("goes quiet once the results are shown, since the panel says it all", () => {
    expect(
      runStatusLineFor({
        ...base,
        runId: "run_1",
        polling: { phase: "terminal", runStatus: "COMPLETED", health: null, hardError: null },
        hasResults: true,
      }),
    ).toBeNull();
  });
});
