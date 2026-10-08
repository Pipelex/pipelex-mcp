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
 */

import { existsSync } from "node:fs";

import { defineConfig } from "vitest/config";

// Parity with `npm run smoke`, which reaches `.env` through Node's
// `--env-file-if-exists`: a bare `npm run test:e2e` gets the same convenience,
// while `make test-e2e` keeps deciding the target. `loadEnvFile` shares
// `--env-file`'s precedence — it never overrides an inherited variable — so the
// Make target's resolved values still win, and the test workers inherit them.
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  test: {
    include: ["src/**/*.e2e.ts"],
    environment: "node",
    // A cold hosted API answers in seconds, not milliseconds, and the run suite
    // polls a durable execution to a terminal state.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // No retries, deliberately. A test that passes on the second attempt hides
    // exactly the intermittent contract break this suite exists to surface.
    retry: 0,
  },
});
