# Durable runs — implementation tracker

Tracks execution of the durable-runs increment: the `mthds_run` / `mthds_run_status` / `mthds_run_results` tool family plus the self-polling `run-follow` view.

**Design source of truth: `wip/run/durable-runs.md`** (reviewed with Louis 2026-07-15; the §6 decisions are taken and recorded there). This file tracks *what/status*; the design doc holds the *why*. When reality diverges, fold the change into the design doc first, then reconcile this tracker.

- Branch: `feature/Run`. Repo gate: `make all` (clean + check + test). Dev server: `make dev` (MCP at `http://localhost:3000/mcp`, DevTools at `http://localhost:3000`).
- **Skybridge mandate (AGENTS.md):** load the `skybridge` skill before planning or changing this codebase. Per-phase reference files to read are listed inside each phase.
- Live checks against the hosted API need `PIPELEX_API_KEY` (and default `PIPELEX_BASE_URL=https://api.pipelex.com`) — in the gitignored `.env`. If no key is available, stop and ask Louis rather than skipping the check.

## Current state

**Phase 2 complete (tools shipped + live-verified, Checkpoint 2 passed).** Next action: first unchecked box of Phase 3 (the §7-Q2 host spike gates the rest of that phase). The surface Phase 3 builds on: the registered tool trio in `src/server.ts` (`mthds_run` with `readOnlyHint: false` and no view yet; `mthds_run_status`/`mthds_run_results` read-only), the capability functions `startMthdsRun`/`getMthdsRunStatus`/`getMthdsRunResults` in `src/capabilities/run.ts` with their toolResult wrappers (`runToolResult`/`runStatusToolResult`/`runResultsToolResult` — the last one projects `_meta.graph_spec` + `_meta.main_stuff`), and the fake-client test seam (`RunContext.client`). **Phase 3's schema surface is frozen** — the view only consumes the tools. Live-check answers Q1/Q3 are recorded in the design doc §7 (headline: omitted `pipe_code` resolves `main_pipe`; hosted `/v1/start` rejects bad bundles with an opaque 503, mitigated by a per-route `serverError` hint + validate-first tool description).

## Cold-start brief (read order for a fresh session)

1. `CLAUDE.md` (repo conventions: output streams, verdict discipline, test seam, gotchas) and `../CLAUDE.md` §"Surface output conventions".
2. `wip/run/durable-runs.md` — the full functional/technical design, decisions (§6), open questions (§7).
3. `SPEC.md` — current tool contracts (updated in Phase 1 to include the run family).
4. This file — status, decision log, deviations.
5. Existing code to mirror: `src/capabilities/validate.ts` + `inputs.ts` (capability pattern), `src/capabilities/shared.ts` (`ToolError`, `classifyError`, `buildApiConfig`), `src/views/run-graph.tsx` (view pattern), `src/server.ts` (registration). Reference implementation for polling UX: `../pipelex-starter-js` (its `RunStatus` component and `isTransientPollError`).

## Checkpoint protocol (mandatory — never skip, never batch two checkpoints)

At each `⛔ CHECKPOINT`, stop feature work and run this sequence:

1. **Verify.** `make all` green, plus the phase's own manual/live verification items all ticked. Report failures honestly; do not proceed on red.
2. **Commit.** Land the phase's work as clean commit(s) so the checkpoint has a reviewable SHA range. Record the phase base SHA → HEAD range here.
3. **Update this tracker + linked docs.** Tick boxes; record live-check answers and decisions in `wip/run/durable-runs.md` (§7 answers in place) and mirror one-liners in the Decision log below; reconcile any deviation into the *later* phases' checklists (don't leave stale items). **Cold-start test:** could a fresh session with zero conversation context resume correctly from this file + linked docs alone? If not, fix this file before moving on.
4. **Fan out `/code-review`.** Spawn a **Sonnet-5 sub-agent** (Agent tool, `subagent_type: "general-purpose"`, `model: "sonnet"`) whose prompt says only: run the `/code-review` skill on the phase's changes, identified by an explicit pointer — the commit range (`git diff <phase-base-sha>..HEAD` in this repo) or the working-tree files. **No inherited context:** never pass the plan, the design doc, the rationale, or your own conclusions — the reviewer sees the diff cold. Review goal: clean solid software, not over-engineering. Triage findings: apply what's right, and record rejected findings with the reason in the Decision log.
5. Re-run `make all` if the review triage changed code, then proceed to the next phase.

---

## Phase 1 — contract (spec + schemas + pure projections, tests first)

Skybridge refs for this phase: `references/architecture.md` (already applied in the design), `references/fetch-and-render-data.md` (handler/output-schema patterns).

- [x] Update `SPEC.md`: run UX flow (§3 of the design), the three tool contracts (input/`structuredContent` shapes as designed), run verdict discipline (terminal-failed and not-done-yet are produced `status: "ok"` verdicts; no-verdict classes incl. unknown-run-id 404 → `input_domain`, `RunLifecycleUnavailableError` → `config`), `available_view_specs` kinds `"live_run_status"` (on `mthds_run`) and `"run_graph"` (on `mthds_run_results`, minted now per §6.5 even though its view is deferred), `main_stuff` bounding + `truncated` flag (§6.4-A), **drop "run execution, status polling" from Non-Goals** (blocking `execute` and cancellation stay non-goals), declare "binary inputs ride https URLs; a storage upload tool is a later increment" (§7-Q4).
- [x] `src/capabilities/shared.ts`: extend `ClassifyErrorOptions` with the per-route 404 override (unknown-id → `input_domain` while `RunLifecycleUnavailableError` stays `config`); add `validateRunIdRequest` (non-empty trimmed id, format stays server-owned). Also added explicit `classifyError` arms for `RunLifecycleUnavailableError` (config, hosted-API hint) and `MissingMainStuffError` (runtime) — both would otherwise fall into the generic `PipelineRequestError` arm with a misleading hint.
- [x] `src/capabilities/run.ts` skeleton: Zod input/output schemas for the trio; `RunContext { baseUrl, apiKey?, client? }` (same injected-fake-client seam as `ValidationContext` — flat shape per the existing convention, not the design sketch's `{ config, client? }`); pure projection functions `startResult`, `statusResult`, `resultsResult` exported for isolation tests (incl. `is_terminal` derivation via the SDK's `isTerminalRunStatus`).
- [x] `main_stuff` bounding as a pure function: ~32KB serialized cap (constant, tune later); JSON → deterministic deepest/longest-collection pruning with an ellipsis marker; text → head+tail; sets `truncated: true`; full output untouched for `_meta`.
- [x] Tests first (colocated `run.test.ts` + `shared.test.ts` additions, fake client seam): start-ack projection; non-terminal / terminal / degraded status (+ `retry_after_seconds` passthrough); running / completed / failed results projection; truncation on/off boundary cases; unknown-id 404 vs `RunLifecycleUnavailableError` classification; completed-result-missing-`main_stuff` → `runtime` hard error; request-shape rejections (empty files, blank `run_id`, blank `pipe_code`).
- [x] Exit gate: `make check` green with the skeleton compiled and all tests passing (`make all` green).

### ⛔ CHECKPOINT 1 — contract locked

- [x] Protocol steps 1–5 executed (verify, commit, tracker+docs update incl. cold-start test, no-context Sonnet-5 `/code-review` fan-out on this phase's diff, triage).
- [x] Phase SHA range recorded: `<base>..<head>` = `c83224d..0c2f725` (plus the review-triage/tracker commit(s) after it, see Decision log)
- [x] SPEC.md, Zod schemas, and design doc agree on every field name (spot-check `pipe_code`, `run_status`, `is_terminal`, `available_view_specs` kinds — all match; note the projections already compose the `content` summaries, so Phase 2's summary items are verify/refine rather than build-from-scratch).

---

## Phase 2 — capabilities + server registration + live checks

- [x] Implement `startMthdsRun` / `getMthdsRunStatus` / `getMthdsRunResults` over `client.start` / `client.getRunStatus` / `client.getRunResult`. `mthds_contents` from `files[].content` (`/v1/start` takes no source labels — `uri` feeds only our request-shape errors). Never `waitForResult` / `startAndWaitForResult`; never surface `result_url` or presigned URLs into model context.
- [x] Completed results: executed `graph_spec` and the **full** (unbounded) `main_stuff` ride `_meta` (keys mirror the API field names, per the existing `graph_spec` convention); bounded copy + fenced ```json summary block in the model-facing streams (the `mthds_inputs` duplication pattern).
- [x] `content` summaries: start-ack with run id + follow-up etiquette ("view follows live; `mthds_run_status` to check, `mthds_run_results` when terminal — don't spin-poll"); status summary with "check again in ~Ns" from the retry hint; failed-results summary with terminal status + failure message (state plainly that no graph exists for failed runs). (Verified/refined — the projections composed these in Phase 1.)
- [x] Register in `src/server.ts`: `mthds_run` (readOnlyHint: false, destructiveHint: false, openWorldHint: false; description states it executes on the hosted API and **spends inference credit**; OpenAI invocation labels), `mthds_run_status` / `mthds_run_results` (readOnlyHint: true). **No `view` registration yet and `available_view_specs: []` on `mthds_run` in this phase** — the `run-follow` component doesn't exist until Phase 3; registering a missing view name breaks the `.skybridge/views.d.ts` typecheck. `mthds_run_results` populates `available_view_specs: ["run_graph"]` when `graph_spec` rides `_meta` (contract minted now, its own view deferred per §6.5).
- [x] Extend the server `instructions` string with one sentence on the run lifecycle.
- [x] **Live check §7-Q1**: `pipe_code` omitted at `/v1/start` — main-pipe resolution or rejection? → **resolves the bundle's `main_pipe`** (run accepted and COMPLETED on prod); `pipe_code` stays optional. Recorded in the design doc §7.
- [x] **Live check §7-Q3**: invalid bundle at `/v1/start` — 422 at submission or 202-then-FAILED? → **neither: a generic 503 `pipeline_start_unavailable` at submission** (same for missing required inputs). Mitigated with a per-route `serverError` hint (`ClassifyErrorOptions` extension) + a validate-first nudge in the tool description; platform bug candidate flagged (should be 422). Recorded in §7 + SPEC.md.
- [x] Smoke-test the trio end-to-end against the hosted API: start a small method, poll status to terminal, fetch results — done twice, once driving the capability functions directly and once through the real MCP endpoint (`make dev` server, MCP client over streamable HTTP: tools listed with correct annotations, trio green, `_meta` carries `graph_spec` + `main_stuff` across the transport). Unknown `run_id` exercised live on both run routes (→ `input_domain`). Failing-run arm: start-time rejection exercised live (the 503 above); a mid-execution terminal FAILED could not be produced live (Temporal keeps retrying a failing activity well past a 10-minute watch, `degraded: true` on every read) — the `failed` results arm stays covered by unit tests against the SDK contract.

### ⛔ CHECKPOINT 2 — tools shipped (design doc "Checkpoint A")

- [x] Protocol steps 1–5 executed (incl. no-context Sonnet-5 `/code-review` fan-out on this phase's diff).
- [x] Phase SHA range recorded: `<base>..<head>` = `b4c21b4..<phase-2-head>` (see Decision log for the review-triage commits after it)
- [x] Design doc updated: §7 Q1/Q3 answers recorded in place; the 503 contract drift folded into SPEC.md (verdict-discipline section) and the tool description.
- [x] **Phase 3's schema surface is frozen** — the view only *consumes* the tools; no schema or projection change is expected in Phase 3 beyond flipping `mthds_run`'s `available_view_specs` to `["live_run_status"]` and appending its `## Views` note (both already listed as Phase 3 items).

---

## Phase 3 — the `run-follow` view

Skybridge refs for this phase: `references/fetch-and-render-data.md`, `references/state-and-context.md`, `references/prompt-llm.md`, `references/ui-guidelines.md`, `references/run-locally.md`.

- [ ] **Spike first — §7-Q2 (gates everything else):** from a minimal view, verify per host (DevTools, then ChatGPT, then Claude) that (a) the view can call the read-only `mthds_run_status` via `useCallTool` without user confirmation, and (b) `CallToolResponse.meta` passes `_meta` through for `mthds_run_results`. Record per-host results in the design doc §7. If status polling fails on a target host, **stop and re-plan** — the card core depends on it.
- [ ] Polling logic: extract the cadence/backoff decision core as a pure function (start ~2s, honor `retry_after_seconds`, gentle backoff capped ~10s as elapsed grows, transient-vs-hard error split mirroring the starter's `isTransientPollError`) and unit-test it in the Node Vitest env; wrap it in the `useRunPolling` hook (timer + `visibilitychange` pause + stop-on-terminal).
- [ ] `src/views/run-follow.tsx`: status card (friendly labels Queued/Starting/Running/Finalizing/Failed/…, elapsed wall-clock, spinner, non-alarming degraded/transient note); on COMPLETED one `mthds_run_results` call → `GraphViewer` from `meta.graph_spec` (per-node statuses baked in the spec) + compact output preview (pretty JSON; inline `<img>` when the output narrows to a url-shaped image); fullscreen toggle reused from `run-graph`; failure card with terminal status + message and an explicit "no graph for failed runs" state; remount re-resolves by id (one status poll; if terminal, one results fetch). No dry-run graph while running (§6.3-A; the view-side lazy graph is a recorded later increment).
- [ ] Model visibility: `data-llm` annotation ("Run 01J…: RUNNING, 34s elapsed" / "COMPLETED — output shown") + mirror the last-known snapshot into `useViewState`.
- [ ] Wire it up in `src/server.ts`: `view: { component: "run-follow" }` on `mthds_run`; flip its `available_view_specs` to `["live_run_status"]`; append the `## Views` note to the start summary (the `mthds_validate` pattern); update the Phase-1 projection test expecting `[]`.
- [ ] Optional, keep only if cheap (§6.6): user-triggered "Summarize in chat" button on the terminal card via `sendFollowUpMessage` (canned "The run completed — report the results" prompt). Droppable without touching contracts.
- [ ] Verify in DevTools **and at least one real host**: watch a run start→terminal without any model turn; reopen the conversation and confirm the view re-resolves; confirm the assistant can answer "is it done?" from the view state without a tool call.

### ⛔ CHECKPOINT 3 — view shipped

- [ ] Protocol steps 1–5 executed (incl. no-context Sonnet-5 `/code-review` fan-out on this phase's diff).
- [ ] Phase SHA range recorded: `<base>..<head>` = _
- [ ] §7-Q2 per-host matrix recorded in the design doc; if a host failed the spike, the fallback decision and its plan reconciliation are logged below.

---

## Phase 4 — docs, reconciliation & release

- [ ] `README.md`: run tool family, the follow view, `PIPELEX_API_KEY` now effectively mandatory for the run tools.
- [ ] Repo `CLAUDE.md`: run capability architecture, its output streams, state projection rules (`startResult`/`statusResult`/`resultsResult`), the 404-override classification, the `run-follow` view and its polling hook, updated `available_view_specs` kinds.
- [ ] `CHANGELOG.md` under `## [Unreleased]` (note breaking contract additions plainly; no "pre-1.0" qualifier; no `wip/` doc mentions).
- [ ] Reconcile `../docs/specs/pipelex-mcp.md` to the shipped names and contracts (§6.1-A family; prose-only — it's all `<!-- unverified -->` greenfield, no conformance tests exist for this surface yet).
- [ ] Final pass on `wip/run/durable-runs.md`: fold reality back in top to bottom; §6.5 (results view), §6.3-C (lazy dry-run graph), and any dropped §6.6 button recorded as later increments.

### ⛔ CHECKPOINT 4 — pre-release gate (design doc "Checkpoint B")

- [ ] Protocol steps 1–5 executed — here the `/code-review` fan-out reviews the **full branch diff** (`git diff main..HEAD`), still with the no-context convention.
- [ ] Cross-doc agreement confirmed: SPEC.md ↔ Zod schemas ↔ README ↔ repo CLAUDE.md ↔ `../docs/specs/pipelex-mcp.md`.
- [ ] Cut the release via the `/release` skill (it owns the version bump, changelog promotion, and the `release/vX.Y.Z → main` PR the CI gates expect).
- [ ] After merge: deploy via `make deploy` and sanity-check the deployed server against a real host.

---

## Open questions ledger (mirrors design §7 — answers get recorded in the design doc, status tracked here)

- [x] Q1 — `pipe_code` omitted at `/v1/start`: resolves main pipe or rejects? (Phase 2 live check) → answer: resolves the bundle's `main_pipe`; `pipe_code` stays optional (design doc §7).
- [ ] Q2 — widget-initiated tool calls + `meta` passthrough per host (ChatGPT / Claude / DevTools)? (Phase 3 spike, gates the view) → answer: _
- [x] Q3 — `/v1/start` on an invalid bundle: 422 at submission or 202-then-FAILED? (Phase 2 live check) → answer: neither — opaque 503 at submission; per-route `serverError` hint + validate-first description added; platform 422 bug candidate flagged (design doc §7).
- [x] Q4 — binary inputs ride https URLs, storage upload tool deferred: declared in SPEC.md (Phase 1) → done (SPEC.md Run Scope + Non-Goals).

## Decision log / deviations

Running list — one line per entry, newest first. Includes rejected review findings with reasons.

- (P2) `ClassifyErrorOptions` gained a per-route `serverError` hint override, driven by the Q3 live check: the hosted `/v1/start` answers 503 for an invalid bundle, so the start route's 5xx hint points at `mthds_validate`/`mthds_inputs` before blaming the platform.
- (P2) Platform bug candidate flagged (not an MCP change): `/v1/start` should 422 on an invalid bundle instead of the generic 503 `pipeline_start_unavailable`; until then the MCP classifies it as a `runtime` no-verdict.
- (P2) A mid-execution terminal FAILED could not be produced live (Temporal retries a failing activity past a 10-minute watch; every status read came back `degraded: true`) — the `failed` results arm is covered by unit tests against the SDK contract; noted for the Phase 3 view (long-RUNNING with degraded reads is a real state the card will show).
- (P2) MCP-transport smoke ran on port 3001 (3000 was taken by another dev server) — the Skybridge dev server auto-increments; nothing to fix.
- (P1 review triage) "Missing CHANGELOG entry" → deferred by plan, not an oversight: the changelog entry is a Phase 4 item, minted when the tool family is registered and user-visible; a contract skeleton is not a release-facing change yet.
- (P1 review triage) "Unused exports `RunContext`/`buildRunContext`/`RUN_RESULTS_ERROR_OPTIONS`" → rejected: intentional Phase-1 groundwork consumed by the Phase 2 capability functions (mirrors `buildValidationContext`); the review saw the phase diff without the plan, as designed.
- (P1) Projection functions compose their `content` summaries already (they are integral to the `{ structuredContent, summary }` return shape the existing capabilities use) — Phase 2's summary bullets become verify/refine, not build.
- (P1) `completedSummary` fences a string output as a plain ``` block instead of a JSON-escaped string in a ```json fence — presentation only, contract unchanged.
- (P1) No `## Views` prose note on `mthds_run_results` summaries: no view is registered on that tool in this increment (kind minted in `available_view_specs` only); the note convention stays tied to a registered view (start summary gets one in Phase 3).
- (P1) `RunContext` uses the flat `{ baseUrl, apiKey?, client? }` shape of `ValidationContext`/`InputsContext` rather than the design sketch's `{ config, client? }` — same test seam, existing convention.
- (P1) Per-route error options exported as constants (`RUN_START_ERROR_OPTIONS`, `RUN_STATUS_ERROR_OPTIONS`, `RUN_RESULTS_ERROR_OPTIONS`) so tests pin the 404/422 classification now and Phase 2 reuses them.
- (P1) `classifyError` gained explicit arms for `RunLifecycleUnavailableError` (config) and `MissingMainStuffError` (runtime) — both are `PipelineRequestError` subclasses that would otherwise classify as config with a misleading "check the submitted request" hint.
