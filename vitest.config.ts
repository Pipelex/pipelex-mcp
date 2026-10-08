import { defineConfig } from "vitest/config";

// One hermetic suite for the whole repository: the colocated tests under
// `src/`, the repository's own scripts, and the tests under `tests/` (the
// manifest, the lint rules and the Makefile).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
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
