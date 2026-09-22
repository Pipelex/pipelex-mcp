/**
 * Live e2e — `mthds_prepare_inputs` by ADDRESS, carrying a LOCAL FILE.
 *
 * `prepare.e2e.ts` covers the two halves separately: a local file uploaded for
 * a bundle submitted as `files`, and a published address resolved with
 * `inputs: {}`. Their intersection — an address whose pipe declares a file
 * input, filled from a path on disk — is the leg that had no coverage.
 *
 * It is the workshop arm by construction: the console refuses a local path.
 *
 * The file position is discovered through `POST /v1/validate` — the route
 * {@link PYTHON_FREE_METHOD_REF} is reserved for, and the one
 * `mthds_prepare_inputs` reads its own signature from. The BUILD route is
 * deliberately not used here even though a template would also name the slot:
 * `documents@v0.1.0` declares its entry pipe in `METHODS.toml` alone, and a
 * deployment whose pin predates the manifest-aware build routes refuses it a
 * template, which would fail this suite for a reason that is not drift.
 * `inputs.e2e.ts` covers template-by-address with the constant that suits that
 * route; the reservation is written once on each constant in `e2e-support.ts`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildLocalToolContexts } from "../local/server.js";
import { prepareMthdsInputs } from "./prepare.js";
import type { PrepareContext } from "./prepare.js";
import { validateMthds } from "./validate.js";
import type { MainPipeInputSignature, ValidationContext } from "./validate.js";
import {
  PYTHON_FREE_METHOD_REF,
  TINY_PNG_BASE64,
  apiAdvertisesExtension,
  liveApiConfig,
} from "./e2e-support.js";

/** Does this deployment resolve `method_id` / `method_ref` server-side? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

let workRoot: string;
let prepareContext: PrepareContext;
let validationContext: ValidationContext;
const LOCAL_ASSET = "sample.png";

/**
 * The published method's declared inputs, read from the address alone.
 *
 * This is the live proof the next case rests on: the slot it fills is the one
 * the server said exists, not a name hardcoded here that would keep passing
 * after the published package moved.
 */
async function publishedInputs(): Promise<MainPipeInputSignature[]> {
  const result = await validateMthds({ method_ref: PYTHON_FREE_METHOD_REF }, validationContext);

  expect(result.structuredContent.status).toBe("ok");
  expect(result.structuredContent.is_valid).toBe(true);
  const mainPipe = result.structuredContent.main_pipe;
  expect(mainPipe).toBeDefined();
  return (mainPipe as { inputs: MainPipeInputSignature[] }).inputs;
}

/** The slot a local file goes in — a Document or Image position, else the first. */
function fileSlotOf(inputs: MainPipeInputSignature[]): MainPipeInputSignature {
  return inputs.find((input) => /Document|Image/.test(input.concept_ref)) ?? inputs[0];
}

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "pipelex-mcp-prepare-address-"));
  const config = liveApiConfig();
  const contexts = buildLocalToolContexts(
    { ...process.env, PIPELEX_BASE_URL: config.baseUrl, PIPELEX_API_KEY: config.apiKey },
    workRoot,
  );
  prepareContext = contexts.prepare;
  validationContext = contexts.validation;
  await writeFile(join(workRoot, LOCAL_ASSET), Buffer.from(TINY_PNG_BASE64, "base64"));
});

/**
 * GATED on the live API, not on a date: the address rides `POST /v1/validate`
 * as a server pass-through, which a deployment on the pre-selector platform
 * build answers as a request-shape error — a failure that is not drift. The
 * probe asks `/v1/version`; see `apiAdvertisesExtension`. Production is such a
 * deployment today, so without this gate a run aimed there fails rather than
 * skipping, which every sibling by-selector leg treats as a skip.
 */
describe.skipIf(!SERVES_SELECTORS)(
  "mthds_prepare_inputs — by address with a local file (live)",
  () => {
    it("names a published method's inputs from its address alone", async () => {
      const inputs = await publishedInputs();

      expect(inputs.length).toBeGreaterThan(0);
      // The slot the next case fills — named by the server, not guessed here.
      expect(fileSlotOf(inputs).name).toBeTruthy();
    });

    it("uploads a local file for a method named only by its address", async () => {
      const slot = fileSlotOf(await publishedInputs());

      const result = await prepareMthdsInputs(
        {
          method_ref: PYTHON_FREE_METHOD_REF,
          // The shape a file position takes: an object carrying `url`, which
          // is where the local path goes.
          inputs: { [slot.name]: { url: join(workRoot, LOCAL_ASSET) } },
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

      // The point of the leg: the local path became a storage reference, and
      // the address alone was enough to know the input was a file position.
      expect(prepared.uploads.length).toBeGreaterThan(0);
      const filled = prepared.inputs[slot.name] as { url?: string };
      expect(filled.url).toMatch(/^pipelex-storage:\/\//);
    });
  },
);
