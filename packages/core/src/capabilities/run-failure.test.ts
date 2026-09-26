import { describe, expect, it } from "vitest";

import { RECORDED_FAILED_RUNS } from "./failed-run-fixtures.js";
import {
  FAILURE_FIELD_MAX_CODE_POINTS,
  FAILURE_MESSAGE_MAX_CODE_POINTS,
  failureDisplayOf,
  failureSummaryLines,
  nextStepOf,
  retryAdviceOf,
  runFailureOf,
  supportLineOf,
} from "./run-failure.js";
import type { RunFailure } from "./run-failure.js";

const { llmCompletion, sandboxProvisioning, extractJobFailure } = RECORDED_FAILED_RUNS;

function failureOf(recorded: typeof llmCompletion): RunFailure {
  const read = recorded.statusRead;
  const failure = runFailureOf(read.pipeline_run_id, read.error, read.finished_at);
  if (failure === undefined) throw new Error("the recorded report did not narrow");
  return failure;
}

/** Every piece of text the view shows a person, joined. */
function shown(recorded: typeof llmCompletion): string {
  const display = failureDisplayOf(recorded.statusRead.pipeline_run_id, failureOf(recorded));
  return [display.reason, display.nextStep, display.retry, display.support].join("\n");
}

describe("runFailureOf", () => {
  it("carries the report's fields a reader acts on, the run id and when it ended", () => {
    expect(failureOf(llmCompletion)).toEqual({
      run_id: "run_aa422fd5-59ef-4801-a585-09e6a961e80f",
      error_type: "LLMCompletionError",
      title: "LLM completion",
      message: llmCompletion.statusRead.error?.message,
      error_domain: "config",
      error_category: "configuration",
      retryable: false,
      user_action: {
        kind: "change_input",
        detail: "The provider rejected the request — review the prompt, parameters, and inputs.",
      },
      finished_at: "2026-09-23T15:16:37.856067+00:00",
    });
  });

  it("leaves out the provider's metadata, and every field the report did not carry", () => {
    const failure = failureOf(sandboxProvisioning);

    expect(failure).toEqual({
      run_id: "run_a23eccb6-fc93-4c30-8ba5-e6d785e1c96f",
      error_type: "SandboxProvisioningError",
      title: "Sandbox provisioning",
      message:
        "Could not provision a Daytona box for pipe: Failed to create sandbox: Snapshot pipelex-base-dev is building",
      finished_at: "2026-09-24T10:38:04.285649+00:00",
    });
    expect(failureOf(llmCompletion)).not.toHaveProperty("provider_metadata");
    expect(JSON.stringify(failureOf(llmCompletion))).not.toContain("APIStatusError");
  });

  it("reads no report, a report that is not an object, and one that says nothing, as none", () => {
    for (const report of [null, undefined, "LLMCompletionError", 42, [], {}, { retryable: true }]) {
      expect(runFailureOf("run_x", report, "2026-09-23T15:16:37Z")).toBeUndefined();
    }
  });

  it("drops a field of the wrong type rather than guessing it", () => {
    const failure = runFailureOf("run_x", {
      title: "LLM completion",
      error_type: 12,
      retryable: "no",
      user_action: { kind: "change_model" },
      error_domain: "  ",
    });

    expect(failure).toEqual({ run_id: "run_x", title: "LLM completion" });
  });
});

describe("runFailureOf's bounds", () => {
  it("cuts an unbounded message to its cap, saying how much it left out", () => {
    // A structured output that failed after its re-asks quotes every validation
    // error; one such report measured over 400,000 characters.
    const message = `Structured output failed: ${"x".repeat(200_000)}`;
    const failure = runFailureOf("run_x", { error_type: "LLMCompletionError", message });

    expect(Array.from(failure?.message ?? "").length).toBeLessThan(
      FAILURE_MESSAGE_MAX_CODE_POINTS + 60,
    );
    expect(failure?.message).toMatch(
      /^Structured output failed: x+… \[\d+ more characters left out\]$/,
    );
    expect(failureSummaryLines("run_x", "FAILED", failure).join("\n").length).toBeLessThan(
      FAILURE_MESSAGE_MAX_CODE_POINTS + 500,
    );
  });

  it("bounds every other text field, and never splits a character", () => {
    const long = "é🙂".repeat(FAILURE_FIELD_MAX_CODE_POINTS);
    const failure = runFailureOf("run_x", {
      error_type: long,
      title: long,
      error_domain: long,
      error_category: long,
      user_action: { kind: "change_input", detail: long },
    });

    for (const value of [
      failure?.error_type,
      failure?.title,
      failure?.error_domain,
      failure?.error_category,
      failure?.user_action?.detail,
    ]) {
      expect(value?.startsWith("é🙂".repeat(FAILURE_FIELD_MAX_CODE_POINTS / 2))).toBe(true);
      expect(value).toMatch(/… \[\d+ more characters left out\]$/);
      expect(value).not.toMatch(/\uFFFD/);
    }
  });

  it("carries a message that fits whole", () => {
    expect(failureOf(llmCompletion).message).toBe(llmCompletion.statusRead.error?.message);
  });
});

describe("the wait_and_retry action", () => {
  it("carries this server's own advice in structuredContent, never that the system will retry", () => {
    const failure = failureOf(extractJobFailure);

    expect(failure.user_action).toEqual({
      kind: "wait_and_retry",
      detail: "Wait a moment, then run it again.",
    });
    expect(JSON.stringify(failure)).not.toMatch(/retry automatically/);
  });

  it("carries no advice when the report says a retry cannot help", () => {
    const failure = runFailureOf("run_x", {
      error_type: "AmbiguousError",
      retryable: false,
      user_action: { kind: "wait_and_retry", detail: "The system will retry automatically." },
    });

    expect(failure?.user_action).toEqual({ kind: "wait_and_retry", detail: "" });
    expect(nextStepOf(failure)).toBeUndefined();
  });
});

describe("the retry advice", () => {
  it("claims nothing when the report does not say", () => {
    expect(retryAdviceOf(failureOf(sandboxProvisioning))).toBeUndefined();
    expect(
      failureSummaryLines("run_x", "FAILED", failureOf(sandboxProvisioning)).join("\n"),
    ).not.toMatch(/retry|again/i);
  });

  it("never advises running it again when the report says it cannot succeed", () => {
    const failure = failureOf(llmCompletion);

    expect(retryAdviceOf(failure)).toBe(
      "The report does not expect running it again unchanged to help.",
    );
    expect(failureSummaryLines(failure.run_id, "FAILED", failure).join("\n")).not.toMatch(
      /can succeed|run it again\./i,
    );
    // A wait-and-retry kind the report contradicts says nothing, worded or not,
    // rather than advise a retry: Azure's AMBIGUOUS category words exactly this.
    for (const detail of ["", "Transient provider error — the system will retry automatically."]) {
      expect(
        nextStepOf({
          run_id: "run_x",
          retryable: false,
          user_action: { kind: "wait_and_retry", detail },
        }),
      ).toBeUndefined();
    }
  });

  it("words a false retry flag as the report's expectation, never as a certainty", () => {
    expect(retryAdviceOf(failureOf(llmCompletion))).not.toMatch(/will fail/i);
  });

  it("says a retry can help when the report says so", () => {
    expect(retryAdviceOf(failureOf(extractJobFailure))).toBe("Running it again can succeed.");
  });
});

describe("nextStepOf", () => {
  it("relays the report's own advice when it words one", () => {
    expect(nextStepOf(failureOf(llmCompletion))).toBe(
      "The provider rejected the request — review the prompt, parameters, and inputs.",
    );
  });

  it("never relays that the system will retry a run that has ended", () => {
    // The runner words wait_and_retry for a pipe still inside its retries; the
    // stored report of a finished run is not one, so its own sentence stands in.
    expect(extractJobFailure.statusRead.error?.user_action?.detail).toMatch(/retry automatically/);
    expect(nextStepOf(failureOf(extractJobFailure))).toBe("Wait a moment, then run it again.");
  });

  it("chooses a sentence by the action's kind when it carries no detail", () => {
    const step = (kind: string) =>
      nextStepOf({ run_id: "run_x", user_action: { kind, detail: " " } });

    expect(step("wait_and_retry")).toBe("Wait a moment, then run it again.");
    expect(step("change_input")).toMatch(/change the inputs/i);
    expect(step("change_model")).toMatch(/another model/i);
    expect(step("check_billing")).toMatch(/billing/i);
    expect(step("check_credentials")).toMatch(/credentials/i);
    expect(step("contact_support")).toMatch(/support/i);
    expect(step("unknown")).toBeUndefined();
  });
});

describe("supportLineOf", () => {
  it("gives the run id, the error type and when the run ended", () => {
    expect(supportLineOf("run_x", failureOf(llmCompletion))).toBe(
      "Run run_x · LLMCompletionError · ended 2026-09-23T15:16:37.856067+00:00",
    );
  });

  it("gives what is known of a run with no report", () => {
    expect(supportLineOf("run_x", undefined, "2026-09-24T10:38:04Z")).toBe(
      "Run run_x · ended 2026-09-24T10:38:04Z",
    );
    expect(supportLineOf("run_x", undefined)).toBe("Run run_x");
  });
});

describe("failureSummaryLines", () => {
  it("says why, what to do, whether to retry and what to give support", () => {
    const failure = failureOf(llmCompletion);

    expect(failureSummaryLines(failure.run_id, "FAILED", failure)).toEqual([
      "Run `run_aa422fd5-59ef-4801-a585-09e6a961e80f` ended FAILED.",
      `Why: LLM completion — ${failure.message ?? ""}`,
      "What to do: The provider rejected the request — review the prompt, parameters, and inputs.",
      "Retry: The report does not expect running it again unchanged to help.",
      "For support: Run run_aa422fd5-59ef-4801-a585-09e6a961e80f · LLMCompletionError · ended 2026-09-23T15:16:37.856067+00:00",
    ]);
  });

  it("says a report names no next step rather than invent one", () => {
    const failure = failureOf(sandboxProvisioning);
    const lines = failureSummaryLines(failure.run_id, "FAILED", failure);

    expect(lines).toContain("What to do: the report names no next step.");
    expect(lines.join("\n")).toContain("Snapshot pipelex-base-dev is building");
  });

  it("says a run with no report has only its status, and still gives the support line", () => {
    expect(failureSummaryLines("run_x", "CANCELLED", undefined, "2026-09-24T10:38:04Z")).toEqual([
      "Run `run_x` ended CANCELLED.",
      "Why: the run stored no error report, so its status is all that is known about why it ended.",
      "For support: Run run_x · ended 2026-09-24T10:38:04Z",
    ]);
  });

  it("says the reason is unknown, not missing, when the report could not be read", () => {
    const lines = failureSummaryLines("run_x", "FAILED", undefined, undefined, false);

    expect(lines).toContain(
      "Why: unknown for now, since the run's error report could not be read; reading the run's status again returns it.",
    );
    expect(lines.join("\n")).not.toContain("stored no error report");
  });
});

describe("failureDisplayOf", () => {
  it("shows a person why, what to do and the support line, from the LLMCompletionError report", () => {
    const display = failureDisplayOf(
      llmCompletion.statusRead.pipeline_run_id,
      failureOf(llmCompletion),
    );

    expect(display).toEqual({
      reason: "LLM completion",
      nextStep: "The provider rejected the request — review the prompt, parameters, and inputs.",
      retry: "The report does not expect running it again unchanged to help.",
      support:
        "Run run_aa422fd5-59ef-4801-a585-09e6a961e80f · LLMCompletionError · ended 2026-09-23T15:16:37.856067+00:00",
    });
  });

  it("shows a person the SandboxProvisioningError report's reason and a way to get help", () => {
    const display = failureDisplayOf(
      sandboxProvisioning.statusRead.pipeline_run_id,
      failureOf(sandboxProvisioning),
    );

    expect(display).toEqual({
      reason: "Sandbox provisioning",
      nextStep: "If you need help, contact support with the line below.",
      support:
        "Run run_a23eccb6-fc93-4c30-8ba5-e6d785e1c96f · SandboxProvisioningError · ended 2026-09-24T10:38:04.285649+00:00",
    });
  });

  it("never shows a person the report's message or the provider's text", () => {
    for (const recorded of [llmCompletion, sandboxProvisioning, extractJobFailure]) {
      const text = shown(recorded);
      const report = recorded.statusRead.error;
      expect(text).not.toContain(report?.message ?? "never");
      if (report?.provider_metadata?.message) {
        expect(text).not.toContain(report.provider_metadata.message);
      }
      for (const fragment of [
        "HTTP 412",
        "not allowed for this integration",
        "Daytona",
        "openrouter",
        "Error code",
      ]) {
        expect(text).not.toContain(fragment);
      }
    }
  });

  it("says no reason was recorded for a run with no report", () => {
    expect(failureDisplayOf("run_x", undefined, "2026-09-24T10:38:04Z")).toEqual({
      reason: "No reason was recorded for this run.",
      nextStep: "If you need help, contact support with the line below.",
      support: "Run run_x · ended 2026-09-24T10:38:04Z",
    });
  });
});
