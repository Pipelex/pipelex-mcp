import { describe, expect, it } from "vitest";

import type { ToolError } from "../capabilities/shared.js";
import {
  INITIAL_POLL_DELAY_MS,
  MAX_POLL_DELAY_MS,
  isTransientPollError,
  nextPollDelayMs,
} from "./run-polling.js";

describe("nextPollDelayMs", () => {
  it("starts at the initial delay for a fresh run", () => {
    expect(nextPollDelayMs(0)).toBe(INITIAL_POLL_DELAY_MS);
    expect(nextPollDelayMs(29_999)).toBe(INITIAL_POLL_DELAY_MS);
  });

  it("backs off gently as elapsed grows and caps at the max delay", () => {
    const delays = [nextPollDelayMs(30_000), nextPollDelayMs(120_000), nextPollDelayMs(300_000)];
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(nextPollDelayMs(300_000)).toBe(MAX_POLL_DELAY_MS);
    expect(nextPollDelayMs(3_600_000)).toBe(MAX_POLL_DELAY_MS);
  });

  it("honors a server retry hint over the ladder", () => {
    expect(nextPollDelayMs(0, 5)).toBe(5_000);
    expect(nextPollDelayMs(3_600_000, 3)).toBe(3_000);
  });

  it("clamps server hints to sane bounds", () => {
    expect(nextPollDelayMs(0, 0)).toBe(1_000);
    expect(nextPollDelayMs(0, 999)).toBe(30_000);
  });

  it("falls back to the ladder when the hint is null or absent", () => {
    expect(nextPollDelayMs(0, null)).toBe(INITIAL_POLL_DELAY_MS);
    expect(nextPollDelayMs(0, undefined)).toBe(INITIAL_POLL_DELAY_MS);
  });
});

describe("isTransientPollError", () => {
  const error = (partial: Partial<ToolError>): ToolError => ({
    class: "runtime",
    message: "boom",
    ...partial,
  });

  it("treats runtime faults (5xx, unknown) as transient", () => {
    expect(isTransientPollError(error({ class: "runtime" }))).toBe(true);
  });

  it("treats an unreachable API as transient — the run itself is unaffected", () => {
    expect(isTransientPollError(error({ class: "config", location: "PIPELEX_BASE_URL" }))).toBe(
      true,
    );
  });

  it("treats auth failures as hard", () => {
    expect(isTransientPollError(error({ class: "config", location: "PIPELEX_API_KEY" }))).toBe(
      false,
    );
  });

  it("treats an unknown or malformed run id as hard", () => {
    expect(isTransientPollError(error({ class: "input_domain", location: "run_id" }))).toBe(false);
  });
});
