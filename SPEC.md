# Pipelex MCP

## Value Proposition

Pipelex MCP lets developers and coding agents validate MTHDS content, project a method's declared inputs, and run methods durably on the hosted Pipelex API from inside an MCP host while they are authoring, repairing, or running `.mthds` files.

Target users are Pipelex/MTHDS developers working with an AI assistant in a local development loop. Today, validation requires leaving the assistant flow, knowing the local OSS `pipelex-api` or SDK details, and manually mapping diagnostics back to file content. The first product slice is intentionally narrow: validate submitted MTHDS file contents and return structured results the assistant can use to fix issues.

Core actions:

- Validate one or more submitted MTHDS files.
- Return valid, invalid, pending-signature, and no-verdict failure states in a stable structured result.
- Return optional graph data when requested and available.
- Project a pipe's declared inputs as a fill-in template (`mthds_inputs_template`), so an assistant can prepare inputs for a run without leaving the conversation. This unblocks the CLI-free skills in `../pipelex-plugins` (`pipelex-inputs`, `pipelex-design`) that used to shell out to `mthds-agent inputs bundle`.
- Start a durable run of a method on the hosted Pipelex API (`mthds_run`), then check on it (`mthds_run_status`) and report its results (`mthds_run_results`) by durable run id — the run outlives any single tool call and even the conversation.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.

**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.

**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to local OSS `pipelex-api`, or structured verdicts such as pending signatures, validation errors, and graph specs. It also cannot resolve a pipe's effective input contract (needs of the pipe minus what upstream pipes produce) — that projection is computed by the API from the parsed closure.

## UI Overview

`mthds_validate` ships a Skybridge view, `run-graph`: on a positive verdict that carries a `graph_spec`, a Skybridge-capable host renders an interactive method graph (via `@pipelex/mthds-ui`'s `GraphViewer`) inline above the model response, with a user-triggered fullscreen toggle for exploration. Invalid verdicts, pending-signature verdicts with no graph, and `include_graph: false` calls fall back to a compact, non-crashing empty state. The shared surface is the assistant conversation, the structured tool result, and this view.

`mthds_run` ships a second Skybridge view, `run-follow`: a self-polling status card that follows a durable run live (friendly status label, elapsed wall-clock, spinner) without any model turns — it polls the read-only `mthds_run_status` on a timer via `useCallTool`. On completion it fetches `mthds_run_results` once and renders the executed graph from the response's view-only metadata plus a compact output preview; on failure it shows the terminal status and failure message (and states plainly that no graph exists for failed runs). Once the terminal outcome is resolved (completed or failed), the view hands the conversation back to the model on its own via `sendFollowUpMessage` — one canned prompt naming the run id — so the assistant reports the outcome without the user prompting (the completion handoff, detailed in Run Scope). On remount it re-resolves the run by id, so reopening the conversation restores the card without re-firing the handoff.

**First view**: The MCP host lists the Pipelex tools: `mthds_validate`, `mthds_inputs_template`, `mthds_run`, `mthds_run_status`, and `mthds_run_results`. `mthds_validate` and `mthds_run` carry Skybridge views; the others are plain tools whose payloads are small structured data the model reads directly.

**Validation flow**:

1. The assistant submits `files` to `mthds_validate` — inline `{ content, uri? }` items, or `{ path }` items on the local workshop (see Deployments).
2. The MCP server validates request shape and provenance (the workshop resolves `{ path }` items from disk first; the console rejects them instructively).
3. The capability calls the Pipelex API (`POST /v1/validate`) through `@pipelex/sdk`'s `PipelexApiClient`.
4. The result is projected into stable MCP `structuredContent` plus a text summary.

**End states**:

- Valid runnable bundle: `is_valid=true`, `is_runnable=true`, optional graph spec.
- Valid pending-signature bundle: `is_valid=true`, `is_runnable=false`, populated pending signatures.
- Invalid produced verdict: `status="ok"`, `is_valid=false`, populated validation errors.
- No-verdict failure: `status="error"` with an error class of `input_domain`, `config`, or `runtime`.

**Inputs template flow**:

1. The assistant submits `files` (and optionally `pipe_ref`, `explicit`, `format`) to `mthds_inputs_template` — the same shared shape, `{ path }` items included on the workshop.
2. The MCP server validates request shape and provenance (same per-deployment `{ path }` behavior as validation).
3. The capability calls the Pipelex API (`POST /v1/build/inputs`) through `@pipelex/sdk`'s `PipelexApiClient`, adapting the `uri` provenance label to the build envelope's `source` field.
4. The result is projected into stable MCP `structuredContent` plus a text summary that includes the template itself in a fenced code block.

**End states**:

- Template produced: `is_valid=true`, resolved `pipe_ref`, template in `inputs` (json) or `inputs_toml` (toml).
- Unresolvable closure: `status="ok"`, `is_valid=false`, populated validation errors (the API's 200 verdict discipline — same as validation).
- No-verdict failure: `status="error"` with an error class of `input_domain`, `config`, or `runtime`. An unknown `pipe_ref` or a closure with no resolvable `main_pipe` (none declared, or several across domains) is a no-verdict error — the API rejects the request (422) rather than producing a verdict.

The richer error-grouping validation view (diagnostics grouped by class, clickable file/line locations, pending-signatures backlog) is a later increment; the `run-graph` view ships graph rendering only.

## Product Context

- **Existing products**: Pipelex, MTHDS, `@pipelex/sdk`, and the Pipelex API (local OSS `pipelex-api` during development).
- **App shell**: `pipelex-mcp`, a Skybridge MCP app scaffold — the hosted console. A second shell, the local workshop stdio server, shares its capability core (see Deployments).
- **Runtime API**: the hosted Pipelex API, defaulting to `https://api.pipelex.com` (point `PIPELEX_BASE_URL` at a local OSS `pipelex-api` on `http://localhost:8081` during development).
- **SDK dependency**: the `@pipelex/sdk` npm package (`PipelexApiClient`, published from `../pipelex-sdk-js`). It re-exports the `mthds/protocol` surface, so the MCP imports one SDK and still reaches the open protocol routes; `mthds` rides along as a transitive dependency.
- **Auth**: optional for the validation and inputs tools; local development normally runs without hosted auth. The run tools execute on the hosted API, so a key is effectively mandatory for them — a missing or invalid key is a `config` no-verdict. Each deployment sources the key differently: the workshop reads `PIPELEX_API_KEY` from the host-supplied process env; the hosted console is bring-your-own-key per request (see Deployments).
- **Primary environment variable**: `PIPELEX_BASE_URL`, defaulting to `https://api.pipelex.com`.

## Deployments

The product ships as **two servers from one repo and one capability core**, sharing one logical identity: the same server key (`pipelex`), the same tool names, the same structured contracts, and the same verdict discipline. The capability core (`capabilities/`) knows nothing about which shell invoked it.

- **Hosted console** — the existing Skybridge HTTP server, deployed on Alpic. Serves remote-connector hosts (ChatGPT, claude.ai, Claude Desktop/Cowork as consumers). Registers the Skybridge views (`run-graph`, `run-follow`). Auth is **bring-your-own-key (BYOK)** — the interim posture until per-user OAuth (the console auth workstream) ships: the console holds no server-side key; each caller supplies their own `plx_sk_` platform key at the transport level, via an `Authorization: Bearer plx_sk_...` header (hosts with header config) or `?api_key=plx_sk_...` on the connector URL (hosts whose connector UI accepts only a URL). The key never rides a tool argument, so it never enters the model's context. A BYOK key takes precedence over any server-held `PIPELEX_API_KEY`; a keyless request still handshakes and lists tools, and a keyless tool call fails as an instructive `config` no-verdict at `api_key` naming both channels (a server-held env key, when an operator sets one, keeps the env-var wording — it is the operator's concern, not the caller's). The middleware (`src/hosted/byok.ts`) verifies nothing — the Pipelex API is the authority on the key — and is deliberately disposable: when console OAuth lands it is deleted, not migrated.
- **Local workshop** — an npm-distributed stdio server (`@pipelex/mcp`, bin `pipelex-mcp`) that coding-agent hosts (Claude Code, Codex, Cursor, Cowork-as-builder) spawn via `npx`. Built on the plain MCP SDK (`McpServer` + `StdioServerTransport`) over the shared capability core. **Tools-first: it registers no views at launch** — the empirically verified V1 posture (view-rendering workshop hosts penalize localhost asset origins; the text summaries carry the flow on their own in text-only hosts). Auth is a per-user `plx_sk_` platform key in `PIPELEX_API_KEY`, supplied through the host's MCP server config env — per-user auth for free, no OAuth machinery.

**The `{ path }` arm and per-deployment behavior.** The shared submitted-files shape accepts two item forms — inline content or a file path:

```ts
type SubmittedFileInput = { content: string; uri?: string | null } | { path: string };
```

Both shells register this same union schema (so the tool contract never forks); what differs is behavior:

- The **workshop resolves `{ path }` from disk** before invoking the capability — this is its headline feature: near-constant token cost, byte-accurate reads, and real provenance (the resolved item carries `uri` = the submitted path, so diagnostics locate to files the agent can open and edit). Inline `{ content, uri? }` items stay accepted for parity.
- The **console rejects `{ path }` items** at request validation with an instructive `input_domain` no-verdict error located at `files[i].path`: this deployment cannot read files from disk; resubmit as `{ content, uri? }`, or use the local workshop server (`npx @pipelex/mcp`), which resolves paths. The rejection makes accidental misrouting diagnose itself on the first call — the failure mode to avoid is silent divergence between two servers carrying the same tool names.

An item is one arm or the other; on a malformed item carrying both keys, `content` wins (first-match union semantics) and `path` is ignored.

**Path trust boundary (workshop).** `{ path }` values resolve relative to the server's working directory — the host spawns the server in the workspace. Two bounds apply. **What** it reads: the `{ path }` arm is contracted to `.mthds` files, so the resolver rejects any path whose extension is not `.mthds` (case-insensitive) *before touching the filesystem* — it never opens a `.env`, `.git/config`, or key file a prompt-injected path could point at. **Where** it reads: containment is enforced by real-path check — the resolved target (symlinks followed) must live inside the working-directory subtree. Non-`.mthds` paths, escapes, missing files, and non-regular files are `input_domain` errors located at `files[i].path`. MCP client roots are deliberately not consulted in this increment — cwd containment is the simple, correct core; honoring host-declared roots is a possible later widening.

The extension gate is checked on the *submitted* path, which fully closes the prompt-injection vector (an injected path string is the only thing that threat controls). Two residuals require a local process with **write** access to the workspace and are accepted, not mitigated, in this increment: (a) a `.mthds`-named symlink pointing at an in-boundary non-`.mthds` file, and (b) a TOCTOU symlink swap between the real-path containment check and the read. Both demand an attacker who already holds direct read access to those same files (and stronger primitives, e.g. planting a malicious `.mthds`), so the resolver's fail-value contract gains nothing from an fd-based read-after-verify here.

**One host, one server.** A host should be connected to exactly one of the two shells, never both — same tool names on both mean a both-installed host has ambiguous routing. Notably, a claude.ai Pipelex connector syncs into Claude Code; a workshop user disables it there (`/mcp`) in favor of the local server.

## Naming Conventions

Tools are the contract; the `../pipelex-plugins` skills are the manual. The naming follows that split:

- **Server key: `pipelex`** — the product brand (Pipelex is the service; MTHDS is the language). Hosts derive their flattened tool names from it (`mcp__pipelex__mthds_validate` on Codex, `mcp__plugin_pipelex_pipelex__mthds_validate` on Claude Code).
- **Tool names: `mthds_<stem>`, snake_case** — operations on MTHDS-language artifacts. The `mthds_` prefix stays even though the server prefix could be argued to cover it: some hosts display or match bare tool names, generic verbs (`validate`, `run`) collide across servers in a multi-server session, and a `pipelex_` prefix would stutter against the server key.
- **Lifecycle families share a stem prefix** — `mthds_run`, `mthds_run_status`, `mthds_run_results` sort and display adjacently, so hosts and models see them as one family.
- **Names state what you get** — a noun-only name must name the artifact it returns (`mthds_inputs_template`, renamed from the ambiguous `mthds_inputs`); otherwise lead with the operation (`mthds_validate`).
- **Tools are self-sufficient; the dependency on skills is one-way** — tool names, descriptions, and the server `instructions` never reference the plugin skills, because many consumers (ChatGPT, claude.ai connectors, raw MCP hosts) will never see them. The skills reference tool names verbatim, and where a skill is the manual for one tool the two share a stem (`pipelex-inputs` ↔ `mthds_inputs_template`); that side of the convention is recorded in `../pipelex-plugins/docs/decisions.md`.

## Validation Scope (`mthds_validate`)

The public MCP input shape is:

```ts
{
  files: SubmittedFileInput[]; // { content, uri? } | { path } — see Deployments
  include_graph?: boolean;
}
```

`include_graph` defaults to true. The graph rides the tool result's view-only `_meta` channel (`_meta.graph_spec`, consumed by the `run-graph` view), never `structuredContent`. When false, omit it entirely.

The capability always permits pending signatures and always requests rendered markdown from the Pipelex API.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: Array<"dry_run_graph">;
  validation_errors?: unknown[];
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

The graph (`graph_spec`) is not part of `structuredContent`; on a positive verdict it rides the tool result's view-only `_meta` channel (`_meta.graph_spec`) for the `run-graph` view, so the model never pays its tokens. Because the model never sees `_meta`, `available_view_specs` is its signal that a view exists to surface: it lists the renderable view kinds for this result. The only kind for now is `"dry_run_graph"` — the method graph from the validation dry run, whose spec rides `_meta.graph_spec`. It contains `"dry_run_graph"` exactly when that spec was produced (valid verdict with `include_graph` not false), and is empty otherwise. On those same verdicts a short `## Views` note is appended to the `content` summary so agents that read the prose more reliably than the structured fields also learn the view exists.

The MCP `content` text contains the human-readable summary. The summary is not duplicated in structured output. On a no-verdict error (`status: "error"`), the content summary is a terse headline followed by a Markdown list of each `errors[]` entry — its `location`, `message`, and `hint`. This surfacing is shared by every tool (the same `toolResultContent` helper): the agent reads `content`, so the actionable detail the capability writes into `errors[]` (e.g. the hosted `{ path }` rejection naming the local workshop) must reach that stream, not sit only in `structuredContent.errors` where a host that shows the agent only the top content line would strand it. `structuredContent.errors` stays the untouched machine contract.

## Inputs Template Scope (`mthds_inputs_template`)

`mthds_inputs_template` projects a pipe's declared inputs as a fill-in template, wrapping `POST /v1/build/inputs` through `@pipelex/sdk`'s `buildInputs`. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` field — the template is small structured data the model must read, so it belongs in `structuredContent`.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[]; // { content, uri? } | { path } — see Deployments
  method_id?: string;           // catalog id (mt_…) of a registered method — files win when both are supplied
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}
```

- `files` mirrors `mthds_validate`'s shape for consistency. The SDK's build envelope spells the provenance label `source` (`MthdsFileItem`), so the capability adapts `uri` → `source` at its boundary, the way validate adapts to `/v1/validate`'s parallel arrays.
- `method_id` projects a registered method by its catalog id, via **fetch-and-forward**: the build routes have no by-id support, so the capability fetches the stored method (`GET /v1/methods/{id}` through the SDK's `getMethod`), parses the polymorphic `MethodData.mthds` source — either raw `.mthds` source or a JSON-serialized `[{ name, content }]` file array (the webapp editor format); the parsing helper mirrors the platform's canonical implementation — and forwards the resulting contents as the build envelope's files, each carrying the method id as its `source` provenance label so diagnostics point back at the registered method. At least one of (non-empty `files`, `method_id`) is required, else `input_domain`; a supplied-but-blank `method_id` is `input_domain` at `method_id`. When both are supplied, **files win and `method_id` is ignored** (the build routes have no linkage concept) — documented behavior, not an error. A stored method with no MTHDS source is an `input_domain` no-verdict at `method_id` ("the stored method has no MTHDS source yet"), raised without calling the build route. Fetch-leg failures classify against the route `/v1/methods/{id}`: an unknown or foreign-org id is a 404 → `input_domain` at `method_id` (the catalog is org-scoped to the key's org, so a foreign-org method reads exactly like a miss; unlike `/v1/start`, the SDK does not intercept a missing-route 404 on this route, so a bare-runner base URL reads the same — the hint covers both causes), a paywall 402 → `config` (the generic billing arm), and auth failures get the deployment's usual `config` texture — a key is required for by-id calls.
- `pipe_ref` is the pipe to project, as a qualified `domain.pipe_code`. Optional; it defaults server-side to the closure's declared `main_pipe`, which fails as a no-verdict error (API 422) when the closure declares none or several across its domains. `method_ref` is deliberately not exposed (the registry answers 501 today).
- `explicit` defaults to **false** (the light template shape); `true` requests the ceremonial `{concept, content}` envelope per input.
- `format` defaults to **"json"** (parsed template object in `inputs`); `"toml"` returns raw TOML text in `inputs_toml`, preserving concept comments and key order.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  format?: "json" | "toml";
  explicit?: boolean;
  inputs?: Record<string, unknown>;
  inputs_toml?: string;
  validation_errors?: unknown[];
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

Verdict discipline is identical to `mthds_validate`: any *produced* verdict is `status: "ok"`, discriminated on `is_valid`. On the valid arm the tool returns the resolved `pipe_ref` (always qualified), the echoed `format`/`explicit`, and the template on exactly one of `inputs` / `inputs_toml` (chosen by `format`; the unused field is absent). An unresolvable closure is a produced verdict: `is_valid: false` with `validation_errors[]` — the route answers 200 and consumers branch on the field, never on transport. `status: "error"` + `errors[]` is reserved for no-verdict conditions: bad request shape (`input_domain`), unreachable/misconfigured API or auth failure (`config`), unknown `pipe_ref` / unresolvable `main_pipe` default (API 422 → `input_domain`), or server faults (`runtime`) — classified by the same `classifyError` the validation capability uses.

The build routes return a plain `message` rather than `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe, the API message, and the template itself in a fenced code block (` ```json ` or ` ```toml ` to match `format`). Unlike validation, the template is deliberately duplicated between `structuredContent` and the summary — it is the payload the model must read, and some hosts read prose more reliably than structured fields.

## Run Scope (`mthds_run`, `mthds_run_status`, `mthds_run_results`)

The run family adds durable (async) method execution against the hosted Pipelex API, wrapping `@pipelex/sdk`'s run lifecycle (`client.start` → `POST /v1/start`, `client.getRunStatus` → `GET /v1/runs/{id}/status`, `client.getRunResult` → `GET /v1/runs/{id}/results`). The MCP adds no execution logic and stays stateless: all run state lives behind the durable `run_id` on the platform. The server never calls the blocking `POST /v1/execute` or the SDK's blocking wrappers (`waitForResult`, `startAndWaitForResult`), and never surfaces `result_url` or other presigned URLs into model context.

**Run UX flow**:

1. The assistant (usually after `mthds_validate` and `mthds_inputs_template`) calls `mthds_run` with the files (same per-deployment forms as validation), the pipe to run, and the filled inputs.
2. The tool starts the run and returns the durable `run_id` immediately. The `run-follow` view renders above the response and follows the run on its own — the user watches it without prompting the assistant.
3. If the user asks how it is going, the assistant calls `mthds_run_status` — one cheap read, with a retry hint in the summary so it doesn't spin-poll.
4. When the run reaches its terminal outcome, the view fires the completion handoff — a `sendFollowUpMessage` naming the run id — and the assistant answers it by calling `mthds_run_results` and reporting: the main output (bounded) on success, or the failure message otherwise. (The handoff fires after the view's own results fetch settled, so the assistant's results call lands past the mid-write race.)
5. Because everything is behind the durable id, the flow survives conversation gaps: days later, "what did that run produce?" is a single `mthds_run_results` call, and reopening the conversation remounts the view, which re-resolves the run state by id (silently — the handoff fires at most once per run).

**Tool: `mthds_run`** — start a durable run. *Not* read-only; its description states it executes the method on the hosted API and spends inference credit, and nudges validating the bundle first (see the start-time rejection note below).

```ts
// input
{
  files?: SubmittedFileInput[];      // the shared submitted-files shape ({ content, uri? } | { path } — see Deployments)
  method_id?: string;                // catalog id (mt_…) of a registered method — see run-by-reference below
  pipe_code?: string;                // pipe to run; omitted → server resolves the bundle's main pipe
  inputs?: Record<string, unknown>;  // method inputs, as filled from the mthds_inputs_template template
}

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;             // the durable pipeline_run_id — the handle for everything else
  run_status?: RunStatus;      // initial state from the ack, when the server includes one
  created_at?: string;
  available_view_specs: Array<"live_run_status">;
  errors?: ToolError[];        // no-verdict only
}
```

`RunStatus` is the hosted lifecycle set: `PENDING | STARTED | RUNNING | COMPLETED | FAILED | CANCELLED | TERMINATED | TIMED_OUT`. The `content` summary states the run was accepted, gives the id, and spells out follow-up etiquette for the model (check with `mthds_run_status`, fetch with `mthds_run_results` when terminal, don't poll in a tight loop). Deliberately not exposed in v1: `output_name`, `output_multiplicity`, `dynamic_output_concept_ref`, `extra`, webhooks, client-supplied run ids. Binary inputs (PDFs, images) ride reachable https URLs inside `inputs`; a storage upload tool is a later increment.

**Run-by-reference (`method_id`)**: the tool also starts a registered method by its catalog id, so the model never carries the bundle — a run of a registered method is a tens-of-tokens call from any host. `method_id` is a separate optional top-level argument beside a now-optional `files` — deliberately **not** a third arm on the files union (a method id is not a file, and a mixed array would falsely suggest merging) and not a distinct tool (one run tool for the model; the lifecycle family keeps its stem). Request shape: at least one of (non-empty `files`, `method_id`) is required, else `input_domain`; a supplied-but-blank `method_id` is `input_domain` at `method_id`; id format beyond non-blank stays server-owned (the same stance as `run_id`). Precedence mirrors the platform: **inline `files` win** — when both are supplied, the files run and `method_id` is recorded as the run-history linkage on the platform's Run row (the webapp's own semantics for saved methods); `method_id` alone resolves the stored method's source server-side, natively on `POST /v1/start` (no fetch round-trip, no bundle on the wire). Methods have no versioning: a by-id run always executes the method's **current** stored content — the tool description states this explicitly so agents don't assume a run pins what they previously validated. By-id calls require an API key (the catalog is org-scoped to the key's org); a keyless BYOK call fails with the existing instructive `config` auth texture.

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

The `content` summary while non-terminal includes "check again in ~Ns" from the retry hint.

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
  main_stuff?: unknown;                         // state=completed only — bounded, see below
  truncated?: boolean;                          // state=completed only; true when main_stuff was bounded down
  available_view_specs: Array<"run_graph">;     // populated when graph_spec rides _meta
  errors?: ToolError[];
}
```

On `completed`, `content` composes a Markdown summary with the main output in a fenced code block (the `mthds_inputs_template` duplication pattern: the payload the model must read is deliberately repeated in the prose), bounded by the same cap as `structuredContent`. The executed `graph_spec` and the **full** (unbounded) `main_stuff` ride the view-only `_meta` channel (keys mirror the API field names: `_meta.graph_spec`, `_meta.main_stuff`), never model context. A `state: "running"` result is a produced verdict ("no result *yet*" is an answer): `status: "ok"` with the retry hint. On `failed`, the summary carries the terminal status and failure message and states plainly that no graph exists for failed runs.

**Bounding `main_stuff`**: an output can be huge. The structured copy (and the fenced summary block) is bounded to a serialized cap (~32KB, tunable constant): JSON trees are pruned deterministically (deepest levels and longest collections first, with an ellipsis marker); plain text keeps head+tail. When bounded, `truncated: true` and the summary says the output was cut. The full output always rides `_meta` for views.

**Run verdict discipline**: `status: "ok"` means the API answered the question about the run — including "it failed" and "not done yet". A FAILED/CANCELLED/TIMED_OUT run is a produced verdict (`status: "ok"` with the terminal `run_status`), and so is a `state: "running"` results lookup. `status: "error"` + `errors[]` is reserved for no-verdict conditions:

- `input_domain` — empty/blank `run_id`, blank `pipe_code`, neither `files` nor `method_id` supplied, a blank `method_id`, request-shape 400/422 at start, unknown `run_id` (a 404 on the run routes with the server's structured error envelope), unknown `method_id` (a 404 on `/v1/start`, located at `method_id`, not retryable — the hint says to check the id as the catalog returned it; the catalog is org-scoped to the API key's org, so a method from another org reads exactly like a miss). On a by-id start the 400/422 arm covers two causes with one combined hint: the stored method may have no MTHDS source yet, and if the error mentions organization context the key's org binding is the issue (mint a key in the right org) — no message-sniffing to split them.
- `config` — missing/invalid `PIPELEX_API_KEY` (401/403), a paywall 402 (the org's plan does not cover the call — classified on the HTTP status, never the problem `code`, no location, not retryable, with a hint pointing at the org's plan/billing on app.pipelex.com; this arm is generic across routes), unreachable API, `RunLifecycleUnavailableError` (the configured base URL points at a bare runner — durable runs need the hosted API).
- `runtime` — 5xx, malformed report (e.g. a completed result missing `main_stuff`, the SDK's `MissingMainStuffError`).

The unknown-id 404 vs missing-route 404 distinction comes from the SDK: a missing lifecycle route throws `RunLifecycleUnavailableError` (`config`), while an unknown id surfaces as a plain 404 `ApiResponseError` (`input_domain`, via a per-route classification override). The same holds for an unknown `method_id` on `/v1/start`: any `ApiResponseError` 404 that reaches classification there is the platform's structured unknown-method envelope (a bare runner's missing-route 404 was already intercepted as `RunLifecycleUnavailableError`), so the `notFound` override at `method_id` is safe. The by-id classify options apply whenever the request carried `method_id` (with or without files); a files-only request keeps today's options so nothing regresses.

Every `errors[]` entry also carries `retryable` — whether retrying the same call may succeed. It is decided in `classifyError`, where the concrete SDK error / HTTP status is still known, because the class+locator pair alone cannot: an unreachable API (transient) and a missing run lifecycle (permanent) both classify as `config` at `PIPELEX_BASE_URL`, and a 5xx (transient) and a malformed report (permanent) are both `runtime`. The `run-follow` view's poll loops branch on this flag (`isTransientPollError`) — transient errors keep the follow alive with a reassuring note, hard errors stop polling and surface the classified message.

**Start-time rejection on the hosted API**: `/v1/start` reports runner-rejected submissions — an invalid bundle, missing required inputs — as a 422 carrying the real rejection reason (`input_domain`); earlier platform builds answered a generic 503 "Failed to start pipeline". The per-route 5xx hint is kept for any 503 that still occurs, pointing the agent at `mthds_validate` / `mthds_inputs_template` before blaming the platform, and the `mthds_run` tool description still nudges validating first — validation gives a structured, repairable verdict, where a start-time rejection only reports the failure.

**View: `run-follow`** (registered on `mthds_run`) — described in UI Overview. `available_view_specs` on `mthds_run` lists `"live_run_status"` when the view is registered; `mthds_run_results` lists `"run_graph"` when the executed graph rides its `_meta` (the kind is minted now; a view directly on the results tool is a later increment).

**Completion handoff**: when the view resolves the run's terminal outcome — its results fetch settles on `completed` or `failed` — it fires one `sendFollowUpMessage` with a canned prompt naming the run id ("Run <id> completed — report the results." / "Run <id> failed — report what went wrong."), handing the conversation back to the model so the assistant reports the outcome without the user prompting. This deliberately reverses the earlier opt-in-only stance (design note §6.6): an unsolicited turn that closes the loop on a run the user started is worth more than the silence. Rules:

- **At most one handoff per run.** A `notified` flag rides the host-persisted view state (alongside `run_id`/`last_known`), so a remount of an already-notified run — reopening the conversation — stays silent; an in-mount ref guards the window while the view-state write round-trips.
- **Best-effort, never retried in-session.** A host that rejects the view-initiated turn gets no in-session retry (a reject → rollback → retry loop otherwise); the persisted flag rolls back so a later remount may attempt once more. The "Summarize in chat" button on the completed card remains as the manual re-trigger/fallback, sending the same run-id-bearing prompt.
- **Run outcomes only.** Hard poll errors and results-fetch errors never auto-fire — they are failures of the *follow*, not of the run (which may still be executing server-side); those cards keep their `data-llm` text only.
- **Both outcomes notify.** A failed run hands off too — the failure is precisely when the user wants the assistant to step in and explain.

**Output image trust model**: an image `public_url` in `main_stuff` renders in the completed card only inside two containment layers. First, `narrowImageUrl` accepts nothing but `http(s)` URLs that are image-shaped or carry an `image/*` mime hint — no other scheme reaches the DOM. Second, the view's CSP `resourceDomains` is a tight host allowlist naming exactly the hosted platform's per-env storage buckets (`pipelex-app-{dev,staging,prod}.s3.us-west-2.amazonaws.com`, where run outputs are served as presigned URLs) — never a wildcard; any other host (including a third-party generation-provider URL leaking through `main_stuff`) is refused by the host CSP before a request leaves the browser. These URLs stay view-only: they ride `_meta` and are never surfaced into model context (consistent with the `result_url` rule above). A failed image load — expired presigned URL, CSP-blocked host — falls back to the text preview instead of a broken image.

## Non-Goals

The server must not add Pipelex Hosted API deployment behavior, OAuth token verification (the hosted console's bring-your-own-key middleware forwards the caller's key and verifies nothing — the API is the authority; see Deployments), blocking execution (`POST /v1/execute` or the SDK's blocking wrappers), run cancellation, resources, logs, package publishing (of MTHDS method packages to a registry — not this server's own npm distribution, which is how the workshop ships; see Deployments), subprocess fallbacks, or a production validation UI. Filesystem reads are scoped per deployment: the **hosted console** never reads files (a `{ path }` submission is rejected instructively — see Deployments); the **local workshop** reads exactly the `{ path }` items submitted to it, within its trust boundary. The workshop registers no views at launch (tools-first — see Deployments); local view delivery is a later increment gated on self-contained view bundles. Also out of scope for this increment: per-user OAuth, and a storage upload tool for binary inputs (binary inputs ride reachable https URLs; upload is a later increment). Registered-method runs by catalog id are in scope (`method_id` on `mthds_run` and `mthds_inputs_template` — see Run Scope and Inputs Template Scope); around that catalog surface, these stay out: `mthds_validate` by id (a registered method was validated at publish, and "show me a registered method's graph" belongs to the undecided conducted-views workstream), catalog discovery tools (listing methods or fetching method detail — the id arrives out-of-band until those land; they are the natural next increment after this one), a publish/save tool from the workshop, and stored-`input_data` defaulting (an omitted `inputs` passes through as-is; platform behavior governs).

Repository quality gates are in scope: ESLint, Prettier, TypeScript type checking, Vitest unit tests, and a combined `npm run check` command should remain available locally.

The prototype should call the Pipelex API (local OSS `pipelex-api` during development) only through `@pipelex/sdk`'s `PipelexApiClient`; it should not expose API internals such as `mthds_contents` or `mthds_sources` in the MCP schema.

## UX Flows

Validate MTHDS files:

1. The user asks the assistant to validate one or more `.mthds` files.
2. The assistant submits the files to `mthds_validate` — inline contents with optional provenance URIs, or `{ path }` items on the local workshop (see Deployments).
3. The tool returns structured validation facts plus a text summary that the assistant can use to repair the files.
4. The assistant may repeat the same flow after editing the submitted source content.

Prepare inputs for a method:

1. The user asks the assistant to prepare inputs for a `.mthds` method (or a skill needs the method's input schema).
2. The assistant submits the files (and optionally a qualified `pipe_ref`) to `mthds_inputs_template` — same per-deployment file forms as validation.
3. The tool returns the fill-in template plus the resolved pipe, which the assistant fills with user data, synthetic data, or placeholders.
4. On an invalid closure, the tool returns the validation errors instead; the assistant can repair via the validation flow and retry.

Run a method durably:

1. The user asks the assistant to run a `.mthds` method (usually after validating it and filling the inputs template).
2. The assistant submits the files (same per-deployment forms as validation), the pipe to run, and the filled inputs to `mthds_run`; the tool returns the durable `run_id` immediately and the `run-follow` view follows the run live.
3. The assistant checks on the run with `mthds_run_status` when asked (honoring the retry hint rather than spin-polling); when the run reaches its terminal outcome the view's completion handoff prompts the assistant, which reports via `mthds_run_results`.
4. Days later, the same `run_id` still answers `mthds_run_status` / `mthds_run_results` — the run is durable and the MCP is stateless.

Run a registered method by reference:

1. The user names a registered method by its catalog id (`mt_…`) — obtained out-of-band for now (the webapp catalog, a teammate); catalog discovery tools are the natural next increment.
2. The assistant calls `mthds_inputs_template` with `method_id` (no files) and fills the returned template with user data.
3. The assistant calls `mthds_run` with `method_id` and the filled `inputs` — no bundle ever enters the conversation, and the run executes the method's current stored content.
4. Everything downstream is unchanged: the `run-follow` view, `mthds_run_status`, and `mthds_run_results` operate on the durable `run_id` and don't care how the run started.

## Tools and Views

**Server instructions**: The server sets a short MCP `instructions` string (server-wide, on the `McpServer` constructor options) that hosts surface to the model. It states that the server validates `.mthds` method files (returning an interactive dry-run graph on a valid verdict), projects a method's declared inputs as a fill-in template, and runs methods durably on the hosted Pipelex API (start from files or from a registered method's catalog id, then check status and fetch results by durable run id). It is a server-level hint only — argument-level detail stays in the tool `description`.

**Tool: `mthds_validate`**

- **Input**: `{ files, include_graph? }`
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, available_view_specs, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. On a positive verdict the graph rides the view-only `_meta` channel (`_meta.graph_spec`), never `structuredContent`; `available_view_specs` tells the model the `"dry_run_graph"` view is available to surface.
- **Behavior**: Validates request shape, calls the Pipelex API against `PIPELEX_BASE_URL` or `https://api.pipelex.com` with signatures and markdown enabled, and maps produced validation verdicts into flattened structured content.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: `run-graph` — renders `_meta.graph_spec` with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle); compact empty state when there is no graph.

**Tool: `mthds_inputs_template`**

- **Input**: `{ files?, method_id?, pipe_ref?, explicit?, format? }` — at least one of `files` / `method_id` (see Inputs Template Scope)
- **Output**: `{ status, is_valid, pipe_ref?, format?, explicit?, inputs?, inputs_toml?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that includes the template in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/build/inputs` against `PIPELEX_BASE_URL` or `https://api.pipelex.com` (adapting `uri` → `source`), and maps the produced verdict into flattened structured content with the same `status`/`is_valid` discipline as `mthds_validate`. With `method_id` and no files, fetch-and-forward: `GET /v1/methods/{id}` resolves the stored method's source, which is forwarded to the build route (files win when both are supplied).
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — the template is small structured data the model reads directly.

**Tool: `mthds_run`**

- **Input**: `{ files?, method_id?, pipe_code?, inputs? }` — at least one of `files` / `method_id` (see Run Scope)
- **Output**: `{ status, run_id?, run_status?, created_at?, available_view_specs, errors? }` in `structuredContent`, plus a start-ack text summary in MCP `content` with the run id and follow-up etiquette.
- **Behavior**: Validates request shape, then starts a durable run via `POST /v1/start` (fire-and-forget 202) — from inline files, or from a registered method's current stored content by `method_id` (files win when both are supplied; the id then rides as run-history linkage — see Run Scope). Never blocks on the result.
- **Annotations**: NOT read-only (`readOnlyHint: false`), non-destructive, no open-world publishing. The description states it executes the method on the hosted API and spends inference credit.
- **View**: `run-follow` — the self-polling live status card described in UI Overview; on the terminal outcome it fires the once-per-run completion handoff (see Run Scope) so the assistant reports unprompted. Untouched by run-by-reference: it follows by `run_id` and assumes nothing about how the run started.

**Tool: `mthds_run_status`**

- **Input**: `{ run_id }`
- **Output**: `{ status, run_id?, run_status?, is_terminal?, degraded?, retry_after_seconds?, created_at?, finished_at?, errors? }` in `structuredContent`, plus a text summary with a check-again hint while non-terminal.
- **Behavior**: One cheap self-healing status read (`GET /v1/runs/{id}/status`). A terminal non-COMPLETED status is a produced verdict, not an error.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none.

**Tool: `mthds_run_results`**

- **Input**: `{ run_id }`
- **Output**: `{ status, run_id?, state?, retry_after_seconds?, run_status?, failure_message?, main_stuff?, truncated?, available_view_specs, errors? }` in `structuredContent`, plus a text summary that on `completed` repeats the bounded main output in a fenced code block. The executed graph and the full unbounded output ride the view-only `_meta` channel (`_meta.graph_spec`, `_meta.main_stuff`); `available_view_specs` lists `"run_graph"` exactly when the graph rides `_meta`.
- **Behavior**: One-shot result lookup (`GET /v1/runs/{id}/results`), discriminated on `state`: `running` (with retry hint), `completed` (bounded `main_stuff` + `truncated` flag), `failed` (terminal status + failure message; no graph exists for failed runs).
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none in this increment (the `"run_graph"` view-spec kind is minted now; a view directly on this tool is a later increment — the `run-follow` view already fetches and renders these results).
