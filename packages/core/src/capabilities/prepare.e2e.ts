/**
 * Live e2e — the workshop's `mthds_prepare_inputs` against a real Pipelex API.
 *
 * The workshop delegates the upload walk to the SDK, and only a live call
 * proves it really uploads, rewriting the value to `pipelex-storage://`. The
 * console has no prepare tool: `pipelex_run` walks its inputs itself, pass
 * through only, and that walk's live legs are `console-inputs.e2e.ts`.
 *
 * It costs storage, not inference: it uploads one 1x1 PNG.
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
const workshopContext: PrepareContext = liveApiConfig();

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

describe("mthds_prepare_inputs (live)", () => {
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
  it("resolves a published method by address", async () => {
    const result = await prepareMthdsInputs(
      { method_ref: PYTHON_FREE_METHOD_REF, inputs: {} },
      workshopContext,
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
