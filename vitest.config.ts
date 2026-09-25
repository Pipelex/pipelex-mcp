import { defineConfig } from "vitest/config";

// One hermetic suite for the whole workspace: each package's colocated tests,
// the repository's own scripts, and the cross-package tests under `tests/`
// (the shells side by side, and the root Makefile). Workspace packages are
// resolved through the root `node_modules`, as every build resolves them.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      // `*.e2e.ts` and their shared support module are the live suite; they are
      // not shipped code and never run under this config (see vitest.e2e.config.ts).
      // `shell-test-support.ts` and `test-oauth.ts` are the shell tests' own harness.
      exclude: [
        "packages/*/src/**/*.test.{ts,tsx}",
        "packages/*/src/**/*e2e*",
        "packages/core/src/shell-test-support.ts",
        "packages/console/src/hosted/test-oauth.ts",
        "**/dist/**",
        "coverage/**",
      ],
    },
  },
});
