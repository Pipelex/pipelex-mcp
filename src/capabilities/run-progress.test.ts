import { describe, expect, it } from "vitest";

import type { RunProgress } from "@pipelex/sdk";

import { FAILURE_MESSAGE_MAX_CODE_POINTS } from "./run-failure.js";
import {
  MAX_PROGRESS_INVOCATIONS,
  progressParagraph,
  progressReportsStuck,
  runProgressOf,
  runProgressSchema,
  selectInvocations,
} from "./run-progress.js";
import type { ProgressInvocationProjection } from "./run-progress.js";
import {
  MID_RUN_SNAPSHOT,
  MID_RUN_SUMMARY,
  PENDING_SNAPSHOT,
  STUCK_ITEM_DEGRADATION,
  wideBatchSnapshot,
} from "./run-progress-fixtures.js";

describe("runProgressOf", () => {
  it("relays the contract's worked example member for member", () => {
    const projected = runProgressOf(MID_RUN_SNAPSHOT);

    expect(projected?.omitted).toBe(0);
    expect(projected?.progress).toEqual(MID_RUN_SNAPSHOT);
    expect(projected?.progress.summary).toBe(MID_RUN_SUMMARY);
    expect(runProgressSchema.safeParse(projected?.progress).success).toBe(true);
  });

  it("relays a pending run's snapshot, which has no invocation", () => {
    expect(runProgressOf(PENDING_SNAPSHOT)).toEqual({ progress: PENDING_SNAPSHOT, omitted: 0 });
  });

  it("keeps the contract's known members only, dropping a part-of-run snapshot's and a later platform's", () => {
    const snapshot: RunProgress = {
      ...PENDING_SNAPSHOT,
      root_path: "filings.review_filings/step_3/item_2",
      chain: [{ execution: "exec-run", attempt: 1 }],
      later_member: "kept by the SDK, not by the status tool",
      degradation: { ...STUCK_ITEM_DEGRADATION, later_member: true },
      invocations: [
        {
          path: "filings.review_filings",
          pipe_code: "review_filings",
          pipe_ref: "filings.review_filings",
          pipe_type: "PipeSequence",
          status: "running",
          started_at: null,
          ended_at: null,
          later_member: 1,
        },
      ],
    };

    const progress = runProgressOf(snapshot)?.progress;

    expect(progress).not.toHaveProperty("root_path");
    expect(progress).not.toHaveProperty("chain");
    expect(progress).not.toHaveProperty("later_member");
    expect(progress?.degradation).toEqual(STUCK_ITEM_DEGRADATION);
    expect(progress?.invocations[0]).not.toHaveProperty("later_member");
  });

  it("drops an optional member that does not have its type, so the status tool's schema always holds", () => {
    const snapshot = {
      ...PENDING_SNAPSHOT,
      degradation: { reason: 7 },
      invocations: [
        {
          path: "filings.review_filings",
          pipe_code: "review_filings",
          pipe_ref: "filings.review_filings",
          pipe_type: "PipeBatch",
          status: "running",
          started_at: null,
          ended_at: null,
          step_count: "4",
          branch_count: -1,
          skip_reason: 3,
          batch: { total: 3, done: "1", running: 2, failed: 0 },
          condition: { selected_outcome: 4 },
          attempts: 1.5,
          last_failure: { at: "2026-10-12T09:30:52.317Z" },
          degradation: { reason: "workflow_task_failing", failed_attempts: "4", ends_at: 9 },
        },
      ],
    } as unknown as RunProgress;

    const progress = runProgressOf(snapshot)?.progress;

    expect(progress).not.toHaveProperty("degradation");
    expect(progress?.invocations[0]).toEqual({
      path: "filings.review_filings",
      pipe_code: "review_filings",
      pipe_ref: "filings.review_filings",
      pipe_type: "PipeBatch",
      status: "running",
      started_at: null,
      ended_at: null,
      degradation: { reason: "workflow_task_failing" },
    });
    expect(runProgressSchema.safeParse(progress).success).toBe(true);
  });

  it("reads no snapshot whose required members, or an invocation's, do not have their type", () => {
    const unreadable = [
      { ...PENDING_SNAPSHOT, summary: null },
      { ...PENDING_SNAPSHOT, version: -1 },
      { ...PENDING_SNAPSHOT, invocations: "none" },
      { ...MID_RUN_SNAPSHOT, invocations: [{ ...MID_RUN_SNAPSHOT.invocations[0], path: 1 }] },
      { ...MID_RUN_SNAPSHOT, invocations: [null] },
    ];
    for (const snapshot of unreadable) {
      expect(runProgressOf(snapshot as unknown as RunProgress)).toBeUndefined();
    }
  });

  it("bounds the messages the runtime and the platform write, and relays the summary whole", () => {
    const long = "x".repeat(FAILURE_MESSAGE_MAX_CODE_POINTS + 10);
    const longSummary = `Running ${"step ".repeat(400)}`;
    const snapshot: RunProgress = {
      ...MID_RUN_SNAPSHOT,
      summary: longSummary,
      degradation: { ...STUCK_ITEM_DEGRADATION, message: long },
      invocations: [
        {
          ...MID_RUN_SNAPSHOT.invocations[0]!,
          last_failure: { message: long },
        },
      ],
    };

    const progress = runProgressOf(snapshot)?.progress;

    expect(progress?.summary).toBe(longSummary);
    expect(progress?.degradation?.message).toMatch(/… \[10 more characters left out\]$/);
    expect(progress?.invocations[0]?.last_failure?.message).toMatch(
      /… \[10 more characters left out\]$/,
    );
  });

  it("lists at most the cap and counts the rest", () => {
    const snapshot = wideBatchSnapshot(40, 25);

    const projected = runProgressOf(snapshot);

    expect(snapshot.invocations.length).toBeGreaterThan(MAX_PROGRESS_INVOCATIONS);
    expect(projected?.progress.invocations).toHaveLength(MAX_PROGRESS_INVOCATIONS);
    expect(projected?.omitted).toBe(snapshot.invocations.length - MAX_PROGRESS_INVOCATIONS);
  });
});

describe("selectInvocations", () => {
  /** A snapshot's invocations, which have every member the status tool relays with its type. */
  function projectedOf(snapshot: RunProgress): ProgressInvocationProjection[] {
    return snapshot.invocations;
  }

  it("keeps every invocation of a snapshot within the cap, in order", () => {
    const invocations = projectedOf(MID_RUN_SNAPSHOT);

    expect(selectInvocations(invocations, MAX_PROGRESS_INVOCATIONS)).toEqual(invocations);
  });

  it("keeps a running invocation far down a wide batch, with its ancestors, in snapshot order", () => {
    const invocations = projectedOf(wideBatchSnapshot(40, 35));

    const kept = selectInvocations(invocations, MAX_PROGRESS_INVOCATIONS);
    const paths = kept.map((invocation) => invocation.path);

    expect(kept).toHaveLength(MAX_PROGRESS_INVOCATIONS);
    for (const path of [
      "filings.review_filings",
      "filings.review_filings/step_1",
      "filings.review_filings/step_1/item_35",
      "filings.review_filings/step_1/item_35/step_2",
    ]) {
      expect(paths).toContain(path);
    }
    // Snapshot order is kept, so each invocation still follows its ancestors.
    const order = paths.map((path) => invocations.findIndex((each) => each.path === path));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    for (const path of paths) {
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth += 1) {
        expect(paths).toContain(segments.slice(0, depth).join("/"));
      }
    }
    // The room left goes to the others in snapshot order, from the first item on.
    expect(paths).toContain("filings.review_filings/step_1/item_1/step_1");
    expect(paths).not.toContain("filings.review_filings/step_1/item_40");
  });

  it("keeps a troubled invocation that is no longer running, and nothing beyond the cap", () => {
    const invocations = projectedOf(wideBatchSnapshot(40, 1)).map((invocation) =>
      invocation.path === "filings.review_filings/step_1/item_38/step_1"
        ? {
            ...invocation,
            status: "failed",
            last_failure: { message: "An internal error occurred." },
          }
        : invocation,
    );

    const paths = selectInvocations(invocations, 10).map((invocation) => invocation.path);

    expect(paths).toHaveLength(10);
    expect(paths).toContain("filings.review_filings/step_1/item_38/step_1");
    expect(paths).toContain("filings.review_filings/step_1/item_38");
    expect(paths).toContain("filings.review_filings/step_1/item_1/step_2");
  });

  it("keeps the first of the invocations needing attention when they alone pass the cap, still nested", () => {
    const invocations = projectedOf(wideBatchSnapshot(10, 1)).map((invocation) =>
      invocation.path.includes("/item_") ? { ...invocation, status: "running" } : invocation,
    );

    const paths = selectInvocations(invocations, 5).map((invocation) => invocation.path);

    expect(paths).toEqual([
      "filings.review_filings",
      "filings.review_filings/step_1",
      "filings.review_filings/step_1/item_1",
      "filings.review_filings/step_1/item_1/step_1",
      "filings.review_filings/step_1/item_1/step_2",
    ]);
  });
});

describe("progressParagraph", () => {
  it("relays the summary after the label, as it is", () => {
    const progress = runProgressOf(MID_RUN_SNAPSHOT)?.progress;
    expect(progress).toBeDefined();
    if (progress === undefined) return;

    expect(progressParagraph(progress)).toBe(`Progress: ${MID_RUN_SUMMARY}`);
  });

  it("collapses a line break to a space, so the summary stays one paragraph", () => {
    const progress = runProgressOf({
      ...PENDING_SNAPSHOT,
      summary: "Running a\nthen b\r\n\r\nthen c end",
    })?.progress;
    expect(progress).toBeDefined();
    if (progress === undefined) return;

    expect(progressParagraph(progress)).toBe("Progress: Running a then b then c end");
  });
});

describe("progressReportsStuck", () => {
  it("reads a degradation other than the platform's failure to read the run as stuck", () => {
    const stuck = runProgressOf(MID_RUN_SNAPSHOT)?.progress;
    const unreadable = runProgressOf({
      ...PENDING_SNAPSHOT,
      degradation: { reason: "status_unavailable" },
    })?.progress;
    const unknown = runProgressOf({
      ...PENDING_SNAPSHOT,
      degradation: { reason: "a_later_reason" },
    })?.progress;

    expect(progressReportsStuck(stuck)).toBe(true);
    expect(progressReportsStuck(unknown)).toBe(true);
    expect(progressReportsStuck(unreadable)).toBe(false);
    expect(progressReportsStuck(runProgressOf(PENDING_SNAPSHOT)?.progress)).toBe(false);
    expect(progressReportsStuck(undefined)).toBe(false);
  });
});
