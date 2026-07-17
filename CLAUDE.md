# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Workspace-level guidance lives in `../CLAUDE.md` (Pipelex multi-repo workspace). This file covers only what is specific to `pipelex-mcp`.

## What this repo is

`pipelex-mcp` is a **Skybridge MCP server** that exposes local MTHDS validation and inputs projection to MCP hosts (ChatGPT, Claude, etc.). It registers the MCP tools `mthds_validate` and `mthds_inputs_template`, which an assistant that already holds `.mthds` file contents calls to get a stable, structured validation verdict it can use to explain and repair diagnostics, and a fill-in template of a pipe's declared inputs it can populate for a run. On a positive validation verdict the `mthds_validate` tool ships a Skybridge view, `run-graph`, that renders the method graph interactively with `@pipelex/mthds-ui`'s `GraphViewer`; `mthds_inputs_template` is a plain tool with no view.

It is a thin MCP front-end over the existing Pipelex validation stack — it does no validation itself. It forwards file contents to a **Pipelex API** (`POST /v1/validate`, `POST /v1/build/inputs`) through the `PipelexApiClient` from the `@pipelex/sdk` npm package (published from `../pipelex-sdk-js`), then projects the API's reports into MCP output. `@pipelex/sdk` is the Pipelex hosted-platform SDK — the same one `pipelex-app` uses, and the only one carrying the durable run lifecycle the later run-backed tools need; it re-exports the open `mthds/protocol` surface, so the MCP imports one SDK.

`SPEC.md` is the source of truth for product requirements and design decisions — read and update it when changing behavior. `AGENTS.md` mandates using the **`skybridge` skill** when planning or updating this codebase; do so.

## Commands

Use the `Makefile` (wraps the npm scripts):

- `make check` (= `npm run check`) — lint + format:check + build + typecheck. The pre-flight gate; run before declaring work done. **`build` runs before the standalone `typecheck`** on purpose: Skybridge regenerates the view-name registry (`.skybridge/views.d.ts`, gitignored) as `build`'s first step, and `tsc` needs it to resolve `mthds_validate`'s `view.component`. A cold `typecheck` with no prior `build`/`dev` won't know the view name.
- `make test` / `make t` — Vitest run.
- `make all` — clean + check + test.
- `make dev` — Skybridge dev server. MCP endpoint at `http://localhost:3000/mcp`, DevTools UI at `http://localhost:3000`.
- `make deploy` — deploy via Alpic (`alpic deploy`).

Run a single test with Vitest directly: `npx vitest run src/capabilities/validate.test.ts` or filter by name with `npx vitest run -t "projects pending signatures"`.

### Running against the validation API

The tool needs a reachable Pipelex API serving `POST /v1/validate`. During early development this is the **local OSS `pipelex-api`** runner (temporary — production target is the hosted Pipelex API only):

```bash
cd ../pipelex-api && make run      # serves http://localhost:8081
PIPELEX_BASE_URL=http://localhost:8081 npm run dev
```

- `PIPELEX_BASE_URL` defaults to the hosted Pipelex API (`https://api.pipelex.com`) when unset; set it to `http://localhost:8081` to develop against the local OSS runner.
- `PIPELEX_API_KEY` is optional — set it only when the configured API requires auth. Local dev normally runs without it.
- Both variables can live in a gitignored `.env` at the repo root instead of prefixing the command: `nodemon.json` overrides Skybridge's default dev exec with `tsx --env-file-if-exists=.env src/server.ts` (keep its `watch`/`ext` in sync with Skybridge's defaults — a `nodemon.json` replaces them entirely, not additively). `.env` is dev-only and not watched — restart the dev server after editing it.

### CI

GitHub Actions under `.github/workflows/` (ported from the sibling TS repos, minus the npm-publish and CLA pieces that don't apply here):

- `quality-checks.yml` — on every PR, runs `npm ci` then `make all` (the same gate as local). Meant to be a required status check on `main`.
- `guard-branches.yml` — enforces the `work-branch → dev → release/vX.Y.Z → main` flow: **only a `release/vX.Y.Z` branch may target `main`** (`dev` no longer can — it's promoted *into* the release branch instead), and work branches must be prefixed (`fix/`, `feature/`, `refactor/`, `chore/`, `docs/`, `ci-cd/`, `changelog/`, `codex/`).
- `version-check.yml` — on PRs into `main` or a `release/vX.Y.Z` branch: asserts `package.json`'s `version` equals the `X.Y.Z` in the release branch name and (for `main`) is strictly greater than `main`'s current version.
- `changelog-check.yml` — on a release PR into `main`: asserts `CHANGELOG.md` has a `## [X.Y.Z]` entry (no `v` prefix in the heading — the `v` lives on the branch name and the git tag only).

The `release/vX.Y.Z` branch, the version bump, the changelog finalization, and the PR are produced by the **`/release` skill** (`.claude/skills/release/`) — run it to cut a release rather than hand-assembling these. Deployment stays out of CI — it goes through `make deploy` (`alpic deploy`) / Alpic's own git integration.

## Architecture

The whole server is a handful of small files under `src/`:

- `server.ts` — constructs the `McpServer`, registers the tools (schemas + annotations + the `run-graph` view on `mthds_validate` + OpenAI invocation labels), and wires the handlers to `validateMthds` / `buildMthdsInputs`. `export default await server.run()` is the entrypoint; `AppType` is the typed server handle.
- `capabilities/shared.ts` — the plumbing both capabilities share: the submitted-files input schema (`uri` provenance on the MCP surface), the `ToolError` model, request-shape validation (`validateRequest`), env-derived API config (`buildApiConfig` — `PIPELEX_BASE_URL`/`PIPELEX_API_KEY`), and `classifyError`. `classifyError` takes per-route `ClassifyErrorOptions` (the 400/422 locator/hint and the route named in the 404 hint) so each capability points the agent at its own knobs.
- `capabilities/validate.ts` — the validation logic. Zod input/output schemas, the API call (`validateFiles`), and projection of the API report into MCP `structuredContent` + the view-only `_meta` graph payload (`toolResult`).
- `capabilities/inputs.ts` — the inputs-template logic. Zod input/output schemas (`pipe_ref?`, `explicit?` default false, `format?` default json), the API call (`buildInputs`, adapting the MCP `uri` provenance label to the build envelope's `source`), and projection of the report into `structuredContent` plus a composed Markdown summary that includes the template in a fenced code block (the build routes return a plain `message`, not `rendered_markdown`). No view, no `_meta`.
- `helpers.ts` — `generateHelpers<AppType>()` exposes `useToolInfo`/`useCallTool` for the views.
- `views/run-graph.tsx` — the **run-graph** Skybridge view, registered on `mthds_validate`. It is the generic renderer for a method's run graph, deliberately **not** named after the validation trigger: today it shows the **dry-run graph** (`mthds_validate` feeds it the method structure from the validation dry run); a future `mthds_run` can register the same component for a **live-run graph** (with execution status). It reads the verdict from `useToolInfo` (`output`) and the graph from `responseMetadata.graph_spec` (the view-only `_meta` channel), then renders it with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview + a `useDisplayMode` fullscreen toggle, sized from `useLayout`). It falls back to a compact empty state for invalid / no-graph / `include_graph: false` results. Being a registered view, it also satisfies Skybridge's "≥1 view entry" production-build requirement (the old `build-placeholder.tsx` is gone). The renderer name (`run-graph`) is the durable family; the `available_view_specs` kinds (`dry_run_graph`, later `live_run_graph`) name the content variant it's fed.

### The output streams (contract vs presentation vs view)

This mirrors the workspace's "format follows consumer" rule — read `../CLAUDE.md` → "Surface output conventions". A tool result carries up to three independent streams (`mthds_validate` uses all three; `mthds_inputs_template` has no view, so it uses the first two):

- **`structuredContent`** — the machine contract the model reads. A machine consumer branches on these fields, never on transport.
- **`content` text** — the human/LLM-readable Markdown summary. For `mthds_validate` it is the API's `rendered_markdown` (with a short `## Views` note appended when a renderable view is available — see below) and is deliberately **not duplicated** into `structuredContent`. For `mthds_inputs_template` the capability composes it (the build routes return a plain `message`) and deliberately **does** repeat the template in a fenced code block — the template is the small payload the model must read, not a large view artifact.
- **`_meta`** — large, view-only data that **never reaches the model's context**. The graph (`_meta.graph_spec`) rides here so the agent acts on the verdict + Markdown summary, never the raw spec; the `run-graph` view reads it back via `responseMetadata.graph_spec`. `_meta` still travels on the raw MCP result, so a non-LLM programmatic consumer can read it off the wire — it is withheld from the model, not from the transport. Because the model never sees `_meta`, `structuredContent.available_view_specs` is its structured signal a view exists to surface: it lists the renderable view kinds. The only kind for now is `"dry_run_graph"` — the method graph from the validation dry run, whose spec is the one riding `_meta.graph_spec`. (The view-kind identifier and the `_meta` key are intentionally distinct: the key mirrors the API's `graph_spec` field and the view's `responseMetadata.graph_spec` reader, while the identifier names what kind of view it drives.)

### Verdict vs no-verdict (the `status` discriminator)

A *produced* verdict is always `status: "ok"`, regardless of whether the bundle passed — discriminate on `is_valid` (and, for validation, `is_runnable`). This discipline is shared by both tools: an unresolvable closure on `mthds_inputs_template` is a produced `is_valid: false` verdict with `validation_errors[]`, exactly like an invalid bundle on `mthds_validate`. `status: "error"` is reserved for **"no verdict could be produced"**: bad request shape, unreachable/misconfigured API, or a runtime fault. Those carry an `errors[]` array, each tagged with an `ErrorClass`:

- `input_domain` — the submitted request is wrong (empty `files`, blank `uri`, blank `pipe_ref`, API 400/422 — which on `/v1/build/inputs` includes an unknown `pipe_ref` and an unresolvable `main_pipe` default).
- `config` — environment/auth is wrong (`PIPELEX_BASE_URL`/`PIPELEX_API_KEY`, API unreachable, 401/403/404).
- `runtime` — unexpected server-side fault (API 5xx, unknown errors, a reachable-but-malformed report).

`classifyError` (in `capabilities/shared.ts`) maps `@pipelex/sdk` error types (`ApiUnreachableError`, `ClientAuthenticationError`, `ApiResponseError`, `PipelineRequestError`) and HTTP statuses onto these classes; each capability passes `ClassifyErrorOptions` for its route-specific 400/422 locator/hint and 404 route name. Every `ToolError` also carries `retryable` — set here, where the concrete SDK error/HTTP status is still known, because the class+locator pair alone can't tell an unreachable API (transient) from a missing run lifecycle (permanent, same `config`@`PIPELEX_BASE_URL`) or a 5xx from a malformed report (both `runtime`); the `run-follow` view's poll loops branch on it via `isTransientPollError`. When you add a new failure mode, classify it here — including its `retryable` verdict — rather than letting it fall through to a generic `runtime` message.

### State projection rules (in `validationResult`)

- Valid + runnable → `is_valid=true`, `is_runnable=true`; the graph is returned on `ValidationResult.graphSpec` (projected onto the tool result's `_meta.graph_spec` by `toolResult`), never in `structuredContent`.
- Valid + pending signatures → `is_valid=true`, `is_runnable=false`, `pending_signatures` populated.
- Invalid produced verdict → `status="ok"`, `is_valid=false`, `validation_errors` populated.
- `include_graph` defaults to **true**; pass `false` to omit the graph from a valid report (`graphSpec` stays undefined).
- `available_view_specs` is populated from the produced graph: it holds `["dry_run_graph"]` exactly when `graphSpec != null` (valid verdict + `include_graph`), and `[]` otherwise (invalid, no graph, `include_graph: false`, error). On that same condition a `## Views` note is appended to the Markdown summary. Add a new view kind to the `viewSpecSchema` enum and set it here when its spec is produced.
- The capability always calls the API with `allowSignatures: true` and `render: ["markdown"]`. A report missing `rendered_markdown` is a hard error.

### State projection rules (in `inputsResult`)

- Valid → `is_valid=true`, resolved `pipe_ref`, echoed `format`/`explicit`, and the template on exactly one of `inputs` (json) / `inputs_toml` (toml) — the unused field is absent.
- Invalid produced verdict → `status="ok"`, `is_valid=false`, `validation_errors` populated; no `pipe_ref`, no template fields.
- The request always sends its defaults explicitly: `format: "json"`, `explicit: false` unless overridden. A valid report missing its format-selected template field is a hard error (surfaced as a `runtime` no-verdict).
- The summary is composed by the capability (title, API `message`, resolved pipe, fenced template block matching `format`).

## Testing conventions

Tests are colocated (`*.test.ts`, Node environment). Each capability is tested by **injecting a fake client** via its context's `client` field (`ValidationContext.client`, `InputsContext.client`) — the capability uses `context.client` when present and only constructs a real `PipelexApiClient` otherwise. Use this seam to test API behavior without a live `pipelex-api`. Pure projection/classification functions (`validationResult`, `inputsResult`, `classifyError`, `validateRequest`, `validateInputsRequest`) are exported specifically so they can be tested in isolation; the shared ones are covered in `shared.test.ts`.

## Conventions & gotchas

- **No backward-compatibility burden** (workspace rule) — change shapes directly; record breaking changes in `CHANGELOG.md` (and reflect the new shape in `SPEC.md`).
- **Branding:** keep MTHDS-standard concepts neutrally named inside the Pipelex-branded envelope (`bundle_blueprint`, `graph_spec`, `pipe_io_contracts`) — see `../CLAUDE.md` "Brand boundaries".
- `no-console` is an **error** in ESLint — don't leave `console.*` calls.
- The SDK dependency is the **published `@pipelex/sdk` npm package** (public on npm), not a `file:../pipelex-sdk-js` link. CI just runs `npm ci` — there is no sibling repo to check out. To develop against local `../pipelex-sdk-js` changes, `npm link ../pipelex-sdk-js` (or a local override) without committing the link, then bump the `^x.y.z` range once the change is published. `mthds` is no longer a direct dependency — it rides along transitively through `@pipelex/sdk`.
- Keep `SPEC.md`'s declared input/output shapes, the Zod schemas in `capabilities/`, and `README.md` in sync when a tool contract changes.

## Versioning & changelog

`pipelex-mcp` follows [Semantic Versioning](https://semver.org). `version` in `package.json` is the source of truth and is git-tagged (`vX.Y.Z`) on release. All notable changes are recorded in [`CHANGELOG.md`](CHANGELOG.md) using the [Keep a Changelog](https://keepachangelog.com) format.

- Work in progress accumulates under `## [Unreleased]` — don't mint a new `## [x.y.z]` heading per commit. Mint it (and the `vX.Y.Z` tag) only when you actually release that version; the newest versioned heading must then match `package.json`'s `version`. To cut a release, use the **`/release` skill** (`.claude/skills/release/`): it promotes `## [Unreleased]` to `## [x.y.z]`, bumps `package.json`, regenerates `package-lock.json`, and opens the `release/vX.Y.Z → main` PR that the CI gates expect. Note the version-string split: the `v` prefix is on the branch name, git tag, and PR title only — never in `package.json` or the `## [x.y.z]` changelog heading.
- `0.1.0` is the first tagged release. It **retires the `v0.x` prototype-increment track** (`../docs/mcp/02-delivery/v0.x-prototype-plan.md`): the milestones once called v0.1 / v0.2 / v0.3 were build increments, not package versions, and all shipped together as `0.1.0`. Use the changelog + semver from here on, not the v0.x numbering. `../docs/mcp/cold-start.md` remains the cold-start brief for resuming work; `CHANGELOG.md` is the source of truth for what has shipped.
