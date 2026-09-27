# CLAUDE.md

**This file is a map, not a record.** It says what the repository is, how to work in it, and the few invariants that must steer a decision before any file is read. Rationale, history and per-module detail belong in `docs/`, in `SPEC.md` or in a code comment, and a rule that matters only while certain files are open belongs in `.claude/rules/` with `paths:`. `make check` fails when this file outgrows its ceiling (`scripts/instruction-budget.ts`); when it does, move detail out rather than raising the ceiling.

Workspace-level guidance lives in `../CLAUDE.md`. `AGENTS.md` mandates the **`skybridge` skill** when planning or updating this codebase; use it.

## What this repo is

`pipelex-mcp` connects MCP hosts to Pipelex methods: **two servers with two tool sets over one capability core**, and no tool name is registered by both.

- **The console** (`packages/console`, `@pipelex/mcp-console`, private) is the hosted Pipelex connector for chat hosts (ChatGPT, claude.ai, Cowork), server name `pipelex`, a Skybridge app deployed to Alpic. It names a method by reference only (a catalog id or a published address), takes no `files`, and registers `pipelex_list_methods`, `pipelex_show_method`, `pipelex_upload_attachments`, `pipelex_run`, `pipelex_run_status`, `pipelex_run_results`, `pipelex_show_images` and the app-only `pipelex_request_upload`. Its views are `run-graph` (on `pipelex_show_method`) and `run-follow` (on `pipelex_run`).
- **The workshop** (`packages/workshop`, `@pipelex/mcp` on npm) is the local stdio server the Pipelex plugin runs for coding agents (Claude Code, Codex, Cursor), server name `pipelex-plugin`. Its method-taking tools take files, an address or an id: `mthds_list_methods`, `mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`, `mthds_run`, `mthds_run_status`, `mthds_run_results`, `mthds_show_images`, `mthds_download_artifacts`, `mthds_save_method` and `mthds_get_method`. It registers no views.
- **The core** (`packages/core`, `@pipelex/mcp-core`, private, never released) holds the capabilities under `src/capabilities/`, the tool-definition shape and the shell-test helpers. It exports TypeScript source, which each server's build inlines, so neither server imports a workspace package at run time.
- **The root** holds what spans the packages: the Makefile, lint, format and test configuration, `scripts/` and the cross-package `tests/`.

It is a thin front-end over the Pipelex API — it validates nothing itself — reached through the published `@pipelex/sdk`. **`SPEC.md` is the source of truth for the contract**: read it, and update it when behavior changes.

## Where to read next

- `SPEC.md` — the product contract, both servers, every tool.
- `docs/tools.md` — the tool-by-tool reference for users.
- `docs/architecture.md` — how the code is built and why, module by module. **Read a module's entry before changing the module.**
- `docs/testing.md` — the two suites, the injected seams, the live targets, the fixtures and API drift.
- `docs/development.md` — the console's dev loop, the build, what `make check` runs, CI, releases and deploys.
- `docs/hosts.md`, `docs/client-identification.md`, `docs/alpic-builds.md` — host registration, the `User-Agent`, Alpic's build.
- `.claude/rules/` — path-scoped rules that load with the files they name: the attachment fetch boundary, the workspace writers, the console's contract, its views and stylesheet, the manifests, the live suite.

## Commands

Every target runs from the root.

- `make agent-test` — **what an agent runs after touching code**: the hermetic suite, quiet unless it fails.
- `make check` — the pre-flight gate before declaring work done: lint, format, the instruction and tool-text budgets, both builds, the bundle and cascade checks, typecheck.
- `make test` / `make t` — the hermetic Vitest suite, verbose. `make all` — clean, check, test.
- `make format` — Prettier over everything `format:check` reads.
- `make dev` — the console on the pinned port `6843`, `.env` sourced ahead of the shell; needs `WORKOS_AUTHKIT_DOMAIN` and `PIPELEX_MCP_RESOURCE_INDICATOR`.
- `make dev-local` / `make inspect-local` — the workshop over stdio from TypeScript, and MCP Inspector against it; no WorkOS needed.
- `make build-local` — the workshop's bin, `packages/workshop/dist/main.js`.
- `make smoke`, `make test-e2e` — the live drift detectors. `make test-e2e` writes to storage and to a seeded fixture.
- `make test-e2e-run`, `make test-all` — the live suite with the run family: **spend inference credit**, run only when asked.
- `make seed-e2e-fixture` — writes the durable fixture methods, once per organization.
- `make deploy-dev`, `make deploy-staging` — ship the working tree to those consoles. `make deploy` / `make publish` are release-guarded escape hatches for a CI outage.
- `make use-local-sdk`, `make use-local-ui`, `make use-npm` — switch `@pipelex/sdk` or `@pipelex/mthds-ui` between the sibling checkout and npm.

A single test: `npx vitest run <file>` or `npx vitest run -t "<name>"`; add `--config vitest.e2e.config.ts` for a live one.

## Invariants

- **Each shell owns its tool table and shares no tool name with the other**: `packages/workshop/src/tools.ts` and `packages/console/src/hosted/tools.ts`, built from the core's capabilities. One tool name means one contract; a tool that only one shell can serve is registered on that shell only. A text both shells produce takes its tool names from `capabilities/tool-names.ts`; workshop-only code may write `mthds_*` names literally.
- **Each shell's contract is pinned byte for byte** in `workshop.contract.json` and `console.contract.json`. A diff is a contract change; on the console it strands every ChatGPT install until the connector is re-added, because ChatGPT caches the tool list and the views' CSP. Update a snapshot only for a change you meant, and say so in the changelog.
- **Every model-facing text is budgeted.** `check:tool-texts` holds the server instructions and each tool description to 1,800 code points. Server instructions are the map, a tool description says when to call it, a field description carries parameter detail, and a result summary carries what matters after a call. Front-load each text.
- **A produced verdict is `status: "ok"`, whatever it says; `status: "error"` means no verdict could be produced.** A new failure mode is classified in `classifyError` (`capabilities/shared.ts`), with its `retryable` verdict, never left to fall through to a generic `runtime` error.
- **Three output streams, three jobs**: `structuredContent` is the machine contract, `content` is the Markdown summary, and `_meta` is what the model never sees: the views' data, and a run's full output and usage records. Never put view data in `structuredContent`.
- **The catalog projection invariant**: `mthds`, `python`, `input_data`, `pipe_output`, `org_id` and `created_by_user_id` never reach `structuredContent`, `content`, `_meta` or a log.
- **Never log request `_meta`**: ChatGPT puts the user's location and stable identifiers on every call.
- **No image content block carries `annotations`**: Codex refuses an annotated image block outright.
- **The console's auth is per-user OAuth only.** The caller's token overrides `apiKey` on every context; a missing token fails closed with an empty string, never `undefined`.
- **Every Pipelex API client comes from `createPipelexApiClient`**, never `new`, and nothing calls `fetch` bare outside the lint-exempted files: a third-party fetch, which must not carry the Pipelex `User-Agent`, lives in `attachment-fetch.ts`. Lint enforces both. `no-console` is an error.
- **Each package declares exactly what its own entrypoint reaches at run time.** `skybridge` is the console's alone, the core is inlined into both servers, and `@pipelex/mthds-form` is never declared.
- **The live targets read `PIPELEX_E2E_BASE_URL` / `PIPELEX_E2E_API_KEY`, never `PIPELEX_BASE_URL` / `PIPELEX_API_KEY`**, and stay outside `make all` and `make check`. A live failure is fixed in `../pipelex-sdk-js`, then bumped here, never patched over.
- **A tool contract moves everywhere at once**: `SPEC.md`, the Zod schemas in `capabilities/`, `docs/tools.md`, and the tool table in `README.md` when a tool is added, removed, renamed or changes shell. The README is the npm front page, so its links are absolute.
- **MTHDS-standard concepts keep neutral names** inside the Pipelex envelope (`bundle_blueprint`, `graph_spec`, `pipe_io_contracts`, `input_form`).
- **No backward compatibility**: change shapes directly and record a breaking change in the changelog of the server it affects.

## Versioning

Two servers, two release tracks, each on semver with its own changelog:

| Server | Version | Changelog | Release branch | Tag |
| --- | --- | --- | --- | --- |
| The workshop | `packages/workshop/package.json` | `packages/workshop/CHANGELOG.md` | `release/vX.Y.Z` | `vX.Y.Z` |
| The console | `packages/console/package.json` | `packages/console/CHANGELOG.md` | `release/console-vX.Y.Z` | `console-vX.Y.Z` |

Work accumulates under each changelog's `## [Unreleased]`, and a change to the core goes in the changelog of each server it changes. Cut a release with the **`/release` skill**; merging its PR into `main` is what ships it. The `v` and `console-v` prefixes live on branch names and tags only, never in `package.json` or a changelog heading. `docs/development.md` has the rest.
