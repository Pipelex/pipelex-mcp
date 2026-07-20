# Changelog

## [Unreleased]

### Changed

- Upgraded `skybridge` to 1.2.x (with `@skybridge/devtools` to match). Since Skybridge 1.2.0, views emit a single canonical MCP Apps resource regardless of host (the former dual `apps-sdk`/`ext-apps` emission is unified, with legacy URIs still resolved), and OAuth is a first-class `McpServer` field with branded providers (including WorkOS). No code changes were needed; the full check suite and tests pass unchanged.

### Fixed

- No-verdict error results now surface each `errors[]` entry's `location`, `message`, and `hint` in the MCP `content` text, not only in `structuredContent.errors`. Previously the content stream carried only a terse headline ("… request input is invalid."), so a host that shows the agent the top content line stranded the instructive detail — the hosted `{ path }` rejection naming the local workshop was written but never reached the agent, which had to guess the cause from the tool schema. All four tool-result builders share one `toolResultContent` helper; `structuredContent.errors` stays the untouched machine contract.

## [0.3.0] - 2026-07-16

### Changed

- **Breaking:** renamed the `mthds_inputs` MCP tool to `mthds_inputs_template`. The noun-only name didn't say what the tool returns; the new name states the artifact — a fill-in inputs template. Input/output shapes are unchanged. The tool-naming convention this follows (server key `pipelex`, tools `mthds_<stem>`, lifecycle families sharing a stem prefix, skill↔tool stems as the join key) is now recorded in `SPEC.md` → "Naming Conventions".
- The `run-follow` view now hands the conversation back to the model on its own when the run reaches its terminal outcome: once its results fetch settles (completed or failed), it fires one `sendFollowUpMessage` with a canned prompt naming the run id, so the assistant reports the outcome without the user prompting. This reverses the 0.2.0 decision to keep the handoff user-triggered only. The handoff fires at most once per run — a `notified` flag rides host-persisted view state, so reopening the conversation doesn't re-fire it — and is best-effort: a host that declines the turn is not retried in-session, and the "Summarize in chat" button remains as the manual re-trigger/fallback (its prompt now also names the run id). Follow failures (hard poll errors, results-fetch errors) never auto-fire.

## [0.2.0] - 2026-07-15

### Added

- `mthds_run` / `mthds_run_status` / `mthds_run_results` MCP tool family — durable runs on the hosted Pipelex API through `@pipelex/sdk`'s run lifecycle. `mthds_run` submits the bundle plus inputs and acks immediately with `run_id` + `created_at` (no long-lived tool call); `mthds_run_status` is the cheap read-only poll (coarse `run_status`, `is_terminal`, `degraded`, server `retry_after_seconds` pacing hint); `mthds_run_results` fetches the terminal outcome — a compact output preview (`main_stuff`, with a `truncated` flag) or the failure message, with the executed graph and the full main output riding view-only `_meta` (`graph_spec`, `main_stuff`). All three follow the established verdict discipline (`status: "ok"` for produced verdicts, `status: "error"` + classified `errors[]` for no-verdict), with route-specific 400/422 and 404 hints (including the run-id routes' malformed-id hint and the `/v1/start` 503 quirk mapping).
- `run-follow` Skybridge view, registered on `mthds_run` — follows a durable run on its own by polling `mthds_run_status` through `useCallTool` (zero model turns, zero conversation noise), then fetching `mthds_run_results` once the run is terminal: live status card with elapsed time and non-alarming health notes, then the executed graph (`GraphViewer`) plus an output preview (text, JSON, or image) on success, the failure message on a failed run. Polling uses an elapsed-time backoff ladder overridden by the server's `retry_after_seconds`, pauses while the tab is hidden, and stops on terminal status or a hard (non-transient) error. The view mirrors `{ run_id, last_known }` into host-persisted view state so the assistant can answer "is it done?" without a tool call, and the completed card offers a user-triggered "Summarize in chat" handoff button. `mthds_run`'s `available_view_specs` advertises `live_run_status`.
- `mthds_inputs` MCP tool — projects a pipe's declared inputs as a fill-in template through the Pipelex API (`POST /v1/build/inputs`) via `@pipelex/sdk`'s `buildInputs`. Takes the same `files` shape as `mthds_validate` plus optional `pipe_ref` (qualified `domain.pipe_code`, defaulting server-side to the closure's `main_pipe`), `explicit` (default false — the light template shape), and `format` (`"json"` default in `inputs`, `"toml"` raw text in `inputs_toml`). Follows the same verdict discipline: `status: "ok"` discriminated on `is_valid` for produced verdicts (an unresolvable closure returns `validation_errors[]`), `status: "error"` + classified `errors[]` for no-verdict conditions. No Skybridge view — the template is small structured data the model reads, and the `content` summary repeats it in a fenced code block.
- Shared capability plumbing extracted into `src/capabilities/shared.ts` — the submitted-files input schema, the `ToolError` model, request-shape validation, env-derived API config, and `classifyError` (now taking per-route options for the 400/422 locator/hint and the route named in the 404 hint) are shared between the validate and inputs capabilities.
- `.env` support for the dev server — `nodemon.json` overrides Skybridge's default dev exec with `tsx --env-file-if-exists=.env src/server.ts`, so `PIPELEX_BASE_URL`/`PIPELEX_API_KEY` can live in a gitignored `.env` instead of prefixing `npm run dev`.

### Fixed

- Moved the shared `ToolbarButton` out of the Skybridge view scanner's glob (`src/views/` → `src/views/components/`) — as a named-export helper sitting in the scanned directory it triggered a spurious "missing a default export" dev warning, drowning out the real signal that warning exists to give.
- Every `errors[]` entry now carries a `retryable` flag, set in `classifyError` where the concrete SDK error / HTTP status is still known. The `run-follow` view's poll loops branch on it instead of re-deriving transience from `class`+`location` — which conflated an unreachable API (transient) with a permanently missing run lifecycle (`RunLifecycleUnavailableError` on a bare runner), and a 5xx with a permanently malformed result (e.g. a completed run missing `main_stuff`). Permanent errors now stop polling and surface the classified message instead of retrying forever behind a reassuring spinner.
- The `run-follow` view's results fetch now honors the same pause-while-hidden contract as its status polling: retries (the mid-write `state: "running"` race, transient errors) are not scheduled while the tab is hidden, one immediate fetch fires on return, and at most one fetch is in flight.
- Run-output images now actually render in the `run-follow` completed card: the `mthds_run` view declares a CSP `resourceDomains` allowlist naming exactly the hosted platform's per-env storage buckets (`pipelex-app-{dev,staging,prod}.s3.us-west-2.amazonaws.com`), where run outputs are served as presigned URLs — previously the host's default-deny CSP blocked them (and everything else, which stays blocked). A failed image load (expired presigned URL, CSP-blocked host) falls back to the text preview instead of a broken image.

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
