---
paths:
  - "package.json"
  - "packages/*/package.json"
---

# What each package declares

**Each package's `dependencies` carries exactly what its own entrypoint reaches at run time, and nothing else.** `tests/workspace-manifests.test.ts` holds the rules below that can be tested; the rest are judgment. The account of why is `docs/architecture.md` → "What each package declares".

- **The workshop (`@pipelex/mcp`) is the only public package, and every `npx @pipelex/mcp` user downloads its whole `dependencies` closure.** It declares only what its bundle leaves external — `@modelcontextprotocol/sdk`, `@pipelex/sdk`, `mthds` and `zod` — and nothing of the console's.
- **The core is a devDependency of both servers and is inlined by both builds.** tsup externalizes only a package's `dependencies` and `peerDependencies`, so the core's source lands in the workshop's `dist/main.js` and its imports resolve from the workshop's manifest: the workshop re-declares every runtime dependency of the core at the same range.
- **`skybridge` belongs to the console alone.** As a dependency of the published package it put its non-optional peers (`react`, `react-dom`, `vite`, `nodemon`, `@skybridge/devtools`) into every workshop install. The console's build toolchain (`vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `alpic`, `@skybridge/devtools`) stays in its devDependencies.
- **A package named in several manifests carries one range everywhere.**
- **`@pipelex/mthds-form` is never declared.** It is a dependency of `@pipelex/mthds-ui` and is reached through `@pipelex/mthds-ui/form`; a direct entry installs a second copy whose React contexts split from the first.
- **`mthds` is a direct dependency on purpose**: the core imports `mthds/protocol`, so the core and the workshop that inlines it both declare it, rather than letting the version arrive transitively through `@pipelex/sdk`.
- **A runtime import of an undeclared package still builds green in the workshop**, because tsup inlines whatever is not external. When you add a package, decide which entrypoint reaches it and put it in that manifest.
- **The console never resolves a workspace package at run time**: it starts from `dist/server.bundle.js`, which `check:bundle` boots from an empty directory. Start it any other way and it crashes on Alpic.
- **Never commit a `file:` link.** `make use-local-sdk` / `make use-local-ui` install one for local development into the members that declare the package, never into the root, and `make check` refuses to run while one is in place. Bump the `^x.y.z` range once the upstream change is published, through the `bump-sdks` skill.
