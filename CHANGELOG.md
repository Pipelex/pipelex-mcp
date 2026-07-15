# Changelog

## [Unreleased]

### Added

- `mthds_inputs` MCP tool — projects a pipe's declared inputs as a fill-in template through the Pipelex API (`POST /v1/build/inputs`) via `@pipelex/sdk`'s `buildInputs`. Takes the same `files` shape as `mthds_validate` plus optional `pipe_ref` (qualified `domain.pipe_code`, defaulting server-side to the closure's `main_pipe`), `explicit` (default false — the light template shape), and `format` (`"json"` default in `inputs`, `"toml"` raw text in `inputs_toml`). Follows the same verdict discipline: `status: "ok"` discriminated on `is_valid` for produced verdicts (an unresolvable closure returns `validation_errors[]`), `status: "error"` + classified `errors[]` for no-verdict conditions. No Skybridge view — the template is small structured data the model reads, and the `content` summary repeats it in a fenced code block.
- Shared capability plumbing extracted into `src/capabilities/shared.ts` — the submitted-files input schema, the `ToolError` model, request-shape validation, env-derived API config, and `classifyError` (now taking per-route options for the 400/422 locator/hint and the route named in the 404 hint) are shared between the validate and inputs capabilities.
- `.env` support for the dev server — `nodemon.json` overrides Skybridge's default dev exec with `tsx --env-file-if-exists=.env src/server.ts`, so `PIPELEX_BASE_URL`/`PIPELEX_API_KEY` can live in a gitignored `.env` instead of prefixing `npm run dev`.

### Changed

- **Breaking: renamed the API env vars to the `PIPELEX_` prefix.** The env var read for the API base URL is now `PIPELEX_BASE_URL` (was `MTHDS_BASE_URL`) and the optional auth key is `PIPELEX_API_KEY` (was `MTHDS_API_KEY`); the `location`/`hint` strings in the classified errors follow. No read alias.
- **Breaking:** `PIPELEX_BASE_URL` now defaults to the hosted Pipelex API (`https://api.pipelex.com`) instead of the local OSS `pipelex-api` (`http://localhost:8081`). Set `PIPELEX_BASE_URL=http://localhost:8081` to develop against a local runner.

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
