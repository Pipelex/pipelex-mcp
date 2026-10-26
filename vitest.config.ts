import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineConfig } from "vitest/config";

// The workshop reads the key saved in the home `.env` whenever its host passes
// none (`src/credentials.ts`), from `PIPELEX_HOME` or `~/.pipelex`. Every test
// sees an empty home of its own instead, so none reads the developer's saved
// key, above all the tests that build the server from the real environment.
const testHome = mkdtempSync(path.join(os.tmpdir(), "pipelex-mcp-test-home-"));
process.on("exit", () => rmSync(testHome, { recursive: true, force: true }));

// One hermetic suite for the whole repository: the colocated tests under
// `src/`, the repository's own scripts, and the tests under `tests/` (the
// manifest, the lint rules and the Makefile).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    env: { PIPELEX_HOME: testHome },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // `*.e2e.ts` and their shared support module are the live suite; they are
      // not shipped code and never run under this config (see vitest.e2e.config.ts).
      // `shell-test-support.ts` is the shell tests' own harness.
      exclude: [
        "src/**/*.test.ts",
        "src/**/*e2e*",
        "src/shell-test-support.ts",
        "**/dist/**",
        "coverage/**",
      ],
    },
  },
});
