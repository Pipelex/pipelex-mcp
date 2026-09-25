import { defineConfig } from "tsup";

// The workshop's executable, `dist/main.js`, the one file the npm tarball ships
// besides the README and the licence. tsup leaves external exactly what this
// package's `dependencies` name and inlines everything else it reaches, which
// is how the private `@pipelex/mcp-core` (a devDependency) ends up inside the
// bundle while its own runtime dependencies stay installable packages: the core
// declares them, and this package declares them again, with the same ranges, so
// every `npx @pipelex/mcp` install resolves them. `tests/workspace-manifests.test.ts`
// holds the two lists together.
export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
