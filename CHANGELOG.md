# Changelog

## [Unreleased]

### Changed

- **Breaking: follows the `MTHDS_API_URL` → `MTHDS_BASE_URL` wire-key rename.** The env var read for the API base URL (and the `location`/`hint` strings in validate errors) is now `MTHDS_BASE_URL`, matching the coordinated rename in the `mthds` Python and npm clients (no read alias).
- **Breaking:** `MTHDS_BASE_URL` now defaults to the hosted Pipelex API (`https://api.pipelex.com`) instead of the local OSS `pipelex-api` (`http://localhost:8081`). Set `MTHDS_BASE_URL=http://localhost:8081` to develop against a local runner.

## [0.1.0] - 2026-06-29

### Added

- `mthds_validate` MCP tool — validates submitted `.mthds` file contents through the Pipelex API (`POST /v1/validate`) via `@pipelex/sdk`'s `PipelexApiClient`, and projects the report into a stable structured verdict (`status`, `is_valid`, `is_runnable`, `pending_signatures`, `available_view_specs`, `validation_errors?`, `errors?`) plus a Markdown summary in `content`.
- `run-graph` Skybridge view — renders the method's dry-run graph with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle), with a compact empty-state fallback for invalid / no-graph / `include_graph: false` results. It is the generic run-graph renderer: dry-run graph today, live-run graph once `mthds_run` lands.
- View-only `_meta.graph_spec` channel for the graph payload, kept out of `structuredContent` so the model never pays its tokens. `available_view_specs` advertises the renderable view kinds (currently `dry_run_graph`), and a `## Views` note is appended to the summary so prose-reading agents also learn a view is available.
- Error model — a verdict-vs-no-verdict `status` discriminator, with no-verdict failures classified as `input_domain` / `config` / `runtime`.
- Local OSS `pipelex-api` runner support for development — `MTHDS_API_URL` (default `http://localhost:8081`) and optional `MTHDS_API_KEY`.
- Server-level MCP `instructions` string (set on the `McpServer` constructor options) — a short server-wide hint, surfaced to the model by the host, describing that the server validates `.mthds` method files and, on a valid verdict, returns an interactive dry-run graph.

### Notes

- `@pipelex/mthds-ui` is consumed as the published `^0.10.0` npm package (same model as `@pipelex/sdk`).
- `npm run check` runs `build` before the standalone `typecheck` because Skybridge regenerates the view-name registry (`.skybridge/views.d.ts`, gitignored) as `build`'s first step, and `tsc` needs it to resolve the registered view name.
