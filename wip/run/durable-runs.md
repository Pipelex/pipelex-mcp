# Durable runs — functional & technical design

Status: **reviewed with Louis (2026-07-15)** — the ⚖️ decisions in §6.1/6.3/6.4 are taken (recorded in place). §7 Q1/Q3/Q4 are resolved; §6.6 is resolved (button kept and shipped). §6.5 stays a deferred later increment. The §7-Q2 DevTools arm is fully verified (spike + shipped card); the ChatGPT/Claude arms remain open and need an interactive session with Louis.

## 1. Goal

Add durable (async) method execution to `pipelex-mcp`, against the hosted Pipelex API only. The assistant must be able to **start** a run, **check on** it, and **report** its results — and the user must be able to **follow the run in a view** without chatting with the agent. No blocking calls: the MCP never touches `POST /v1/execute` (this was already resolved workspace-side as decision I5 in `../docs/mcp/02-delivery/adapt-api-plan.md` and spec'd in `../docs/specs/pipelex-mcp.md` → "Run lifecycle — async-start-only").

Non-goals for this increment: run cancellation (no platform route exists today), logs (logs-by-id has no backing yet), registered-method runs by catalog id (needs the methods product surface), MCP resources for artifacts, per-user OAuth (the server keeps the env-key model).

## 2. What we build on

The whole lifecycle already exists in `@pipelex/sdk` (`PipelexApiClient`) and in production on `api.pipelex.com`; `../pipelex-starter-js` exercises it end-to-end. The MCP adds no execution logic — it projects the SDK surface into tools, exactly like `mthds_validate` wraps `validateFiles`.

| SDK call | Route | Semantics |
| --- | --- | --- |
| `client.start(options)` | `POST /v1/start` (202) | Fire-and-forget start. Ack: `pipeline_run_id` + pipelex extensions `created_at`, `state`, `workflow_id`. |
| `client.getRunStatus(runId)` | `GET /v1/runs/{id}/status` | Self-healing coarse status (`RunStatus`: `PENDING → RUNNING → COMPLETED / FAILED / CANCELLED / TERMINATED / TIMED_OUT`), plus `degraded` (Temporal unreachable, status is last-known DB value) and `retry_after_seconds` from the `Retry-After` header. |
| `client.getRunResult(runId)` | `GET /v1/runs/{id}/results` | Discriminated: 202→`running` (with retry hint), 200→`completed` (`RunResults`: `main_stuff` always present, `graph_spec` optional), 409→`failed` (terminal non-COMPLETED + message), 503→`running` (degraded, keep polling). |

Facts that shape the design:

- **`main_stuff` is the resolved main output content, always present on a completed run** (the ≥0.37 invariant). It is polymorphic `unknown` — object, array, or scalar. Image/file outputs come as URLs (hosted: signed S3 `public_url` and/or a `pipelex-storage://` url), not blobs.
- **A failed run's results 409 carries only a message.** There is no result object and no graph for a failed run (storage is success-only).
- **Per-pipe live progress does not exist on the wire today.** `pipe_statuses` is declared optional in the SDK's product `PipelineRun` model and in `pipelex-app`'s types, but the platform never emits it — the status route returns `RunPublic + degraded` only. So a live per-node graph is not buildable yet; the follow view gets coarse run status now, and per-node status later when the platform grows it.
- **The completed run's `graph_spec`** (`graphspec.json` from the worker) is the executed graph — `mthds-ui`'s `GraphSpec`, whose nodes carry a `PipeStatus`, and `GraphViewer` additionally accepts a `statusMap` override. So the *final* graph renders with success/failure per node using the component we already ship.
- **The SDK distinguishes "unknown run id" from "no lifecycle routes"**: a missing-route 404 throws `RunLifecycleUnavailableError` (bare runner), while an unknown-id 404 surfaces as a plain `ApiResponseError(404)`. The two must classify differently (config vs input_domain).
- **Skybridge views can call tools and read their `_meta`**: `useCallTool`'s response type exposes `meta` alongside `structuredContent` (verified in `skybridge/dist/web`: `CallToolResponse = { content, structuredContent, isError, meta? }`). This is what lets the follow view fetch a graph without pushing it through model context. Needs a live spike per host (see §7).
- **Hosted runs require auth**: `PIPELEX_API_KEY` becomes effectively mandatory for the run tools; a missing/bad key is a `config` no-verdict, same as today.

## 3. Functional design

### UX flow: run a method

1. The assistant (usually after `mthds_validate` and `mthds_inputs`) calls `mthds_run` with the file contents, the pipe to run, and the filled inputs.
2. The tool starts the run and returns the durable `run_id` immediately. The **run-follow view** renders above the response and follows the run on its own — the user watches it without prompting the assistant.
3. If the user asks "how is it going?", the assistant calls `mthds_run_status` — one cheap read, with a retry hint in the summary so it doesn't spin-poll.
4. When the run is terminal, the assistant calls `mthds_run_results` to report: the main output (bounded) on success, or the failure message otherwise. The view has typically already shown both.
5. Because everything is behind the durable id, the whole flow survives conversation gaps: days later, "what did that run produce?" is a single `mthds_run_results` call, and reopening the conversation remounts the view, which re-resolves the run state by id.

A single tool call never occupies the conversation while the method executes (I5). The MCP stays stateless: all run state lives behind the id on the platform (DynamoDB + Temporal).

### Tool surface

Naming (decided, §6.1): the family `mthds_run` / `mthds_run_status` / `mthds_run_results` — a scannable `mthds_run*` group, echoing the wire routes `/runs/{id}/status|results`.

**Tool: `mthds_run`** — start a durable run. *Not* read-only; the description states it executes the method on the hosted API and **spends inference credit**.

```ts
// input
{
  files: Array<{ content: string; uri?: string | null }>;  // the shared submitted-files shape
  pipe_code?: string;          // pipe to run; omitted → server resolves the bundle's main pipe (confirmed, §7-Q1)
  inputs?: Record<string, unknown>;  // PipelineInputs, as filled from the mthds_inputs template
}

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;             // the durable pipeline_run_id — the handle for everything else
  run_status?: RunStatus;      // initial state from the ack (e.g. "STARTED")
  created_at?: string;
  available_view_specs: Array<"live_run_status">;
  errors?: ToolError[];        // no-verdict only: bad request shape, 4xx at start, config, runtime
}
```

`content` summary: run accepted, the id, and explicit follow-up etiquette for the model ("the view follows the run live; call `mthds_run_status` to check, `mthds_run_results` when terminal — don't poll in a tight loop"). View: `run-follow` (below). Deliberately **not** exposed in v1: `output_name`, `output_multiplicity`, `dynamic_output_concept_ref` (rare knobs; add when a consumer needs them), `extra`, webhooks, client-supplied run ids.

**Tool: `mthds_run_status`** — check on a run. Read-only, plain tool (no view).

```ts
// input
{ run_id: string }

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;
  run_status?: RunStatus;      // the coarse lifecycle state
  is_terminal?: boolean;       // convenience so the model needn't know the status set
  degraded?: boolean;          // true → status is last-known, not freshly derived
  retry_after_seconds?: number | null;
  created_at?: string;
  finished_at?: string | null;
  errors?: ToolError[];
}
```

`content` summary while non-terminal includes "check again in ~Ns" from the retry hint. **A FAILED/CANCELLED/TIMED_OUT run is a produced verdict** — `status: "ok"` with the terminal `run_status`, not an `errors[]` no-verdict (see "Verdict discipline" below; this deviates from the older workspace spec text, deliberately).

**Tool: `mthds_run_results`** — report the results. Read-only.

```ts
// input
{ run_id: string }

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";   // mirrors the SDK's RunResultState
  retry_after_seconds?: number | null;          // state=running only
  run_status?: RunStatus;                       // state=failed only (terminal status)
  failure_message?: string;                     // state=failed only
  main_stuff?: unknown;                         // state=completed only — bounded, see §6.4
  truncated?: boolean;                          // true when main_stuff was bounded down
  available_view_specs: Array<"run_graph">;     // populated when graph_spec rides _meta
  errors?: ToolError[];
}
```

On `completed`, `content` composes a Markdown summary with the main output in a fenced ` ```json ` block (the `mthds_inputs` pattern: the payload the model must read is deliberately duplicated into the prose), bounded by the same cap as `structuredContent`. The executed `graph_spec` rides `_meta.graph_spec` — view-only, never model context — consumed by the follow view (and optionally a view on this tool, §6.5). A `state: "running"` result is a produced verdict too ("no result *yet*" is an answer): `status: "ok"`, with the retry hint.

### Verdict discipline for runs

Same two-level discipline as validate/inputs, adapted: **`status: "ok"` = the API answered the question about the run** — including "it failed" and "not done yet". `status: "error"` + `errors[]` is reserved for no-verdict conditions:

- `input_domain` — empty/blank `run_id`, blank `pipe_code`, request-shape 400/422 at start (invalid bundle refused at submission), **unknown `run_id` (404 on the run routes)**.
- `config` — missing/invalid `PIPELEX_API_KEY` (401/403), unreachable API, `RunLifecycleUnavailableError` (base URL points at a bare runner — durable runs need the hosted API).
- `runtime` — 5xx, malformed report (e.g. completed result missing `main_stuff` → the SDK's `MissingMainStuffError`).

This needs one small extension to `ClassifyErrorOptions`: today a 404 is hard-wired to `config` ("route missing"). The run capabilities pass a per-route override so an `ApiResponseError(404)` classifies as `input_domain` ("no run with this id"), while `RunLifecycleUnavailableError` (which the SDK already separates via the problem-body missing-route marker) keeps the `config` arm.

### The run-follow view

A new Skybridge view component, `run-follow`, registered on `mthds_run`. It is the "basic UI to follow the durable run":

- **Status card** (the `pipelex-starter-js` `RunStatus` pattern): friendly status label (Queued / Starting / Running / Finalizing / Failed / …), elapsed wall-clock, spinner, and a non-alarming health note when a poll tick hits a transient blip or a degraded read ("Reconnecting — your run is still going").
- **Self-polling**: the view reads `run_id` from its tool output and polls `mthds_run_status` via `useCallTool` on a timer — no model turns, no conversation noise (exactly the I5 intent: "a UI app may poll status/result programmatically without routing each poll through agent reasoning"). Cadence: start at ~2s, honor `retry_after_seconds` when the server sends one, back off gently (cap ~10s) as elapsed grows, pause while the tab is hidden (`visibilitychange`), stop on terminal. Transient poll failures (unreachable/5xx) retry with the same backoff, mirroring the starter's `isTransientPollError`; a hard error (auth, unknown id) stops polling and shows the classified message.
- **On COMPLETED**: one `mthds_run_results` call; render the executed graph from the response's `meta.graph_spec` with `GraphViewer` (per-node success/failure via the spec's baked statuses), plus a compact output preview — pretty-printed JSON for objects/arrays/scalars, inline `<img>` when the output narrows to an image-like `{ url / public_url }` shape. Fullscreen toggle reused from `run-graph`.
- **On failure**: the terminal status and the failure message from the results 409. No graph is available for failed runs today — the card says so rather than showing an empty canvas.
- **Model visibility**: the card carries a `data-llm` annotation ("Run 01J…: RUNNING, 34s elapsed" / "COMPLETED — output shown") and mirrors the last-known snapshot into `useViewState`, so the assistant can answer "is it done?" from what the user is already looking at, without a tool call.
- **Graph while running** (decided, §6.3): none in v1 — the card carries the wait; the graph appears with the results. The view-side lazy dry-run graph (calling `mthds_validate` from the view) is recorded as a later increment.
- **Reopen behavior**: on remount the view re-resolves by id — one status poll; if terminal, one results fetch. The durable id makes the view as resumable as the run.

## 4. Technical design

New files, mirroring the existing capability layout:

- `src/capabilities/run.ts` — the run capability trio: Zod input/output schemas; `startMthdsRun`, `getMthdsRunStatus`, `getMthdsRunResults` (each takes a `RunContext { config, client? }` with the same injected-fake-client test seam as `ValidationContext`/`InputsContext`); pure projection functions `startResult`, `statusResult`, `resultsResult` exported for isolation tests; per-route `ClassifyErrorOptions` (404 override, start-route 400/422 hint pointing at `files`/`pipe_code`/`inputs`).
- `src/capabilities/run.test.ts` — fake-client tests: ack projection; non-terminal/terminal/degraded status; running/completed/failed results; truncation; unknown-id 404 vs `RunLifecycleUnavailableError` classification; missing-main-stuff hard error.
- `src/capabilities/shared.ts` — extend `ClassifyErrorOptions` with the 404 override; add a `validateRunIdRequest` shape check (non-empty trimmed id; format stays server-owned).
- `src/views/run-follow.tsx` — the follow view. The poll loop is a small self-contained hook (`useRunPolling`) so cadence/backoff/visibility logic is testable in isolation from rendering.
- `src/server.ts` — register the tools: `mthds_run` (readOnlyHint: false, destructiveHint: false, openWorldHint: false, credit-spending description, `view: { component: "run-follow" }`, OpenAI invocation labels), `mthds_run_status` / `mthds_run_results` (readOnlyHint: true). Extend the server `instructions` with one sentence on the run lifecycle.

Wire mapping is 1:1 onto the SDK — `mthds_run` → `client.start({ pipe_code, mthds_contents, inputs })` (contents from `files[].content`; note `/v1/start` takes no source labels, so `uri` is provenance for our own request-shape errors only), `mthds_run_status` → `client.getRunStatus`, `mthds_run_results` → `client.getRunResult`. The MCP never uses `waitForResult`/`startAndWaitForResult` (blocking wrappers) and never surfaces `result_url` or other presigned URLs into model context (spec rule).

Docs/config impact: SPEC.md gains the run flow + tool contracts and **drops "run execution, status polling" from Non-Goals** (superseded by the hosted-only pivot; blocking `execute` and cancellation stay non-goals). README + repo CLAUDE.md updated alongside; CHANGELOG under `[Unreleased]`. Workspace-side, `../docs/specs/pipelex-mcp.md` (still describing the pre-implementation scaffold and the older run-tool contract) gets reconciled to whatever we decide in §6.1–6.2 — it is all `<!-- unverified -->` greenfield, so this is prose-only; no conformance tests exist for this surface yet.

## 5. Settled by prior decisions (not reopened)

- **Async-start-only** (I5): no blocking calls, no long-held requests, follow-up explicit by id. Matches "We won't support blocking calls."
- **Stateless MCP**: no server-side run registry, no webhooks, no progress notifications; the id is the only state.
- **Output streams**: contract in `structuredContent`, presentation in `content`, big view-only artifacts (graphs) in `_meta`, `available_view_specs` as the model's signal that a view exists.
- **Brand boundaries**: `mthds_` prefix holds — running a method is a standard operation (`POST /start` *is* protocol); the durable polling routes are hosted plumbing behind it, and the spec already commits the tool surface to MTHDS branding.

## 6. Decisions — options weighed, outcomes recorded

### 6.1 Tool names — **DECIDED (2026-07-15): A**

- **A (chosen): `mthds_run`, `mthds_run_status`, `mthds_run_results`.** One scannable family prefix; mirrors the wire (`/runs/{id}/status|results`); `mthds_run` matches the spec's start-tool name. Con: not verb-first for the two readers.
- **B: spec names — `mthds_run`, `mthds_get_run_status`, `mthds_get_run_result`.** Verb-explicit per the spec's stated convention. Con: longer, breaks the family grouping in hosts' tool lists; the repo already drifted from the spec once (`mthds_inputs` vs `mthds_get_input_schema`), and the spec is the document that follows the implementation here. `../docs/specs/pipelex-mcp.md` gets reconciled to the chosen names in Phase 4.

### 6.2 Separate status/results vs one polling tool — settled: separate

- **A (chosen): separate, as Louis proposed and as I5 resolved.** Status is a cheap frequent read; results is a one-shot potentially-large read. The model's decision tree is explicit, and the view polls the cheap one.
- **B: merged single `mthds_run_status` that inlines results when terminal.** One fewer tool and one fewer round-trip at the end. Cons: every poll response schema carries the result fields; the view's frequent polls ride a tool that can suddenly return a large payload; "report the results from last week" reads oddly as a *status* call. Not worth it.

### 6.3 Graph while the run executes — **DECIDED (2026-07-15): A for v1; C recorded as a later increment**

- **A (chosen for v1): none** — status card only; graph appears on completion. Simplest, zero extra calls, zero host risk.
- **B: server-side** — `mthds_run` also calls `/v1/validate` and ships the dry-run graph on its own `_meta`. Pro: graph is there instantly, even if tool-calls-from-view prove flaky on some host. Cons: a dry run per start (latency + server work) even when nobody looks at the view; duplicates what the assistant usually just did.
- **C (later increment): view-side lazy** — the view calls `mthds_validate` through `useCallTool` with the `files` from its input and reads `meta.graph_spec`. Zero cost when unwatched; reuses the existing tool verbatim; verified type-level (`CallToolResponse.meta`). Needs the same host spike as the results-fetch-from-view (§7.2), which v1 requires anyway — so C can land as soon as the spike passes and someone wants it.

### 6.4 Bounding `main_stuff` — **DECIDED (2026-07-15): A**

An output can be huge (long array of structured items, big markdown). Unbounded, it lands twice in model context (structured + fenced summary).

- **A (chosen): bound it now.** Serialize; if over a cap (~32KB serialized, tune later), truncate the structured copy deterministically (JSON: prune deepest/longest collections with an ellipsis marker; text: head+tail) and set `truncated: true`; the summary says what was cut. The **full** output always rides `_meta` for the view. The spec already reserves exactly this (`truncated` flag, bounded result, "resources for full output" later).
- **B: ship it whole, bound later.** Simpler v1, matches `mthds_inputs` (whose templates are naturally small). Con: first big image-gen/list run floods the context; retrofitting the flag later is a breaking-ish contract change we'd rather not make twice.

### 6.5 A view on `mthds_run_results` too?

When the model calls results directly in a fresh conversation, a registered view would render the executed graph there as well — it means generalizing the `run-graph` component (today it reads `useToolInfo<"mthds_validate">` and branches on `is_valid`). Recommended: **defer** — the follow view already covers the primary UX (it refetches results by id on remount), and the generalization is a clean later increment. The `available_view_specs` kind (`"run_graph"`) is minted now either way so the contract doesn't move.

### 6.6 "Report to chat" from the view

`sendFollowUpMessage` lets the view hand the conversation back to the model. Auto-firing on completion would create unsolicited turns (and likely host friction). Recommended: a **user-triggered button** on the terminal card — "Summarize in chat" — that sends a canned prompt ("The run completed — report the results"). Cheap, opt-in, and it closes the loop for a user who walked away from the chat. Can be dropped from v1 without touching contracts.

→ **RESOLVED: KEPT (Phase 3, 2026-07-15)**. It was genuinely cheap: one `useSendFollowUpMessage` hook plus a button next to the fullscreen toggle on the completed card, sending the canned prompt and flipping to a disabled "Asked in chat" state (re-enabled if the send rejects). Verified in DevTools: the click emits a `sendFollowUpMessage` event on the host bridge (visible in the DevTools Logs pane). The failed card does not get the button in v1 — the failure message is already fully in model context, so there is nothing extra for the model to fetch.

## 7. Open questions (need your input or a live check)

1. **`pipe_code` omitted at `/v1/start`** — does the hosted runner resolve the bundle's main pipe like the build routes do, or reject? Determines whether `pipe_code` is optional or required in the tool schema. → **RESOLVED (Phase 2 live check, 2026-07-15, prod)**: omitted `pipe_code` resolves the bundle's declared `main_pipe` — the run was accepted and COMPLETED. `pipe_code` stays optional in the tool schema.
2. **Widget-initiated tool calls per host** — confirm ChatGPT and Claude both allow the view to call read-only tools without user confirmation, and pass `_meta` through `useCallTool`. This gates 6.3-C and the results-fetch-from-view; the status-card core works regardless… only if polling works, so this spike is the first thing to do in the view phase. → **PARTIALLY RESOLVED (Phase 3 spike, 2026-07-15)**. Per-host matrix: **DevTools: PASS** — a minimal view registered on `mthds_run` polled `mthds_run_status` through `useCallTool` with no confirmation prompt (live hosted run: RUNNING ×3 → COMPLETED), then called `mthds_run_results` and read `meta` off the `CallToolResponse`: keys `["graph_spec", "main_stuff"]`, both non-null across the transport. Type-level confirmation also holds (`CallToolResponse.meta?: CallToolResult["_meta"]` in skybridge's web bridge types). **ChatGPT: PENDING** / **Claude: PENDING** — both need an interactive host session (Alpic tunnel + connector), to be run with Louis before Checkpoint 3 closes. Spike implementation note: the async callers returned by `useCallTool` change identity per render — a poll effect that lists them as dependencies cancels itself on every render and the loop dies silently; pin them in a ref and depend on `run_id` only (the shipped `useRunPolling` hook does this).

   **Shipped-card DevTools verification (2026-07-15, hosted API, twice end-to-end):** the real `run-follow` card followed a live `hello_world` run start→terminal with zero model turns — status card (label + elapsed + spinner, with the "reconnecting" health note during an early degraded read) → completed card with the executed graph in `GraphViewer` (from `meta.graph_spec`) and the haiku output preview (from `meta.main_stuff`). Dark theme, pip, and the fullscreen toggle all render correctly. Model visibility verified in the View state pane: `{ run_id, last_known: "completed" }` from the explicit `useViewState` mirror plus `__view_context: "- Run <id>: COMPLETED — output shown with the executed graph."` — note that **Skybridge compiles `data-llm` JSX attributes into `<DataLLM>` registrations**, so the string never appears as a DOM attribute; it rides `viewState.__view_context`. Verify via view state, not the DOM. **Reopen/remount re-resolve could not be simulated in DevTools** (it keeps the view iframe mounted across panel collapse and drops tool output on page reload); the code path is identical to the live-verified mount flow (mount → one status read → terminal → one results fetch), and the true conversation-reopen check folds into the pending real-host arm.
3. **Start-time rejection of invalid bundles** — does `/v1/start` 422 on an unparseable bundle, or 202-then-FAILED? Both arms are handled either way; the answer decides how much "validate first" nudging the tool description needs. → **RESOLVED (Phase 2 live check, 2026-07-15, prod)**: neither — the hosted `/v1/start` rejects at submission with a generic **503** `pipeline_start_unavailable` ("Failed to start pipeline"), indistinguishable on the wire from real platform trouble (the same 503 covers an invalid bundle and missing required inputs). Consequences taken: (a) `RUN_START_ERROR_OPTIONS` grew a per-route `serverError` hint (a `ClassifyErrorOptions` extension) pointing the agent at `mthds_validate`/`mthds_inputs` before blaming the platform; (b) the `mthds_run` description carries a strong "validate first" nudge. **Platform bug candidate to flag**: an invalid bundle at `/v1/start` should be a 422, not a 503 — until then the MCP cannot classify it as `input_domain`. Also observed: a run that fails *during* execution (unreachable image-URL input) starts fine (202) but stayed RUNNING under Temporal retries (with `degraded: true` on every status read) beyond a 10-minute watch — a terminal FAILED could not be produced live; the `failed` results arm stays covered by unit tests against the SDK contract.
4. **Inputs with binary content** — the template flow covers text/structured inputs well; PDFs/images would need data-URLs (impractical through model context) or reachable https URLs. OK to declare "files ride URLs; storage upload tool is a later increment" in SPEC.md? (The product surface already has upload routes when we want it.) → **RESOLVED (Phase 1)**: declared in SPEC.md (Run Scope: "Binary inputs ride reachable https URLs inside `inputs`; a storage upload tool is a later increment", mirrored in Non-Goals).

## 8. Implementation plan

**Phase 1 — contract.** Update SPEC.md (flows, tool contracts, revised Non-Goals) per the decisions above; add the Zod schemas and `RunContext`; write the projection + classification tests against fakes (contract-first). Exit: `make check` green with the capability skeleton and tests passing.

**Phase 2 — capabilities.** Implement the SDK calls + projections; extend `classifyError`; register the tools in `server.ts` with annotations/labels/instructions; smoke-test the trio end-to-end against the hosted API from `make dev`.

> **Checkpoint A** — tools shipped and verified against the hosted API; view not started. Update this doc: decisions taken in §6/§7, live-check answers, any contract drift. Good handoff point for a fresh session.

**Phase 3 — the follow view.** Spike question 2 first (DevTools, then ChatGPT + Claude) — the view's own status polling and results fetch depend on it. Build `run-follow`: status card + `useRunPolling` + terminal results rendering (graph on completion only, per 6.3); then 6.6's button if kept. The 6.3-C live dry-run graph stays out of v1. Verify in DevTools and at least one real host.

**Phase 4 — docs & release.** README, CHANGELOG, repo CLAUDE.md; reconcile `../docs/specs/pipelex-mcp.md`; deploy via `make deploy`.

> **Checkpoint B** — before release: re-read this doc top to bottom, fold reality back into it, confirm SPEC.md/README/spec-doc agree, then cut the release via `/release`.
