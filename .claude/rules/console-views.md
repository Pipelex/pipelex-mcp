---
paths:
  - "packages/console/src/views/**"
  - "packages/console/src/index.css"
  - "packages/console/scripts/check-cascade.mjs"
  - "packages/console/vite.config.ts"
  - "packages/core/src/capabilities/upload-grant-shape.ts"
  - "packages/core/src/capabilities/start-outcome.ts"
  - "packages/core/src/capabilities/run-failure.ts"
---

# The console's views and stylesheet

The views (`run-graph`, `run-follow`) render inside a host's sandboxed frame. `docs/architecture.md` has the account of each view, of the results panel and of the stylesheet; SPEC.md's "Views" section is their contract.

## Views

- **Mount every renderer under a `RenderBoundary`** (`views/components/render-boundary.tsx`): each `GraphViewer`, the output's `StuffViewer`, `RunPanel`, each view's root, and any new package renderer. A throw otherwise unmounts the whole view, and **ChatGPT drops the `null` values of a tool result it relays to a view**, so a renderer strict about `null` throws there and nowhere else.
- **A view bundles for the browser, so it imports nothing that reaches `node:fs`.** Upload code imports `@pipelex/sdk/upload`, never the SDK's main entry, and the modules a view shares with the core — `capabilities/upload-grant-shape.ts`, `capabilities/start-outcome.ts`, `capabilities/run-failure.ts`, `capabilities/tool-names.ts` — import types only or nothing, which must stay true. A view's other imports from the core must stay type-only.
- **Files paint from `_meta.resolved_urls`**, the fresh links the results carry. A reference with no fresh link falls back to the baked `public_url`, which paints only until it expires an hour after the run; the CSP allows the bucket's regional host the runtime signs it on (`hosted/app-buckets.ts`), and a link a method writes into an HTML output depends on that too, so keep both host forms. A change to the views' CSP (`connectDomains`, `resourceDomains`, `frameDomains`) is cached by ChatGPT at add time, so it needs "re-add the connector" in the release notes.
- **Keep logic out of the components, where Node tests can reach it.** Selection, stage and results logic live in the pure modules `run-graph-selection.ts`, `run-graph-stage.ts` and `run-results.ts`; the upload callback in `run-graph-upload.ts` does network work but takes it as injected dependencies, so it is tested in Node too. Add logic there, not in the components.
- **The input form's kernel, `@pipelex/mthds-form`, is never declared here.** It is reached through `@pipelex/mthds-ui/form`, which re-exports it whole (`getPipeInputForm`, `getPipeIOContract` and the types come through). A second copy in the tree splits its React contexts, and a provider above the panel then resolves to defaults inside it.

## Stylesheet

`packages/console/src/index.css` carries no `@source` glob for the kernel and imports none of its stylesheets, since `@pipelex/mthds-ui/form/react` imports its own prebuilt sheet. Three things in it are load-bearing:

- **The layer order is declared up front, whole**: `@layer properties, theme, base, components, mthds-form, utilities;`. That puts the kernel above Tailwind's preflight and below utilities. Declaring only `@layer mthds-form;` puts it under preflight too, and every control in `RunPanel` renders with no surface, because `bg-input` and `border-input` exist only inside the kernel's layer. Promoting `properties` resets every `--tw-*` on older Safari and Firefox.
- **The token bridge aliases each bare shadcn name the kernel reads (`--primary`, `--background`, …) to its `--color-*` counterpart** from `@alpic-ai/ui/theme`; `--input` and `--radius` have none and map to `--color-border` and `--radius-md`. Alias rather than copy literals. A missing token fails silently: the browser discards the declaration and the control falls back to `transparent`.
- **The one `@source`, for `@alpic-ai/ui`'s components, is a path relative to the stylesheet** (`../../../node_modules/@alpic-ai/ui/src`), because the workspace hoists the package. Tailwind drops an `@source` that names nothing without a word.

**When the form looks wrong, run `npm run check:cascade`**, which resolves the winning declaration for each property that matters. Never verify any of this by reading the layer order back out of the build: lightningcss deletes the `@layer` statement and hoists the blocks, and that check passes in the state where every control is invisible. A new kernel-only utility nobody asserts on is a gap, so extend `CHECKS` in `check-cascade.mjs` rather than trusting it wholesale.
