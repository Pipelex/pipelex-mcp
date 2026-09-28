import { describe, expect, it } from "vitest";

import { terminalFollowUpPrompt } from "./run-notify.js";

describe("terminalFollowUpPrompt", () => {
  it("asks for the results on a completed run, naming the run id", () => {
    expect(terminalFollowUpPrompt("run-123", "completed")).toBe(
      "Run run-123 completed — report the results.",
    );
  });

  it("asks what went wrong on a failed run, naming the run id", () => {
    expect(terminalFollowUpPrompt("run-123", "failed")).toBe(
      "Run run-123 failed — report what went wrong.",
    );
  });
});
