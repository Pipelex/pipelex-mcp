/**
 * The live end-to-end suite — the second half of this repo's drift detector.
 *
 * The default suite (`vitest.config.ts`) injects a fake client into every
 * capability, so it proves the projections and never touches the wire. These
 * files do the opposite: they build each capability's context WITHOUT a client
 * seam, so the real `PipelexApiClient` runs against a real Pipelex API and any
 * wire-shape drift shows up as a failing assertion. Selection is by suffix
 * (`*.e2e.ts`), which the default `include` (`*.test.ts`) already excludes, so
 * `make all` and CI stay hermetic without any extra exclusion.
 *
 * Run it with `make test-e2e`, which resolves the API target and key the same
 * way `make smoke` does and refuses to start without them.
 *
 * The pair and the key's expectations come from the environment alone, which
 * the workspace's `test-account run` fills; `.env` is never read, since a key
 * there would replace the one the registry hands over. The global setup checks
 * the key's account before the first case (`src/capabilities/e2e-account.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

// The live suite runs on its own pair, `PIPELEX_E2E_BASE_URL` and
// `PIPELEX_E2E_API_KEY`, never on the key the developer saved in the home
// `.env`, which the workshop reads whenever its host passes none
// (`src/credentials.ts`). Every test sees an empty home of its own instead.
const testHome = mkdtempSync(path.join(os.tmpdir(), "pipelex-mcp-e2e-home-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    globalSetup: ["src/capabilities/e2e-global-setup.ts"],
    environment: "node",
    env: { PIPELEX_HOME: testHome },
    // A cold hosted API answers in seconds, not milliseconds, and the run suite
    // polls a durable execution to a terminal state.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // No retries, deliberately. A test that passes on the second attempt hides
    // exactly the intermittent contract break this suite exists to surface.
    retry: 0,
  },
});
