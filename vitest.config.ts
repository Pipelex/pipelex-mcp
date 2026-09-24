import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // `*.e2e.ts` and their shared support module are the live suite; they are
      // not shipped code and never run under this config (see vitest.e2e.config.ts).
      // `shell-test-support.ts` is the shell tests' own client harness.
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*e2e*",
        "src/shell-test-support.ts",
        "dist/**",
        "coverage/**",
      ],
    },
  },
});
