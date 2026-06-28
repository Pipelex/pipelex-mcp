# Changelog

All notable changes to `pipelex-mcp` are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). `version` in `package.json` is the source of truth; a new versioned heading is minted only when that version is tagged and released.

This changelog supersedes the earlier `v0.x` prototype-increment track ([`../docs/mcp/02-delivery/v0.x-prototype-plan.md`](../docs/mcp/02-delivery/v0.x-prototype-plan.md)), which is now closed. The prototype milestones once called v0.1 / v0.2 / v0.3 were build increments, not package versions — they all ship together as `0.1.0`.

## [Unreleased]

## [0.1.0] - 2026-06-29

First tagged release — a Skybridge MCP server that exposes MTHDS validation to MCP hosts.

### Added

- `mthds_validate` MCP tool — validates submitted `.mthds` file contents through the Pipelex API (`POST /v1/validate`) via `@pipelex/sdk`'s `PipelexApiClient`, and projects the report into a stable structured verdict (`status`, `is_valid`, `is_runnable`, `pending_signatures`, `available_view_specs`, `validation_errors?`, `errors?`) plus a Markdown summary in `content`.
- `run-graph` Skybridge view — renders the method's dry-run graph with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle), with a compact empty-state fallback for invalid / no-graph / `include_graph: false` results. It is the generic run-graph renderer: dry-run graph today, live-run graph once `mthds_run` lands.
- View-only `_meta.graph_spec` channel for the graph payload, kept out of `structuredContent` so the model never pays its tokens. `available_view_specs` advertises the renderable view kinds (currently `dry_run_graph`), and a `## Views` note is appended to the summary so prose-reading agents also learn a view is available.
- Error model — a verdict-vs-no-verdict `status` discriminator, with no-verdict failures classified as `input_domain` / `config` / `runtime`.
- Local OSS `pipelex-api` runner support for development — `MTHDS_API_URL` (default `http://localhost:8081`) and optional `MTHDS_API_KEY`.

### Notes

- `@pipelex/mthds-ui` is linked via `file:../mthds-ui` for now; swap it for a published `@pipelex/mthds-ui` npm range when the server moves to the hosted build.
- `npm run check` runs `build` before the standalone `typecheck` because Skybridge regenerates the view-name registry (`.skybridge/views.d.ts`, gitignored) as `build`'s first step, and `tsc` needs it to resolve the registered view name.

[Unreleased]: https://github.com/Pipelex/pipelex-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pipelex/pipelex-mcp/releases/tag/v0.1.0
