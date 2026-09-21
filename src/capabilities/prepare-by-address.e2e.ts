/**
 * Live e2e — `mthds_prepare_inputs` by ADDRESS, carrying a LOCAL FILE.
 *
 * `prepare.e2e.ts` covers the two halves separately: a local file uploaded for
 * a bundle submitted as `files`, and a published address resolved with
 * `inputs: {}`. Their intersection — an address whose pipe declares a file
 * input, filled from a path on disk — is the one leg that was gated on
 * `mthds_prepare_inputs` gaining `method_ref`, and it had no coverage.
 *
 * It is the workshop arm by construction: the console refuses a local path.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildLocalToolContexts } from "../local/server.js";
import { prepareMthdsInputs } from "./prepare.js";
import type { PrepareContext } from "./prepare.js";
import { buildMthdsInputs } from "./inputs.js";
import type { InputsContext, InputsStructuredContent } from "./inputs.js";
import { PYTHON_FREE_METHOD_REF, TINY_PNG_BASE64, liveApiConfig } from "./e2e-support.js";

let workRoot: string;
let prepareContext: PrepareContext;
let inputsContext: InputsContext;
const LOCAL_ASSET = "sample.png";

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "pipelex-mcp-prepare-address-"));
  const config = liveApiConfig();
  const contexts = buildLocalToolContexts(
    { ...process.env, PIPELEX_BASE_URL: config.baseUrl, PIPELEX_API_KEY: config.apiKey },
    workRoot,
  );
  prepareContext = contexts.prepare;
  inputsContext = contexts.inputs;
  await writeFile(join(workRoot, LOCAL_ASSET), Buffer.from(TINY_PNG_BASE64, "base64"));
});

describe("mthds_prepare_inputs — by address with a local file (live)", () => {
  it("templates a published method by address and names its inputs", async () => {
    const result = await buildMthdsInputs({ method_ref: PYTHON_FREE_METHOD_REF }, inputsContext);

    expect(result.structuredContent.status).toBe("ok");
    const ok: InputsStructuredContent = result.structuredContent;
    expect(ok.is_valid).toBe(true);
    // The template is what tells the next case which input is the file
    // position and what shape to fill it with, rather than a hardcoded guess.
    expect(Object.keys(ok.inputs ?? {}).length).toBeGreaterThan(0);
  });

  it("uploads a local file for a method named only by its address", async () => {
    const template = await buildMthdsInputs({ method_ref: PYTHON_FREE_METHOD_REF }, inputsContext);
    const ok: InputsStructuredContent = template.structuredContent;
    const inputs = (ok.inputs ?? {}) as Record<string, unknown>;
    const fileInput = Object.keys(inputs)[0];
    expect(fileInput).toBeDefined();

    const result = await prepareMthdsInputs(
      {
        method_ref: PYTHON_FREE_METHOD_REF,
        // The template's own shape for a `native.Document` position: an
        // object carrying `url`, which is where the local path goes.
        inputs: { [fileInput]: { url: join(workRoot, LOCAL_ASSET) } },
      },
      prepareContext,
    );

    expect(result.structuredContent.status).toBe("ok");
    const prepared = result.structuredContent as {
      status: "ok";
      is_valid: boolean;
      uploads: string[];
      inputs: Record<string, unknown>;
    };
    expect(prepared.is_valid).toBe(true);

    // The point of the leg: the local path became a storage reference, and the
    // address alone was enough to know the input was a file position.
    expect(prepared.uploads.length).toBeGreaterThan(0);
    const filled = prepared.inputs[fileInput] as { url?: string };
    expect(filled.url).toMatch(/^pipelex-storage:\/\//);
  });
});
