/**
 * Live e2e — the input walk `pipelex_run` performs on the console, against a
 * real Pipelex API.
 *
 * The console has no prepare tool: `pipelex_run` reads the method's signature
 * itself and walks the inputs pass-through only, because on a public endpoint
 * the SDK's own walk would reach `readLocalPath` for a value at a file
 * position. Only a live call proves the signature it reads really comes back
 * with the input-form descriptor, and that the refusal still fires before any
 * filesystem read.
 *
 * Free: it calls `POST /v1/validate` and starts nothing, uploads nothing.
 */

import { describe, expect, it } from "vitest";

import { prepareConsoleInputs } from "./console-inputs.js";
import type { ConsoleInputsRequest } from "./console-inputs.js";
import {
  FIXTURE_INPUT_NAME,
  IMAGE_BUNDLE,
  IMAGE_BUNDLE_URI,
  IMAGE_INPUT_NAME,
  IMAGE_PIPE_REF,
  PASS_THROUGH_URL,
  PYTHON_FREE_METHOD_REF,
  apiAdvertisesExtension,
  fixtureMethodId,
  liveApiConfig,
} from "./e2e-support.js";
import { createPipelexApiClient } from "./shared.js";

/** Does this deployment resolve `method_id` / `method_ref` server-side? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const client = createPipelexApiClient(liveApiConfig());

/** The image fixture as inline files: the walk keeps that arm for exactly this. */
const imageSelector: ConsoleInputsRequest["selector"] = {
  files: [{ content: IMAGE_BUNDLE, source: IMAGE_BUNDLE_URI }],
};

describe("the console's input walk (live)", () => {
  it("passes an http(s) reference through untouched", async () => {
    const outcome = await prepareConsoleInputs(client, {
      selector: imageSelector,
      pipe_ref: IMAGE_PIPE_REF,
      inputs: { [IMAGE_INPUT_NAME]: PASS_THROUGH_URL },
    });

    expect(outcome.ok).toBe(true);
    const prepared = outcome.ok
      ? (outcome.inputs[IMAGE_INPUT_NAME] as Record<string, unknown> | undefined)
      : undefined;
    expect(prepared?.url).toBe(PASS_THROUGH_URL);
  });

  it("refuses a local path up front, naming the console's attachment tool", async () => {
    const outcome = await prepareConsoleInputs(client, {
      selector: imageSelector,
      inputs: { [IMAGE_INPUT_NAME]: "/etc/hosts" },
    });

    // Refused BEFORE any upload or filesystem read — on a public endpoint that
    // read would be an LFI / existence-oracle surface.
    expect(outcome.ok).toBe(false);
    const error = outcome.ok ? undefined : outcome.error;
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("inputs");
    expect(error?.retryable).toBe(false);
    expect(error?.hint).toContain("pipelex_upload_attachments");
  });
});

/**
 * GATED on the live API, not on a date: the selector legs are server
 * pass-throughs on `POST /v1/validate`, so a deployment that resolves neither
 * has nothing to exercise.
 */
describe.skipIf(!SERVES_SELECTORS)("the console's input walk — by selector (live)", () => {
  it("reads the signature of a published method by address", async () => {
    // `/v1/validate` resolves an address through the execution-locus gate, so
    // this is the Python-free package (see `PYTHON_FREE_METHOD_REF`).
    const outcome = await prepareConsoleInputs(client, {
      selector: { method_ref: PYTHON_FREE_METHOD_REF },
      inputs: {},
    });

    expect(outcome).toEqual({ ok: true, inputs: {} });
  });

  it("reads the signature of a saved method by id", async () => {
    const methodId = await fixtureMethodId();
    const outcome = await prepareConsoleInputs(client, {
      selector: { method_id: methodId },
      inputs: { [FIXTURE_INPUT_NAME]: "otters" },
    });

    // A Text input at no file position: untouched.
    expect(outcome).toEqual({ ok: true, inputs: { [FIXTURE_INPUT_NAME]: "otters" } });
  });
});
