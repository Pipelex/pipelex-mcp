/**
 * Live e2e — `mthds_download_artifacts` against a real Pipelex API, saving into
 * a real temp working directory.
 *
 * Split on cost like `run.e2e.ts`:
 *
 *  - The FREE half always runs: an unknown run id proves the tool still reads
 *    the run through the results route and classifies a missing one at
 *    `run_id`, and that it creates nothing on disk before it knows the run.
 *  - The PAID half executes the published `text_stats` package and saves the
 *    completed run, proving the output reaches disk byte for byte as the API
 *    holds it — the unbounded value, not the one `mthds_run_results` fits into
 *    the conversation. Like the by-address run leg, the package is a PipeFunc
 *    that buys no model call; the tier is about executing, not about the bill.
 *    Its output references no stored file, so the SDK's bulk resolve route is
 *    not reached here: a run that produces a file costs an image generation.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { downloadMthdsArtifacts } from "./artifacts.js";
import type { ArtifactsContext } from "./artifacts.js";
import {
  PUBLISHED_METHOD_INPUT,
  PUBLISHED_METHOD_INPUT_NAME,
  PUBLISHED_METHOD_REF,
  apiAdvertisesExtension,
  liveApiConfig,
  liveClient,
  pollRunToTerminal,
} from "./e2e-support.js";
import { startMthdsRun } from "./run.js";

/** Does this deployment resolve `method_ref` server-side on `/v1/start`? */
const SERVES_SELECTORS = await apiAdvertisesExtension("method_ref");

const RUN_ENABLED = process.env.PIPELEX_E2E_RUN === "1";

/** A syntactically plausible id that no run answers to. */
const UNKNOWN_RUN_ID = "00000000-0000-4000-8000-000000000000";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A context saving under a fresh temp directory, which stands in for the workshop's working directory. */
async function savingContext(): Promise<ArtifactsContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pipelex-artifacts-e2e-"));
  tempDirs.push(root);
  return { ...liveApiConfig(), saveRoot: root };
}

describe("mthds_download_artifacts (live, free)", () => {
  it("refuses an unknown run id at run_id and writes nothing", async () => {
    const context = await savingContext();

    const result = await downloadMthdsArtifacts({ run_id: UNKNOWN_RUN_ID }, context);

    expect(result.structuredContent.status).toBe("error");
    const error = result.structuredContent.errors?.[0];
    expect(error?.class).toBe("input_domain");
    expect(error?.location).toBe("run_id");
    expect(await fs.readdir(context.saveRoot!)).toEqual([]);
  });
});

describe.runIf(RUN_ENABLED)("mthds_download_artifacts (live, EXECUTES A RUN)", () => {
  it.skipIf(!SERVES_SELECTORS)(
    "saves a completed run's full output as main_stuff.json in the run's own folder",
    async () => {
      const runContext = liveApiConfig();
      const started = await startMthdsRun(
        {
          method_ref: PUBLISHED_METHOD_REF,
          inputs: { [PUBLISHED_METHOD_INPUT_NAME]: PUBLISHED_METHOD_INPUT },
        },
        runContext,
      );
      const runId = started.structuredContent.run_id;
      expect(typeof runId).toBe("string");
      if (typeof runId !== "string") return;

      const status = await pollRunToTerminal(runId, runContext);
      expect(status.structuredContent.run_status).toBe("COMPLETED");

      const context = await savingContext();
      const result = await downloadMthdsArtifacts({ run_id: runId }, context);

      const outputPath = path.join("runs", runId, "main_stuff.json");
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        run_id: runId,
        state: "completed",
        scope: "main_stuff",
        output: { path: outputPath },
        artifacts: [],
        saved_paths: [outputPath],
        all_saved: true,
      });

      // The file is the value the platform holds, read here through the SDK
      // with no bounding in between, so a pruned or retyped output cannot pass.
      const held = await liveClient().getRunResult(runId);
      expect(held.state).toBe("completed");
      if (held.state !== "completed") return;
      const written = await fs.readFile(path.join(context.saveRoot!, outputPath), "utf8");
      expect(JSON.parse(written)).toEqual(held.result.main_stuff);
      expect(result.structuredContent.output?.size).toBe(Buffer.byteLength(written));
    },
  );
});
