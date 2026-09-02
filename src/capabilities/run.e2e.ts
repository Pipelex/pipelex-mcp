/**
 * Live e2e — the durable-run family against a real Pipelex API.
 *
 * This file is split in two on cost, because the split is what keeps the whole
 * live suite safe to schedule:
 *
 *  - The FREE half always runs. Reading the status and results of a run id that
 *    does not exist still proves the two lifecycle routes are reachable and
 *    still classify the way the run-follow view's poll loops expect, and one
 *    unknown-`method_id` start proves `/v1/start` still accepts the run source
 *    the way this client sends it — all of it spending nothing. A missing
 *    lifecycle route and a mis-sent run source are the failures this catches.
 *  - The PAID half executes the fixture method for real and only runs when
 *    `PIPELEX_E2E_RUN=1` (`make test-e2e-run`). `make test-e2e` and any scheduled
 *    canary therefore cannot reach it by accident.
 */

import { describe, expect, it } from "vitest";

import {
  FIXTURE_BUNDLE,
  FIXTURE_BUNDLE_URI,
  FIXTURE_INPUT_NAME,
  PUBLISHED_METHOD_COMMIT,
  PUBLISHED_METHOD_EXPECTED_SENTENCES,
  PUBLISHED_METHOD_EXPECTED_WORDS,
  PUBLISHED_METHOD_INPUT,
  PUBLISHED_METHOD_INPUT_NAME,
  PUBLISHED_METHOD_REF,
  apiAdvertisesExtension,
  fixtureMethodId,
  liveApiConfig,
} from "./e2e-support.js";
import { getMthdsRunResults, getMthdsRunStatus, startMthdsRun } from "./run.js";
import type { RunContext } from "./run.js";

const context: RunContext = liveApiConfig();

/** Does this deployment resolve `method_ref` server-side on `/v1/start`? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

/** A syntactically plausible id that no run answers to. */
const UNKNOWN_RUN_ID = "00000000-0000-4000-8000-000000000000";

/** A syntactically plausible id that no stored method answers to. */
const UNKNOWN_METHOD_ID = "mt_00000000-0000-4000-8000-000000000000";

const RUN_ENABLED = process.env.PIPELEX_E2E_RUN === "1";

/** Ceiling for polling one tiny single-pipe run to a terminal state. */
const POLL_DEADLINE_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

describe("run lifecycle reads (live, free)", () => {
  it("classifies an unknown run id as an input_domain no-verdict at run_id", async () => {
    const result = await getMthdsRunStatus({ run_id: UNKNOWN_RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    // `config` here would mean the lifecycle route itself is missing — the SDK
    // intercepts that as RunLifecycleUnavailableError, and it is a different
    // fix from a bad id.
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("run_id");
    expect(error?.retryable).toBe(false);
  });

  it("classifies an unknown run id the same way on the results route", async () => {
    const result = await getMthdsRunResults({ run_id: UNKNOWN_RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("run_id");
  });

  it("rejects a blank run id without calling the API", async () => {
    const result = await getMthdsRunStatus({ run_id: "   " }, context);

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
  });

  // The only free reach into `/v1/start`'s ARGUMENT PATH, and the reason it is
  // here: an unknown id is refused before anything executes, so this crosses
  // the wire for nothing while still proving the client built a request the
  // platform understood. That matters because `method_id` is a named option the
  // SDK reserves on `extra`, and it enforces that with a RUNTIME throw — so
  // sending it the wrong way compiles, passes the mocked suite, and fails every
  // real by-id run. Bumping @pipelex/sdk 0.12.0 → 0.14.0 did exactly that. A
  // `PipelineRequestError` surfacing here instead of the platform's 404 means
  // the client refused the call itself; check how `toStartOptions` passes the id.
  it("reaches the platform with method_id as a named option, and 404s on an unknown one", async () => {
    const result = await startMthdsRun({ method_id: UNKNOWN_METHOD_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("method_id");
    expect(result.structuredContent.run_id).toBeUndefined();
  });

  // GATED on the live API, not on a date: `method_ref` on `/v1/start` needs the
  // platform to forward it to the runner, and an environment on the
  // pre-selector build rejects the field as request shape — a failure that is
  // not drift. See `apiAdvertisesExtension`. The leg stays free of inference
  // credit either way: a bad address is refused before anything executes.
  it.skipIf(!SERVES_SELECTORS)(
    "reaches the platform with method_ref as the run source, and is refused on an unknown address",
    async () => {
      const result = await startMthdsRun(
        { method_ref: "github.com/Pipelex/methods/does-not-exist@v0.0.0" },
        context,
      );

      expect(result.structuredContent.status).toBe("error");
      const error = result.structuredContent.errors?.[0];
      expect(error?.class).toBe("input_domain");
      expect(error?.location).toBe("method_ref");
      expect(result.structuredContent.run_id).toBeUndefined();
    },
  );
});

/**
 * Poll a run to a terminal state, returning the last status read. Bounded by a
 * deadline so a stuck run fails as a timeout with a readable last state rather
 * than hanging until vitest kills the file.
 */
async function pollToTerminal(runId: string) {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let last = await getMthdsRunStatus({ run_id: runId }, context);

  while (last.structuredContent.is_terminal !== true && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await getMthdsRunStatus({ run_id: runId }, context);
  }

  return last;
}

describe.runIf(RUN_ENABLED)("mthds_run (live, SPENDS INFERENCE CREDIT)", () => {
  it("starts from files, reaches a terminal state, and returns a bounded result", async () => {
    const started = await startMthdsRun(
      {
        files: [{ content: FIXTURE_BUNDLE, uri: FIXTURE_BUNDLE_URI }],
        inputs: { [FIXTURE_INPUT_NAME]: "the ocean" },
      },
      context,
    );

    expect(started.structuredContent.status).toBe("ok");
    const runId = started.structuredContent.run_id;
    expect(typeof runId).toBe("string");
    expect(started.structuredContent.run_status).toBeDefined();
    if (typeof runId !== "string") return;

    const status = await pollToTerminal(runId);
    expect(status.structuredContent.status).toBe("ok");
    expect(status.structuredContent.is_terminal).toBe(true);
    expect(status.structuredContent.run_id).toBe(runId);

    const results = await getMthdsRunResults({ run_id: runId }, context);
    expect(results.structuredContent.status).toBe("ok");
    expect(results.structuredContent.state).toBe("completed");

    // The model-facing copy is bounded; the full output rides the view-only
    // channel. A single word never trips the cap, so `truncated` must be false
    // and the two copies must agree.
    expect(results.structuredContent.main_stuff).toBeDefined();
    expect(results.structuredContent.truncated).toBe(false);
    expect(results.mainStuff).toBeDefined();

    // The usage projection is run-level only — per-pipe detail stays off the
    // model-facing surface and rides `_meta`.
    const usage = results.structuredContent.usage;
    expect(usage).toBeDefined();
    expect(usage?.cost_usd === null || typeof usage?.cost_usd === "number").toBe(true);
    expect(usage?.tokens === null || typeof usage?.tokens === "number").toBe(true);
    expect(typeof usage?.calls).toBe("number");
    expect(JSON.stringify(results.structuredContent)).not.toContain("usage_by_pipe");
  });

  it("starts from a registered method id, resolved server-side", async () => {
    const started = await startMthdsRun(
      {
        method_id: await fixtureMethodId(),
        inputs: { [FIXTURE_INPUT_NAME]: "a mountain" },
      },
      context,
    );

    expect(started.structuredContent.status).toBe("ok");
    const runId = started.structuredContent.run_id;
    expect(typeof runId).toBe("string");
    if (typeof runId !== "string") return;

    const status = await pollToTerminal(runId);
    expect(status.structuredContent.status).toBe("ok");
    expect(status.structuredContent.is_terminal).toBe(true);
    // Terminal is not success: `is_terminal` is true for FAILED/TIMED_OUT/CANCELLED
    // too, so a stored fixture that has drifted from FIXTURE_BUNDLE would start
    // fine, fail in execution, and pass this leg. We paid inference for this run,
    // so assert the outcome. Keeping both assertions makes the two failures read
    // differently: `is_terminal` false means the poll deadline expired.
    expect(status.structuredContent.run_status).toBe("COMPLETED");
  });

  /**
   * The by-address leg, executed rather than merely refused — this is the one
   * assertion that a published package really runs on the platform, and that
   * the provenance an agent explains the run with is the commit that ran.
   *
   * It sits in the paid tier even though the package it runs is deterministic
   * (a PipeFunc method, no model call, no inference credit): the tier is about
   * EXECUTING, not about the bill, and `make test-e2e` stays a suite that
   * starts nothing. The package is pinned at a tag, so the resolved commit is a
   * constant the assertion can name.
   */
  it.skipIf(!SERVES_SELECTORS)(
    "runs a published method by address, and reports the commit it resolved",
    async () => {
      const started = await startMthdsRun(
        {
          method_ref: PUBLISHED_METHOD_REF,
          inputs: { [PUBLISHED_METHOD_INPUT_NAME]: PUBLISHED_METHOD_INPUT },
        },
        context,
      );

      expect(started.structuredContent.status).toBe("ok");
      const runId = started.structuredContent.run_id;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") return;

      // Provenance is what keeps a run explainable when a tag moves, so it is
      // asserted down to the SHA the tag pointed at — not merely present.
      expect(started.structuredContent.method_provenance).toEqual({
        address: "github.com/Pipelex/methods/text_stats",
        tag: "v0.1.1",
        commit_sha: PUBLISHED_METHOD_COMMIT,
      });

      const status = await pollToTerminal(runId);
      expect(status.structuredContent.is_terminal).toBe(true);
      // Terminal is not success — see the by-id leg above.
      expect(status.structuredContent.run_status).toBe("COMPLETED");

      const results = await getMthdsRunResults({ run_id: runId }, context);
      expect(results.structuredContent.state).toBe("completed");
      expect(results.structuredContent.truncated).toBe(false);

      // Read the output, not just the envelope. COMPLETED says the platform
      // finished something; it does not say the right pipe ran on the input we
      // sent. The pipe is a pure function, so its report is exact — a run that
      // executed a different pipe, or dropped the input, cannot produce these.
      const mainStuff = results.structuredContent.main_stuff as { text?: string } | undefined;
      expect(typeof mainStuff?.text).toBe("string");
      expect(mainStuff?.text).toContain(`| Words | ${PUBLISHED_METHOD_EXPECTED_WORDS} |`);
      expect(mainStuff?.text).toContain(`| Sentences | ${PUBLISHED_METHOD_EXPECTED_SENTENCES} |`);
    },
  );
});
