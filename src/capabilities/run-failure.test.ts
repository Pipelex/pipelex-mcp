import { buildProblem, isProblem } from "@pipelex/sdk";
import type { Problem } from "@pipelex/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPERATOR_VIEW_LLM_COMPLETION_PROBLEM,
  RECORDED_FAILED_RUNS,
  TIMED_OUT_RUN_PROBLEM,
} from "./failed-run-fixtures.js";
import {
  FAILURE_FIELD_MAX_CODE_POINTS,
  FAILURE_MESSAGE_MAX_CODE_POINTS,
  RUN_ERROR_ITEM_MAX_CODE_POINTS,
  RUN_ERROR_MAX_ITEMS,
  RUN_ERROR_VALUE_MAX_DEPTH,
  runErrorOf,
  runErrorSchema,
  runErrorSummary,
  supportLineOf,
} from "./run-failure.js";
import { DEFAULT_API_URL, createPipelexApiClient } from "./shared.js";

const { llmCompletion, sandboxProvisioning, extractJobFailure } = RECORDED_FAILED_RUNS;

function runErrorOfRecorded(recorded: typeof llmCompletion): Problem {
  const runError = runErrorOf(recorded.statusRead.error);
  if (runError === undefined) throw new Error("the recorded problem did not read");
  return runError;
}

/** The provider's raw answer the operator's view keeps in `diagnostics`. */
const RAW_PROVIDER_TEXT =
  "Model global.anthropic.claude-opus-4-8 is not allowed for this integration";

describe("runErrorOf", () => {
  it("carries the run's problem as the platform serves it, every member kept", () => {
    for (const recorded of [llmCompletion, sandboxProvisioning, extractJobFailure]) {
      expect(runErrorOfRecorded(recorded)).toEqual(recorded.statusRead.error);
    }
    expect(runErrorOfRecorded(llmCompletion)).toMatchObject({
      code: "model.unavailable",
      domain: "operator",
      retry: "no",
      next_step: { kind: "change_model" },
      params: { model: "claude-4.8-opus", model_type: "llm", reason: "not_allowed" },
      pipeline_run_id: "run_aa422fd5-59ef-4801-a585-09e6a961e80f",
    });
  });

  it("drops the operator's diagnostics, so the provider's raw answer never reaches the caller", () => {
    expect(JSON.stringify(OPERATOR_VIEW_LLM_COMPLETION_PROBLEM)).toContain(RAW_PROVIDER_TEXT);

    const runError = runErrorOf(OPERATOR_VIEW_LLM_COMPLETION_PROBLEM);

    expect(runError).not.toHaveProperty("diagnostics");
    expect(JSON.stringify(runError)).not.toContain(RAW_PROVIDER_TEXT);
    expect(runErrorSummary("run_x", "FAILED", runError)).not.toContain(RAW_PROVIDER_TEXT);
    // Everything else is kept, the operator's own step included.
    const { diagnostics: _operatorOnly, ...view } = OPERATOR_VIEW_LLM_COMPLETION_PROBLEM;
    expect(runError).toEqual(view);
  });

  it("reads a value that is no problem document as none", () => {
    const notProblems: unknown[] = [
      null,
      undefined,
      {},
      "An internal error occurred.",
      // The runner's old error report, which the platform no longer serves.
      { error_type: "LLMCompletionError", title: "LLM completion", retryable: false },
      // A problem missing its next step.
      { ...TIMED_OUT_RUN_PROBLEM, next_step: undefined },
    ];
    for (const value of notProblems) {
      expect(runErrorOf(value)).toBeUndefined();
    }
  });

  it("reads none from a status read whose error the SDK did not take as a problem", async () => {
    // The status read the SDK actually hands back, from a stored error that is
    // no problem document: `@pipelex/sdk` reads it as `null`, and this module
    // reads that as no problem.
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json({
          pipeline_run_id: "run_x",
          status: "FAILED",
          created_at: "2026-09-23T15:16:00Z",
          finished_at: "2026-09-23T15:16:37Z",
          error: { title: "LLM completion", error_type: 12, retryable: "no" },
        }),
      ),
    );
    const read = await createPipelexApiClient({ baseUrl: DEFAULT_API_URL }).getRunStatus("run_x");

    expect(read.error ?? null).toBeNull();
    expect(runErrorOf(read.error)).toBeUndefined();
  });

  it("validates against the schema the run family declares for it", () => {
    for (const recorded of [llmCompletion, sandboxProvisioning, extractJobFailure]) {
      expect(runErrorSchema.safeParse(runErrorOfRecorded(recorded)).success).toBe(true);
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runErrorOf's bounds", () => {
  it("cuts an unbounded detail to its cap, saying how much it left out", () => {
    // A structured output that failed after its re-asks quotes every
    // validation error; one such failure measured over 400,000 characters.
    const detail = `Structured output failed: ${"x".repeat(200_000)}`;
    const runError = runErrorOf({ ...TIMED_OUT_RUN_PROBLEM, detail });

    expect(Array.from(runError?.detail ?? "").length).toBeLessThan(
      FAILURE_MESSAGE_MAX_CODE_POINTS + 60,
    );
    expect(runError?.detail).toMatch(
      /^Structured output failed: x+… \[\d+ more characters left out\]$/,
    );
    expect(runErrorSummary("run_x", "FAILED", runError).length).toBeLessThan(
      FAILURE_MESSAGE_MAX_CODE_POINTS + 800,
    );
    // Still a problem document, so a reader of the result can take it as one.
    expect(isProblem(runError)).toBe(true);
  });

  it("bounds the message, the title and the next step, and never splits a character", () => {
    const long = "é🙂".repeat(FAILURE_MESSAGE_MAX_CODE_POINTS);
    const runError = runErrorOf({
      ...TIMED_OUT_RUN_PROBLEM,
      title: long,
      message: long,
      next_step: { kind: "contact_owner", detail: long },
    });

    expect(runError?.title.startsWith("é🙂".repeat(FAILURE_FIELD_MAX_CODE_POINTS / 2))).toBe(true);
    expect(Array.from(runError?.title ?? "").length).toBeLessThan(
      FAILURE_FIELD_MAX_CODE_POINTS + 60,
    );
    for (const value of [runError?.title, runError?.message, runError?.next_step.detail]) {
      expect(value).toMatch(/… \[\d+ more characters left out\]$/);
      expect(value).not.toMatch(/�/);
    }
    expect(Array.from(String(runError?.message)).length).toBeLessThan(
      FAILURE_MESSAGE_MAX_CODE_POINTS + 60,
    );
    expect(runError?.next_step.kind).toBe("contact_owner");
  });

  it("lists at most its cap of faults, each bounded, and counts the rest", () => {
    const items = Array.from({ length: RUN_ERROR_MAX_ITEMS + 7 }, (_, index) => ({
      code: "method.invalid",
      detail: `Fault ${index}: ${"y".repeat(RUN_ERROR_ITEM_MAX_CODE_POINTS * 2)}`,
      location: { pipe: `pipe_${index}` },
    }));
    const runError = runErrorOf({ ...TIMED_OUT_RUN_PROBLEM, errors: items });

    expect(runError?.errors).toHaveLength(RUN_ERROR_MAX_ITEMS);
    expect(runError?.errors_omitted).toBe(7);
    expect(runError?.errors?.[0]).toMatchObject({
      code: "method.invalid",
      location: { pipe: "pipe_0" },
    });
    for (const item of runError?.errors ?? []) {
      expect(item.detail).toMatch(/… \[\d+ more characters left out\]$/);
      expect(Array.from(item.detail).length).toBeLessThan(RUN_ERROR_ITEM_MAX_CODE_POINTS + 60);
    }
    expect(runErrorSchema.safeParse(runError).success).toBe(true);
  });

  it("bounds the params and the location of the problem and of each fault, saying what it left out", () => {
    const longText = "z".repeat(RUN_ERROR_ITEM_MAX_CODE_POINTS * 3);
    const hashes = Array.from({ length: RUN_ERROR_MAX_ITEMS + 5 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    const names = Array.from({ length: RUN_ERROR_MAX_ITEMS + 5 }, (_, index) => `pipe_${index}`);
    const wideObject = Object.fromEntries(
      Array.from({ length: RUN_ERROR_MAX_ITEMS + 3 }, (_, index) => [`member_${index}`, index]),
    );
    let deep: unknown = "bottom";
    for (let level = 0; level < RUN_ERROR_VALUE_MAX_DEPTH + 2; level += 1) deep = { level: deep };
    const largeFix = {
      fix_code: "rename-model",
      description: longText,
      safety: "safe",
      ops: [{ kind: "set_key", table_path: ["pipe", "summarize"], key: "model", value: longText }],
    };
    const smallFix = {
      fix_code: "rename-model",
      description: "Use the model the deck names.",
      safety: "safe",
      ops: [{ kind: "set_key", table_path: ["pipe", "summarize"], key: "model", value: "gpt-5" }],
    };
    const runError = runErrorOf({
      ...TIMED_OUT_RUN_PROBLEM,
      params: { timeout: 3600, reason: longText, missing_blobs: hashes, wide: wideObject, deep },
      location: { pipe: "p".repeat(FAILURE_FIELD_MAX_CODE_POINTS * 2), path: names, item: 3 },
      errors: [
        {
          code: "method.invalid",
          detail: "One fault.",
          params: { reason: longText },
          location: { file: "f".repeat(FAILURE_FIELD_MAX_CODE_POINTS * 2), line: 12 },
          suggestions: names,
          suggested_fix: largeFix,
        },
        { code: "method.invalid", detail: "Another fault.", suggested_fix: smallFix },
      ],
    });

    expect(runError).toBeDefined();
    const params = runError?.params as Record<string, unknown>;
    expect(params.timeout).toBe(3600);
    expect(params.reason).toMatch(/… \[\d+ more characters left out\]$/);
    expect(Array.from(String(params.reason)).length).toBeLessThan(
      RUN_ERROR_ITEM_MAX_CODE_POINTS + 60,
    );
    // A typed list keeps its entries alone; the count of the rest sits in the
    // object's one `…` member, which no member of the object takes.
    expect(params.missing_blobs).toEqual(hashes.slice(0, RUN_ERROR_MAX_ITEMS));
    expect(params["…"]).toBe("5 more entries of missing_blobs left out");
    expect(params).not.toHaveProperty("missing_blobs_omitted");
    const wide = params.wide as Record<string, unknown>;
    expect(Object.keys(wide)).toHaveLength(RUN_ERROR_MAX_ITEMS + 1);
    expect(wide["…"]).toBe("3 more members left out");
    expect(JSON.stringify(params.deep)).toContain("left out]");
    expect(JSON.stringify(params.deep)).not.toContain("bottom");

    expect(runError?.location?.pipe).toMatch(/… \[\d+ more characters left out\]$/);
    expect(Array.from(runError?.location?.pipe ?? "").length).toBeLessThan(
      FAILURE_FIELD_MAX_CODE_POINTS + 60,
    );
    // A pipe path cut anywhere would name another pipe, so it is carried whole.
    expect(runError?.location?.path).toEqual(names);
    expect(runError?.location).not.toHaveProperty("…");
    expect(runError?.location?.item).toBe(3);

    const [first, second] = runError?.errors ?? [];
    expect(String(first?.params?.reason)).toMatch(/… \[\d+ more characters left out\]$/);
    expect(first?.location?.file).toMatch(/… \[\d+ more characters left out\]$/);
    expect(first?.location?.line).toBe(12);
    expect(first?.suggestions).toEqual(names.slice(0, RUN_ERROR_MAX_ITEMS));
    expect(first?.suggestions_omitted).toBe(5);
    // A fix is applied as written, so one too large is left out rather than cut.
    expect(first).not.toHaveProperty("suggested_fix");
    expect(first?.suggested_fix_omitted).toBe(1);
    expect(second?.suggested_fix).toEqual(smallFix);

    expect(runErrorSchema.safeParse(runError).success).toBe(true);
    expect(isProblem(runError)).toBe(true);
  });

  it("never lets the count of what it left out take a member's place", () => {
    // The platform's own members include names a sibling count would have
    // taken (`files_omitted`) and the `…` the count is named by: each is kept
    // as served, and the count takes the first name of `…` no member has.
    const files = Array.from({ length: RUN_ERROR_MAX_ITEMS + 2 }, (_, index) => `f${index}.mthds`);
    const runError = runErrorOf({
      ...TIMED_OUT_RUN_PROBLEM,
      params: { files, files_omitted: 40, "…": "the platform's own member" },
    });

    const params = runError?.params as Record<string, unknown>;
    expect(params.files).toEqual(files.slice(0, RUN_ERROR_MAX_ITEMS));
    expect(params.files_omitted).toBe(40);
    expect(params["…"]).toBe("the platform's own member");
    expect(params["……"]).toBe("2 more entries of files left out");
    expect(isProblem(runError)).toBe(true);
  });

  it("carries a problem that fits whole, with no count of left-out faults", () => {
    const withFaults = {
      ...TIMED_OUT_RUN_PROBLEM,
      errors: [{ code: "method.invalid", detail: "One fault." }],
    };

    expect(runErrorOf(TIMED_OUT_RUN_PROBLEM)).toEqual(TIMED_OUT_RUN_PROBLEM);
    expect(runErrorOf(withFaults)).toEqual(withFaults);
    expect(runErrorOf(withFaults)).not.toHaveProperty("errors_omitted");
  });
});

describe("the retry verdict and the next step", () => {
  it("states the problem's own retry verdict, inferring none", () => {
    expect(runErrorSummary("run_x", "FAILED", runErrorOfRecorded(llmCompletion))).toContain(
      "- Code: `model.unavailable` (domain operator, retry no)",
    );
    expect(runErrorSummary("run_x", "FAILED", runErrorOfRecorded(extractJobFailure))).toContain(
      "- Code: `provider.failed` (domain runtime, retry yes)",
    );
    expect(runErrorSummary("run_x", "FAILED", runErrorOfRecorded(sandboxProvisioning))).toContain(
      "- Code: `pipelex.sandbox.unavailable` (domain runtime, retry yes)",
    );
  });

  it("never advises running it again when the problem says a retry cannot succeed", () => {
    const summary = runErrorSummary("run_x", "FAILED", runErrorOfRecorded(llmCompletion));

    expect(summary).not.toMatch(/run (it|the method) again/i);
  });

  it("relays the problem's own next step", () => {
    expect(runErrorSummary("run_x", "FAILED", runErrorOfRecorded(llmCompletion))).toContain(
      "**Next step** (`change_model`): Use a model this deployment serves in place of 'claude-4.8-opus', or ask whoever runs the runtime to serve it.",
    );
    expect(runErrorSummary("run_x", "TIMED_OUT", runErrorOf(TIMED_OUT_RUN_PROBLEM))).toContain(
      "**Next step** (`contact_owner`): Ask the method's owner to make the method end within the deployment's run limit.",
    );
  });
});

describe("supportLineOf", () => {
  it("gives the run id, the problem's code and when the run ended", () => {
    expect(
      supportLineOf("run_x", runErrorOfRecorded(llmCompletion), "2026-09-23T15:16:37.856067+00:00"),
    ).toBe("Run run_x · model.unavailable · ended 2026-09-23T15:16:37.856067+00:00");
  });

  it("gives what is known of a run with no problem", () => {
    expect(supportLineOf("run_x", undefined, "2026-09-24T10:38:04Z")).toBe(
      "Run run_x · ended 2026-09-24T10:38:04Z",
    );
    expect(supportLineOf("run_x", undefined)).toBe("Run run_x");
    expect(supportLineOf("run_x", undefined, " ")).toBe("Run run_x");
  });
});

describe("runErrorSummary", () => {
  it("says how the run ended, renders its problem and says what to give support", () => {
    const read = llmCompletion.statusRead;

    expect(
      runErrorSummary(
        read.pipeline_run_id,
        read.status,
        runErrorOfRecorded(llmCompletion),
        read.finished_at,
      ),
    ).toBe(
      [
        "Run `run_aa422fd5-59ef-4801-a585-09e6a961e80f` ended FAILED.",
        "## This deployment serves no backend for the model",
        "The llm model 'claude-4.8-opus' exists, but this deployment does not serve it (reason: not_allowed).",
        "**Next step** (`change_model`): Use a model this deployment serves in place of 'claude-4.8-opus', or ask whoever runs the runtime to serve it.",
        "- Code: `model.unavailable` (domain operator, retry no)\n- Run: `run_aa422fd5-59ef-4801-a585-09e6a961e80f`",
        "For support: Run run_aa422fd5-59ef-4801-a585-09e6a961e80f · model.unavailable · ended 2026-09-23T15:16:37.856067+00:00",
      ].join("\n\n"),
    );
  });

  it("renders each fault of a problem that has several", () => {
    const runError = runErrorOf(
      buildProblem(
        "run.timed_out",
        { timeout: 3600 },
        { errors: [{ code: "method.invalid", detail: "One fault.", location: { pipe: "p" } }] },
      ),
    );

    expect(runErrorSummary("run_x", "FAILED", runError)).toContain(
      "### Errors\n\n- `method.invalid`: One fault. (pipe 'p')",
    );
  });

  it("says a run with no problem has only its status, and still gives the support line", () => {
    expect(runErrorSummary("run_x", "CANCELLED", undefined, "2026-09-24T10:38:04Z")).toBe(
      [
        "Run `run_x` ended CANCELLED.",
        "The run stored no problem saying why it ended, so its status is all that is known about it.",
        "For support: Run run_x · ended 2026-09-24T10:38:04Z",
      ].join("\n\n"),
    );
  });

  it("says the reason is unknown, not missing, when the problem could not be read", () => {
    const summary = runErrorSummary("run_x", "FAILED", undefined, undefined, false);

    expect(summary).toContain(
      "Why it ended is unknown for now, since the run's problem could not be read; reading the run's status again returns it.",
    );
    expect(summary).not.toContain("stored no problem");
  });
});
