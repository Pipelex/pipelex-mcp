import { defineConfig } from "vitest/config";

// One hermetic suite for the whole workspace: each package's colocated tests,
// the repository's own scripts, and the cross-package tests under `tests/`
// (the manifests, the lint rules and the root Makefile). Workspace packages are
// resolved through the root `node_modules`, as every build resolves them.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // `*.e2e.ts` and their shared support module are the live suite; they are
      // not shipped code and never run under this config (see vitest.e2e.config.ts).
      // `shell-test-support.ts` is the shell tests' own harness.
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/*e2e*",
        "packages/core/src/shell-test-support.ts",
        "**/dist/**",
        "coverage/**",
      ],
    },
  },
});
