import { defineConfig } from "tsup";

// The workshop's executable, `dist/main.js`, the one file the npm tarball ships
// besides the README and the licence. tsup leaves external exactly what
// `package.json`'s `dependencies` name, which every `npx @pipelex/mcp` install
// resolves, and inlines everything else it reaches: the capabilities under
// `src/capabilities/` and the graph page's embed serializer from the
// devDependency `@pipelex/mthds-ui`. A runtime import of a package that is not
// declared therefore still builds, inlined without a word, which is why
// `.claude/rules/manifests.md` asks where each new package belongs.
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
