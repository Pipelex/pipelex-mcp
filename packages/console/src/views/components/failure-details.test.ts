import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RECORDED_FAILED_RUNS } from "@pipelex/mcp-core/capabilities/failed-run-fixtures.js";
import type { RecordedFailedRun } from "@pipelex/mcp-core/capabilities/failed-run-fixtures.js";
import { failureDisplayOf, runFailureOf } from "@pipelex/mcp-core/capabilities/run-failure.js";

import { FailureDetails } from "./failure-details.js";

/** The block both run views show a failed run in, rendered for the recorded run. */
function markupFor(recorded: RecordedFailedRun): string {
  const read = recorded.statusRead;
  const failure = runFailureOf(read.pipeline_run_id, read.error, read.finished_at);
  return renderToStaticMarkup(
    createElement(FailureDetails, {
      failure: failureDisplayOf(read.pipeline_run_id, failure),
      color: "#991b1b",
      mutedColor: "#6b7280",
      dark: false,
    }),
  );
}

/** The text a person reads, with the markup's entities decoded. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

describe("FailureDetails", () => {
  it("shows why the LLMCompletionError run failed, what to do and the line for support", () => {
    const { statusRead } = RECORDED_FAILED_RUNS.llmCompletion;
    const text = textOf(markupFor(RECORDED_FAILED_RUNS.llmCompletion));

    expect(text).toContain("Why: LLM completion");
    expect(text).toContain(
      "What to do: The provider rejected the request — review the prompt, parameters, and inputs. The report does not expect running it again unchanged to help.",
    );
    expect(text).toContain(
      `For support:Run ${statusRead.pipeline_run_id} · LLMCompletionError · ended ${statusRead.finished_at ?? ""}`,
    );
    expect(text).toContain("Copy");
  });

  it("shows why the SandboxProvisioningError run failed, and makes no retry claim", () => {
    const text = textOf(markupFor(RECORDED_FAILED_RUNS.sandboxProvisioning));

    expect(text).toContain("Why: Sandbox provisioning");
    expect(text).toContain("What to do: If you need help, contact support with the line below.");
    expect(text).toContain("SandboxProvisioningError");
    expect(text).not.toMatch(/again/i);
  });

  it("never shows the report's message or the provider's raw text", () => {
    for (const recorded of [
      RECORDED_FAILED_RUNS.llmCompletion,
      RECORDED_FAILED_RUNS.sandboxProvisioning,
    ]) {
      const text = textOf(markupFor(recorded));
      const report = recorded.statusRead.error;

      expect(text).not.toContain(report?.message ?? "never");
      for (const fragment of [
        "HTTP 412",
        "Error code",
        "not allowed for this integration",
        "Daytona",
        "Snapshot",
      ]) {
        expect(text).not.toContain(fragment);
      }
    }
  });

  it("makes the support line selectable in one click, for a frame that refuses the clipboard", () => {
    expect(markupFor(RECORDED_FAILED_RUNS.llmCompletion)).toMatch(/<code class="[^"]*select-all/);
  });
});
