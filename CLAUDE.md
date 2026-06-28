# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Workspace-level guidance lives in `../CLAUDE.md` (Pipelex multi-repo workspace). This file covers only what is specific to `pipelex-mcp`.

## What this repo is

`pipelex-mcp` is a **Skybridge MCP server** that exposes local MTHDS validation to MCP hosts (ChatGPT, Claude, etc.). v0.1 is intentionally **tool-only**: it registers a single MCP tool, `mthds_validate`, and ships no custom Skybridge view yet. An assistant that already holds `.mthds` file contents calls the tool to get a stable, structured validation verdict it can use to explain and repair diagnostics.

It is a thin MCP front-end over the existing Pipelex validation stack — it does no validation itself. It forwards file contents to a **Pipelex API** (`POST /v1/validate`) through the `MthdsApiClient` from the `mthds` npm package (published from `../mthds-js`), then projects the API's report into MCP output.

`SPEC.md` is the source of truth for product requirements and design decisions — read and update it when changing behavior. `AGENTS.md` mandates using the **`skybridge` skill** when planning or updating this codebase; do so.

## Commands

Use the `Makefile` (wraps the npm scripts):

- `make check` (= `npm run check`) — lint + format:check + typecheck + build. The pre-flight gate; run before declaring work done.
- `make test` / `make t` — Vitest run.
- `make all` — clean + check + test.
- `make dev` — Skybridge dev server. MCP endpoint at `http://localhost:3000/mcp`, DevTools UI at `http://localhost:3000`.
- `make deploy` — deploy via Alpic (`alpic deploy`).

Run a single test with Vitest directly: `npx vitest run src/capabilities/validate.test.ts` or filter by name with `npx vitest run -t "projects pending signatures"`.

### Running against the validation API

The tool needs a reachable Pipelex API serving `POST /v1/validate`. During early development this is the **local OSS `pipelex-api`** runner (temporary — production target is the hosted Pipelex API only):

```bash
cd ../pipelex-api && make run      # serves http://localhost:8081
MTHDS_API_URL=http://localhost:8081 npm run dev
```

- `MTHDS_API_URL` defaults to `http://localhost:8081` when unset.
- `MTHDS_API_KEY` is optional — set it only when the configured API requires auth. Local dev normally runs without it.

### CI

GitHub Actions under `.github/workflows/` (ported from the sibling TS repos, minus the npm-publish and CLA pieces that don't apply here):

- `quality-checks.yml` — on every PR, runs `npm ci` then `make all` (the same gate as local). Meant to be a required status check on `main`.
- `guard-branches.yml` — enforces the `work-branch → dev → main` flow: only `dev` may target `main`, and work branches must be prefixed (`fix/`, `feature/`, `refactor/`, `chore/`, `docs/`, `ci-cd/`, `changelog/`, `codex/`).

Deployment stays out of CI — it goes through `make deploy` (`alpic deploy`) / Alpic's own git integration.

## Architecture

The whole server is four small files under `src/`:

- `server.ts` — constructs the `McpServer`, registers the one `mthds_validate` tool (schemas + annotations + OpenAI invocation labels), and wires the handler to `validateMthds`. `export default await server.run()` is the entrypoint; `AppType` is the typed server handle.
- `capabilities/validate.ts` — **all the logic.** Zod input/output schemas, request-shape validation, the API call, error classification, and projection of the API report into MCP `structuredContent`.
- `helpers.ts` — `generateHelpers<AppType>()` exposes `useToolInfo`/`useCallTool` for any future views.
- `views/build-placeholder.tsx` — a `null`-rendering view that exists only because Skybridge production builds require ≥1 view entry. It is **not registered to any tool**; don't remove it without addressing the build constraint.

### The two output streams (contract vs presentation)

This mirrors the workspace's "format follows consumer" rule — read `../CLAUDE.md` → "Surface output conventions". Every tool result carries two independent things:

- **`structuredContent`** — the machine contract. A machine consumer branches on these fields, never on transport.
- **`content` text** — the human/LLM-readable Markdown summary, taken verbatim from the API's `rendered_markdown`. It is deliberately **not duplicated** into `structuredContent`.

### Verdict vs no-verdict (the `status` discriminator)

A *produced* validation verdict is always `status: "ok"`, regardless of whether the bundle passed — discriminate on `is_valid` (and `is_runnable`). `status: "error"` is reserved for **"no verdict could be produced"**: bad request shape, unreachable/misconfigured API, or a runtime fault. Those carry an `errors[]` array, each tagged with an `ErrorClass`:

- `input_domain` — the submitted request/files are wrong (empty `files`, blank `uri`, API 400/422).
- `config` — environment/auth is wrong (`MTHDS_API_URL`/`MTHDS_API_KEY`, API unreachable, 401/403/404).
- `runtime` — unexpected server-side fault (API 5xx, unknown errors).

`classifyError` maps `mthds-js` error types (`ApiUnreachableError`, `ClientAuthenticationError`, `ApiResponseError`, `PipelineRequestError`) and HTTP statuses onto these classes. When you add a new failure mode, classify it here rather than letting it fall through to a generic `runtime` message.

### State projection rules (in `validationResult`)

- Valid + runnable → `is_valid=true`, `is_runnable=true`, `graph_spec` included.
- Valid + pending signatures → `is_valid=true`, `is_runnable=false`, `pending_signatures` populated.
- Invalid produced verdict → `status="ok"`, `is_valid=false`, `validation_errors` populated.
- `include_graph` defaults to **true**; pass `false` to omit `graph_spec` from a valid report.
- The capability always calls the API with `allowSignatures: true` and `render: ["markdown"]`. A report missing `rendered_markdown` is a hard error.

## Testing conventions

Tests are colocated (`*.test.ts`, Node environment). The capability is tested by **injecting a fake client** via `ValidationContext.client` — `validateMthds` uses `context.client` when present and only constructs a real `MthdsApiClient` otherwise. Use this seam to test API behavior without a live `pipelex-api`. Pure projection/classification functions (`validationResult`, `classifyError`, `validateRequest`) are exported specifically so they can be tested in isolation.

## Conventions & gotchas

- **No backward-compatibility burden** (workspace rule) — change shapes directly; note breaking changes in `SPEC.md`.
- **Branding:** keep MTHDS-standard concepts neutrally named inside the Pipelex-branded envelope (`bundle_blueprint`, `graph_spec`, `pipe_io_contracts`) — see `../CLAUDE.md` "Brand boundaries".
- `no-console` is an **error** in ESLint — don't leave `console.*` calls.
- The `mthds` dependency is the **published npm package** (`mthds`, public on npm), not a `file:../mthds-js` link. CI just runs `npm ci` — there is no sibling repo to check out. To develop against local `../mthds-js` changes, `npm link ../mthds-js` (or a local override) without committing the link, then bump the `^x.y.z` range once the change is published.
- Keep `SPEC.md`'s declared input/output shape, the Zod schemas in `validate.ts`, and `README.md` in sync when the tool contract changes.
