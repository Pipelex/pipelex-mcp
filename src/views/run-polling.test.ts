import { describe, expect, it } from "vitest";

import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  PipelineRequestError,
  RunLifecycleUnavailableError,
} from "@pipelex/sdk";

import type { ToolError } from "../capabilities/shared.js";
import { classifyError, DEFAULT_API_URL } from "../capabilities/shared.js";
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
  // Drive the errors through the real classifyError so the projection and the
  // predicate are tested together — the transient/hard verdict is decided
  // where the concrete SDK error is still known, not re-derived by the view.
  const apiResponse = (status: number, serverMessage: string): ApiResponseError =>
    new ApiResponseError(
      `HTTP ${status}`,
      `${DEFAULT_API_URL}/v1/runs/x/status`,
      status,
      "Status Text",
      "{}",
      "error_type",
      serverMessage,
      undefined, // validationErrors
      undefined, // code
    );

  it("treats an unreachable API as transient — the run itself is unaffected", () => {
    const error = classifyError(
      new ApiUnreachableError("connection refused", DEFAULT_API_URL, "ECONNREFUSED"),
    );

    expect(isTransientPollError(error)).toBe(true);
  });

  it("treats an API server fault (5xx) as transient", () => {
    expect(isTransientPollError(classifyError(apiResponse(500, "Server fault")))).toBe(true);
  });

  it("treats unknown faults as transient", () => {
    expect(isTransientPollError(classifyError(new Error("boom")))).toBe(true);
  });

  it("treats a missing run lifecycle as hard — retrying cannot grow the routes", () => {
    const error = classifyError(
      new RunLifecycleUnavailableError("run lifecycle not served", DEFAULT_API_URL),
    );

    expect(isTransientPollError(error)).toBe(false);
  });

  it("treats a completed run missing its main output as hard", () => {
    const error = classifyError(
      new MissingMainStuffError("Completed run 'x' returned no main stuff.", "x"),
    );

    expect(isTransientPollError(error)).toBe(false);
  });

  it("treats request-construction failures as hard", () => {
    expect(isTransientPollError(classifyError(new PipelineRequestError("bad base URL")))).toBe(
      false,
    );
  });

  it("treats auth failures as hard", () => {
    expect(isTransientPollError(classifyError(apiResponse(401, "Missing key")))).toBe(false);
  });

  it("treats an unknown run id as hard", () => {
    const error = classifyError(apiResponse(404, "Run not found"), {
      route: "/v1/runs/{id}/status",
      notFound: { location: "run_id", hint: "Check the run id." },
    });

    expect(isTransientPollError(error)).toBe(false);
  });

  it("treats an error without a retryable verdict as hard", () => {
    const fallback = { class: "runtime", message: "produced no verdict" } as ToolError;

    expect(isTransientPollError(fallback)).toBe(false);
  });
});
