# CLAUDE.md

**This file is a map, not a record.** It says what the repository is, how to work in it, and the few invariants that must steer a decision before any file is read. Rationale, history and per-module detail belong in `docs/`, in `SPEC.md` or in a code comment, and a rule that matters only while certain files are open belongs in `.claude/rules/` with `paths:`. `make check` fails when this file outgrows its ceiling (`scripts/instruction-budget.ts`); when it does, move detail out rather than raising the ceiling.

Workspace-level guidance lives in `../CLAUDE.md`.

## What this repo is

`pipelex-mcp` is **the workshop**, the MCP server that connects coding agents to Pipelex methods: one package at the repository root, published to npm as `@pipelex/mcp`.

- **The workshop** is the local stdio server the Pipelex plugin runs for coding agents (Claude Code, Codex, Cursor), server name `pipelex-plugin`. Its method-taking tools take files, an address or an id. It registers `mthds_list_methods`, `mthds_models`, `mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`, `mthds_run`, `mthds_run_status`, `mthds_run_results`, `mthds_show_images`, `mthds_download_artifacts`, `mthds_save_method`, `mthds_get_method` and `mthds_publish_method`. It registers no views.
- **`src/`** holds the server: its entry point, tool table and file resolver at the top, the capability core under `src/capabilities/`, the tool-definition shape and the shell-test helpers. tsup bundles it into `dist/main.js`, the one file the tarball ships besides the README and the licence.
- **The root** holds the manifest, the Makefile, lint, format and test configuration, `scripts/` and the repository-level `tests/`.

The hosted Pipelex connector for chat hosts (`https://mcp.pipelex.com/mcp`, tools `pipelex_*`) is a separate product that this repository does not hold. The workshop's instructions name its tools only to keep a model from mixing the two.

It is a thin front-end over the Pipelex API — it validates nothing itself — reached through the published `@pipelex/sdk`. **`SPEC.md` is the source of truth for the contract**: read it, and update it when behavior changes.

## Where to read next

- `SPEC.md` — the product contract, every tool.
- `docs/tools.md` — the tool-by-tool reference for users.
- `docs/architecture.md` — how the code is built and why, module by module. **Read a module's entry before changing the module.**
- `docs/testing.md` — the two suites, the injected seams, the live targets, the fixtures and API drift.
- `docs/development.md` — the local loop, the build, what `make check` runs, CI and releases.
- `docs/hosts.md`, `docs/client-identification.md` — host registration, the `User-Agent`.
- `.claude/rules/` — path-scoped rules that load with the files they name: the workspace writers, the manifests, the live suite.

## Commands

Every target runs from the root.

- `make agent-test` — **what an agent runs after touching code**: the hermetic suite, quiet unless it fails.
- `make check` — the pre-flight gate before declaring work done: lint, format, the instruction and tool-text budgets, the build, typecheck.
- `make test` / `make t` — the hermetic Vitest suite, verbose. `make all` — clean, check, test.
- `make format` — Prettier over everything `format:check` reads.
- `make dev-local` / `make inspect-local` — the workshop over stdio from TypeScript, and MCP Inspector against it.
- `make build-local` — the workshop's bin, `dist/main.js`.
- `make smoke`, `make test-e2e` — the live drift detectors. `make test-e2e` writes to storage and to a seeded fixture.
- `make test-e2e-run`, `make test-all` — the live suite with the run family: **spend inference credit**, run only when asked.
- `make seed-e2e-fixture` — writes the durable fixture methods, once per organization.
- `make publish` — a release-guarded escape hatch for a CI outage. `make check-publishable` — the publish guard `npm publish` runs.
- `make use-local-sdk`, `make use-local-ui`, `make use-npm` — switch `@pipelex/sdk` or `@pipelex/mthds-ui` between the sibling checkout and npm.

A single test: `npx vitest run <file>` or `npx vitest run -t "<name>"`; add `--config vitest.e2e.config.ts` for a live one.

## Invariants

- **The workshop owns its tool table**, `src/tools.ts`, built from the core's capabilities. A text the core writes takes its tool names from `capabilities/tool-names.ts`; workshop-only code may write `mthds_*` names literally.
- **The contract is pinned byte for byte** in `workshop.contract.json`. A diff is a contract change: update the snapshot only for a change you meant, and say so in the changelog.
- **Every model-facing text is budgeted.** `check:tool-texts` holds the server instructions and each tool description to 1,800 code points. Server instructions are the map, a tool description says when to call it, a field description carries parameter detail, and a result summary carries what matters after a call. Front-load each text.
- **A produced verdict is `status: "ok"`, whatever it says; `status: "error"` means no verdict could be produced.** A new failure mode gets its texture in `classifyError` (`capabilities/shared.ts`) and takes its class and `retryable` from the SDK's error, overridden only with a comment saying why, never left to fall through to a generic `runtime` error.
- **Three output streams, three jobs**: `structuredContent` is the machine contract, `content` is the Markdown summary, and `_meta` is what the model never sees, such as a run's full output and usage records.
- **The catalog projection invariant**: `mthds`, `python`, `input_data`, `pipe_output`, `org_id` and `created_by_user_id` never reach `structuredContent`, `content`, `_meta` or a log.
- **Never log request `_meta`**: a host may put the user's location and stable identifiers on every call, as ChatGPT does.
- **No image content block carries `annotations`**: Codex refuses an annotated image block outright.
- **Every Pipelex API client comes from `createPipelexApiClient`**, never `new`, and nothing calls `fetch` bare outside the lint-exempted files. Lint enforces both. `no-console` is an error.
- **`package.json`'s `dependencies` are exactly what the bundle reaches at run time**, `@pipelex/mthds-form` is never declared, and a sprint pin is never published: the publish guard refuses it.
- **The live targets read `PIPELEX_E2E_BASE_URL` / `PIPELEX_E2E_API_KEY`, never `PIPELEX_BASE_URL` / `PIPELEX_API_KEY`**, and stay outside `make all` and `make check`. A live failure is fixed in `../pipelex-sdk/js`, then bumped here, never patched over.
- **A tool contract moves everywhere at once**: `SPEC.md`, the Zod schemas in `capabilities/`, `docs/tools.md`, and the tool table in `README.md` when a tool is added, removed or renamed. The README is the npm front page, so its links are absolute.
- **MTHDS-standard concepts keep neutral names** inside the Pipelex envelope (`bundle_blueprint`, `graph_spec`, `pipe_io_contracts`, `input_form`).
- **No backward compatibility**: change shapes directly and record a breaking change in the changelog.

## Versioning

The workshop is versioned on semver in `package.json`, with its changelog in `CHANGELOG.md`, release branches `release/vX.Y.Z` and tags `vX.Y.Z`. Work accumulates under the changelog's `## [Unreleased]` when it changes what a user of the published package sees. Cut a release with the **`/release` skill**; merging its PR into `main` is what publishes it. The `v` prefix lives on branch names and tags only, never in `package.json` or a changelog heading. `docs/development.md` has the rest.
