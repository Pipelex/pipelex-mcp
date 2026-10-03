---
paths:
  - "package.json"
  - ".worktree.toml"
  - "scripts/publish-guard.ts"
---

# What the manifest declares

**`package.json` is the package npm publishes as `@pipelex/mcp`, so its `dependencies` carry exactly what the bundle reaches at run time, and nothing else.** `tests/manifest.test.ts` holds the rules below that can be tested; the rest are judgment. The account of why is `docs/architecture.md` → "What the manifest declares".

- **Every `npx @pipelex/mcp` user downloads the whole `dependencies` closure.** It names only what the bundle leaves external — `@modelcontextprotocol/sdk`, `@pipelex/sdk`, `mthds` and `zod`.
- **tsup externalizes `dependencies` and `peerDependencies` and inlines everything else**, so a runtime import of an undeclared package still builds green, inlined without a word. When you add a package, decide whether the bundle should carry it or every install should download it.
- **`@pipelex/mthds-ui` is a devDependency**: the capabilities import only the graph page's embed serializer, which tsup inlines.
- **`@pipelex/mthds-form` is never declared.** It is a dependency of `@pipelex/mthds-ui` and is reached through `@pipelex/mthds-ui/form`; a direct entry installs a second copy whose React contexts split from the first.
- **`mthds` is a direct dependency on purpose**: the capabilities import `mthds/protocol`, so the manifest declares it rather than letting the version arrive transitively through `@pipelex/sdk`.
- **Never commit a `file:` link.** `make use-local-sdk` / `make use-local-ui` install one for local development, and `make check` refuses to run while one is in place. Bump the `^x.y.z` range once the upstream change is published, through the `bump-sdks` skill.
- **A sprint pin is written here too, and never published.** `.worktree.toml` names `package.json` as the pin site; the publish guard, the manifest's `prepublishOnly` script (`scripts/publish-guard.ts`), refuses a sprint prerelease or a git, URL or local source in any dependency block, while `make check` stays green with a pin in place. Never publish around it: collapse the pin with `make use-npm-sdk VERSION=<version>`.
