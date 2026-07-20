import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/local/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist/local",
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
