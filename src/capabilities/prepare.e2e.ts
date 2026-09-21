/**
 * Live e2e — `mthds_prepare_inputs` against a real Pipelex API, both arms.
 *
 * The two arms are two different code paths that must stay different: the
 * workshop (`allowUpload: true`) delegates the upload walk to the SDK, while
 * the hosted console runs its own pass-through-only walk that must never reach
 * `readLocalPath` on a public endpoint. Only a live call proves the first one
 * really uploads (rewriting the value to `pipelex-storage://`) and that the
 * second still refuses before any filesystem read.
 *
 * The workshop arm costs storage, not inference: it uploads one 1x1 PNG.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURE_INPUT_NAME,
  IMAGE_BUNDLE,
  IMAGE_BUNDLE_URI,
  IMAGE_INPUT_NAME,
  IMAGE_PIPE_REF,
  PASS_THROUGH_URL,
  TINY_PNG_BASE64,
  apiAdvertisesExtension,
  fixtureMethodId,
  liveApiConfig,
  PYTHON_FREE_METHOD_REF,
} from "./e2e-support.js";
import { prepareMthdsInputs } from "./prepare.js";
import type { PrepareContext } from "./prepare.js";

/** Does this deployment resolve `method_id` / `method_ref` server-side? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const imageFiles = [{ content: IMAGE_BUNDLE, uri: IMAGE_BUNDLE_URI }];

/** The local workshop: it holds the user's own key and may upload their files. */
const workshopContext: PrepareContext = { ...liveApiConfig(), allowUpload: true };

/** The hosted console: pass-through only. `allowUpload` defaults to false. */
const consoleContext: PrepareContext = liveApiConfig();

let workingDir: string;
let imagePath: string;

beforeAll(async () => {
  workingDir = await mkdtemp(path.join(tmpdir(), "pipelex-mcp-e2e-"));
  imagePath = path.join(workingDir, "tiny.png");
  await writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
});

afterAll(async () => {
  await rm(workingDir, { recursive: true, force: true });
});

describe("mthds_prepare_inputs — workshop arm (live)", () => {
  it("uploads a local file and rewrites the input to a pipelex-storage reference", async () => {
    const result = await prepareMthdsInputs(
      { files: imageFiles, inputs: { [IMAGE_INPUT_NAME]: imagePath } },
      workshopContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);

    const uploads = result.structuredContent.uploads ?? [];
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatch(/^pipelex-storage:\/\//);

    // The rewritten value is canonical file content — an object carrying `url`,
    // which is also the shape the template-guided walk classifies on.
    const prepared = result.structuredContent.inputs?.[IMAGE_INPUT_NAME] as
      | Record<string, unknown>
      | undefined;
    expect(prepared).toBeDefined();
    expect(prepared?.url).toBe(uploads[0]);
  });
});

describe("mthds_prepare_inputs — console arm (live)", () => {
  it("passes an http(s) reference through untouched and uploads nothing", async () => {
    const result = await prepareMthdsInputs(
      {
        files: imageFiles,
        pipe_ref: IMAGE_PIPE_REF,
        inputs: { [IMAGE_INPUT_NAME]: PASS_THROUGH_URL },
      },
      consoleContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.pipe_ref).toBe(IMAGE_PIPE_REF);
    expect(result.structuredContent.uploads).toEqual([]);

    const prepared = result.structuredContent.inputs?.[IMAGE_INPUT_NAME] as
      | Record<string, unknown>
      | undefined;
    expect(prepared?.url).toBe(PASS_THROUGH_URL);
  });

  it("refuses a local path up front, naming the workshop that can upload it", async () => {
    const result = await prepareMthdsInputs(
      { files: imageFiles, inputs: { [IMAGE_INPUT_NAME]: imagePath } },
      consoleContext,
    );

    // Refused as a no-verdict BEFORE any upload or filesystem read — on a public
    // endpoint that read would be an LFI / existence-oracle surface.
    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("inputs");
    expect(error?.retryable).toBe(false);
    expect(error?.hint).toContain("npx @pipelex/mcp");
    expect(result.structuredContent.uploads).toBeUndefined();
  });
});

/**
 * GATED on the live API, not on a date: the `method_ref` and `method_id` legs
 * are server pass-throughs on `POST /v1/validate` (the route the signature
 * comes from), so a deployment that resolves neither has nothing to exercise.
 *
 * These legs deliberately submit **no inputs**. The point they prove is the one
 * the unit suite cannot reach: that the selector really is forwarded, that the
 * route really resolves it, and that the input-form descriptor really comes
 * back — a signature that did not resolve, or a report with no descriptor, both
 * fail here as a no-verdict. What the walk then does with a value is the unit
 * suite's job, and does not need a published method to prove.
 */
describe.skipIf(!SERVES_SELECTORS)("mthds_prepare_inputs — by selector (live)", () => {
  it("resolves a published method by address on the workshop arm", async () => {
    const result = await prepareMthdsInputs(
      { method_ref: PYTHON_FREE_METHOD_REF, inputs: {} },
      workshopContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.uploads).toEqual([]);
  });

  it("resolves a published method by address on the console arm", async () => {
    // The console reads the descriptor itself, so this is also the live proof
    // that `views: ["input_form"]` is served for an address-resolved method.
    const result = await prepareMthdsInputs(
      { method_ref: PYTHON_FREE_METHOD_REF, inputs: {} },
      consoleContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    expect(result.structuredContent.uploads).toEqual([]);
  });

  it("prepares a stored method by id, with no client-side closure expansion", async () => {
    const methodId = await fixtureMethodId();
    const result = await prepareMthdsInputs(
      { method_id: methodId, inputs: { [FIXTURE_INPUT_NAME]: "otters" } },
      workshopContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    expect(result.structuredContent.is_valid).toBe(true);
    // A Text input at no file position: untouched, and nothing uploaded.
    expect(result.structuredContent.inputs).toEqual({ [FIXTURE_INPUT_NAME]: "otters" });
    expect(result.structuredContent.uploads).toEqual([]);
  });

  it("refuses a second selector before anything reaches the wire", async () => {
    const result = await prepareMthdsInputs(
      { files: imageFiles, method_ref: PYTHON_FREE_METHOD_REF, inputs: {} },
      workshopContext,
    );

    expect(result.structuredContent.status).toBe("error");
    expect(result.structuredContent.errors?.[0]?.class).toBe("input_domain");
    expect(result.structuredContent.errors?.[0]?.location).toBe("method_ref");
  });
});
