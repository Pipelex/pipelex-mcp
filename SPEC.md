# Pipelex MCP

## Value Proposition

Pipelex MCP lets developers and coding agents validate MTHDS content, project a method's declared inputs, and run methods durably on the hosted Pipelex API from inside an MCP host while they are authoring, repairing, or running `.mthds` files.

Target users are Pipelex/MTHDS developers working with an AI assistant in a local development loop. Today, validation requires leaving the assistant flow, knowing the local OSS `pipelex-api` or SDK details, and manually mapping diagnostics back to file content. The first product slice is intentionally narrow: validate submitted MTHDS file contents and return structured results the assistant can use to fix issues.

Core actions:

- Validate one or more submitted MTHDS files.
- Return valid, invalid, pending-signature, and no-verdict failure states in a stable structured result.
- Return optional graph data when requested and available.
- Project a pipe's declared inputs as a fill-in template (`mthds_inputs_template`), so an assistant can prepare inputs for a run without leaving the conversation. This unblocks the CLI-free skills in `../pipelex-plugins` (`pipelex-inputs`, `pipelex-design`) that used to shell out to `mthds-agent inputs bundle`.
- Prepare a pipe's *filled* inputs for a run (`mthds_prepare_inputs`): upload file-bearing values (local paths, `data:` URLs, bytes) to Pipelex storage and rewrite them to `pipelex-storage://`, so the inputs are run-ready — on the local workshop, using the user's key; the hosted console stays pass-through only.
- Turn a file the user attached in the chat into a run-ready storage reference (`mthds_upload_attachments`, hosted console only): fetch the host's signed attachment URL server-side and upload the bytes to Pipelex storage, returning `pipelex-storage://` URIs the assistant fills into an inputs template. This is what lets a ChatGPT user drop a PDF into the conversation and run a method on it without ever pasting a URL.
- Start a durable run of a method on the hosted Pipelex API (`mthds_run`), then check on it (`mthds_run_status`) and report its results (`mthds_run_results`) by durable run id — the run outlives any single tool call and even the conversation.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.

**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.

**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to local OSS `pipelex-api`, or structured verdicts such as pending signatures, validation errors, and graph specs. It also cannot resolve a pipe's effective input contract (needs of the pipe minus what upstream pipes produce) — that projection is computed by the API from the parsed closure.

## UI Overview

`mthds_validate` ships a Skybridge view, `run-graph`: on a positive verdict that carries a `graph_spec`, a Skybridge-capable host renders an interactive method graph (via `@pipelex/mthds-ui`'s `GraphViewer`) inline above the model response, with a user-triggered fullscreen toggle for exploration. Invalid verdicts, pending-signature verdicts with no graph, and `include_graph: false` calls fall back to a compact, non-crashing empty state. The shared surface is the assistant conversation, the structured tool result, and this view.

`mthds_run` ships a second Skybridge view, `run-follow`: a self-polling status card that follows a durable run live (friendly status label, elapsed wall-clock, spinner) without any model turns — it polls the read-only `mthds_run_status` on a timer via `useCallTool`. On completion it fetches `mthds_run_results` once and renders the executed graph from the response's view-only metadata plus a compact output preview; on failure it shows the terminal status and failure message (and states plainly that no graph exists for failed runs). Once the terminal outcome is resolved (completed or failed), the view hands the conversation back to the model on its own via `sendFollowUpMessage` — one canned prompt naming the run id — so the assistant reports the outcome without the user prompting (the completion handoff, detailed in Run Scope). On remount it re-resolves the run by id, so reopening the conversation restores the card without re-firing the handoff.

**First view**: The MCP host lists the Pipelex tools: `mthds_validate`, `mthds_inputs_template`, `mthds_prepare_inputs`, `mthds_run`, `mthds_run_status`, and `mthds_run_results`, plus `mthds_upload_attachments` on the hosted console only (see Deployments). `mthds_validate` and `mthds_run` carry Skybridge views; the others are plain tools whose payloads are small structured data the model reads directly.

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

The product ships as **two servers from one repo and one capability core**, sharing one logical identity: the same server key (`pipelex`), the same tool names (with one documented console-only exception, below), the same structured contracts, and the same verdict discipline. The capability core (`capabilities/`) knows nothing about which shell invoked it.

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

**The tool table is shared except for one console-only tool.** Both shells register the same tool table from `src/tools.ts`, with one documented exception: **`mthds_upload_attachments` is registered on the hosted console only.** This is the first break in the "same tool names on both shells" property, and it is deliberate rather than incidental. The tool's sole argument is a host-substituted attachment reference, and the substitution is gated by the host on the declared JSON Schema — a field only receives a file if it declares the mandated four-field object shape (see Attachment Ingest Scope). No stdio host performs that substitution, so on the workshop the tool would be *structurally unreachable*, not merely unused: nothing could ever populate it. Registering it there would spend every workshop user's tokens on every `tools/list` to advertise a capability that cannot fire, and would invite the model to attempt it. The shells already differ in behavior behind shared names (views on the console only, the `{ path }` resolver and the upload boundary on the workshop only); this extends that per-deployment split to presence, for the one tool whose input only one host can produce. The invariant that still holds, and that matters for routing: **no tool name means different things on the two shells.**

**One host, one server.** A host should be connected to exactly one of the two shells, never both — same tool names on both mean a both-installed host has ambiguous routing. Notably, a claude.ai Pipelex connector syncs into Claude Code; a workshop user disables it there (`/mcp`) in favor of the local server.

## Naming Conventions

Tools are the contract; the `../pipelex-plugins` skills are the manual. The naming follows that split:

- **Server key: `pipelex`** — the product brand (Pipelex is the service; MTHDS is the language). Hosts derive their flattened tool names from it (`mcp__pipelex__mthds_validate` on Codex, `mcp__plugin_pipelex_pipelex__mthds_validate` on Claude Code).
- **Tool names: `mthds_<stem>`, snake_case** — operations on MTHDS-language artifacts, and on the assets that feed an MTHDS run. The `mthds_` prefix stays even though the server prefix could be argued to cover it: some hosts display or match bare tool names, generic verbs (`validate`, `run`, `upload`) collide across servers in a multi-server session, and a `pipelex_` prefix would stutter against the server key. The "and the assets that feed a run" widening is what admits `mthds_upload_attachments`: uploading to Pipelex storage is a runtime-specific operation on a user's file rather than on MTHDS-language content, so the brand boundary would argue for a bare or `pipelex_`-prefixed name — but a single unprefixed tool in an otherwise uniform list costs the model more (one incoherent family, one collision risk) than the loose prefix costs the brand. The tool is named for the workflow it serves, not for the storage it writes to.
- **Lifecycle families share a stem prefix** — `mthds_run`, `mthds_run_status`, `mthds_run_results` sort and display adjacently, so hosts and models see them as one family.
- **Names state what you get** — a noun-only name must name the artifact it returns (`mthds_inputs_template`, renamed from the ambiguous `mthds_inputs`); otherwise lead with the operation (`mthds_validate`).
- **Tools are self-sufficient; the dependency on skills is one-way** — tool names, descriptions, and the server `instructions` never reference the plugin skills, because many consumers (ChatGPT, claude.ai connectors, raw MCP hosts) will never see them. The skills reference tool names verbatim, and where a skill is the manual for one tool the two share a stem (`pipelex-inputs` ↔ `mthds_inputs_template`); that side of the convention is recorded in `../pipelex-plugins/docs/decisions.md`.

## Validation Scope (`mthds_validate`)

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[]; // { content, uri? } | { path } — see Deployments
  method_id?: string;           // catalog id (mt_…) of a registered method — files win when both are supplied
  include_graph?: boolean;
}
```

At least one of (non-empty `files`, `method_id`) is required, else `input_domain` at `files`; a supplied-but-blank `method_id` is `input_domain` at `method_id`. `method_id` validates a registered method by its catalog id via the same **fetch-and-forward** as `mthds_inputs_template`'s by-id path — `/v1/validate` has no by-id support either, so the capability resolves the stored method's runnable closure via the SDK's `getMethodClosure` (a `GET /v1/methods/{id}` fetch plus the canonical parse of the polymorphic `MethodData.mthds` source), and forwards the resulting contents as `/v1/validate`'s files, each carrying the method id as its `uri` provenance label. When both are supplied, **files win and `method_id` is ignored** (no linkage concept on this route, unlike `/v1/start`) — documented behavior, not an error. A stored method with no MTHDS source is an `input_domain` no-verdict at `method_id`, raised without calling `/v1/validate`. Fetch-leg failures classify against `/v1/methods/{id}` exactly as they do for `mthds_inputs_template` (unknown/foreign-org id → 404 → `input_domain` at `method_id`; paywall → 402 → `config`; a key is required for by-id calls). The dry-run graph view works identically regardless of whether the validated content came from submitted files or a by-id fetch — the fetch leg only supplies files upstream of the existing `/v1/validate` call.

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
- `method_id` projects a registered method by its catalog id, via **fetch-and-forward**: the build routes have no by-id support, so the capability resolves the stored method's runnable closure via the SDK's `getMethodClosure` (a `GET /v1/methods/{id}` fetch plus the canonical parse of the polymorphic `MethodData.mthds` source — either raw `.mthds` source or a JSON-serialized `[{ name, content }]` file array, the webapp editor format), and forwards the resulting contents as the build envelope's files, each carrying the method id as its `source` provenance label so diagnostics point back at the registered method. At least one of (non-empty `files`, `method_id`) is required, else `input_domain`; a supplied-but-blank `method_id` is `input_domain` at `method_id`. When both are supplied, **files win and `method_id` is ignored** (the build routes have no linkage concept) — documented behavior, not an error. A stored method with no MTHDS source is an `input_domain` no-verdict at `method_id` ("the stored method has no MTHDS source yet"), raised without calling the build route. Fetch-leg failures classify against the route `/v1/methods/{id}`: an unknown or foreign-org id is a 404 → `input_domain` at `method_id` (the catalog is org-scoped to the key's org, so a foreign-org method reads exactly like a miss; unlike `/v1/start`, the SDK does not intercept a missing-route 404 on this route, so a bare-runner base URL reads the same — the hint covers both causes), a paywall 402 → `config` (the generic billing arm), and auth failures get the deployment's usual `config` texture — a key is required for by-id calls.
- `pipe_ref` is the pipe to project, as a qualified `domain.pipe_code`. Optional; it defaults server-side to the closure's declared `main_pipe`, which fails as a no-verdict error (API 422) when the closure declares none or several across its domains. `method_ref` is deliberately not exposed (the registry answers 501 today).
- `explicit` defaults to **true** (the ceremonial `{concept, content}` envelope per input — each input's declared concept ref plus its canonical content shape, which is what an agent needs to fill the template correctly); `false` requests the light template shape (bare example values). The default was flipped from `false` to `true` for agent UX (concept refs and canonical shapes by default); the light shape stays one flag away.
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

## Prepare Inputs Scope (`mthds_prepare_inputs`)

`mthds_prepare_inputs` prepares a pipe's *filled* inputs for a run: it uploads the file-bearing values to Pipelex storage and rewrites them to the canonical content shape carrying `pipelex-storage://`, so the returned `inputs` can be handed straight to `mthds_run`. It wraps `@pipelex/sdk`'s `prepareInputs`. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` — the prepared inputs are small structured data the model reads directly.

Where it sits in the flow: `mthds_inputs_template` produces the empty template → the agent fills it (with text, `http(s)` URLs, local file references, or inline bytes) → `mthds_prepare_inputs` turns the filled inputs into run-ready inputs → `mthds_run` executes them. The prepare step is what makes local/byte assets runnable; an inputs set that is already all pass-through (`http(s)` URLs, existing `pipelex-storage://` URIs) can skip prepare and go straight to `mthds_run`.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[];    // { content, uri? } | { path } — the method closure (signature source)
  method_id?: string;              // catalog id (mt_…) of a registered method — files win when both are supplied
  pipe_ref?: string;               // qualified domain.pipe_code; omit to default to the closure's main_pipe
  inputs: Record<string, unknown>; // the caller's FILLED inputs (the mthds_inputs_template output, populated) — compact or the explicit {concept, content} envelope
}
```

- `files` / `method_id` mirror the other tools (the shared submitted-files shape + the by-id arm). At least one of (non-empty `files`, `method_id`) is required, else `input_domain` at `files`; a supplied-but-blank `method_id` is `input_domain` at `method_id`. **Files win** when both are supplied (no linkage concept on this route). A `method_id`-only request resolves via the shared **fetch-and-forward** leg (`fetchMethodFiles` → the SDK's `getMethodClosure`), exactly as `mthds_validate` and `mthds_inputs_template` do — one by-id resolution path across all three tools, one place that maps `EmptyMethodSourceError`/404. (The SDK's `prepareInputs` can resolve `method_id` itself, but the MCP resolves precedence up front and always calls `prepareInputs({ files })`, to keep by-id error handling in one shared place rather than splitting it inside the SDK call.)
- `pipe_ref` is the pipe whose declared signature drives asset identification. Optional; it defaults server-side to the closure's `main_pipe`. Unlike `mthds_inputs_template` there is no `format` / `explicit` — this tool returns prepared inputs, not a template.
- `inputs` is **required** (it is the whole point — the filled values to prepare). An empty object `{}` is accepted (nothing to prepare); it passes through and uploads nothing. **Both filled template shapes are accepted**: the compact value, and the explicit `{concept, content}` envelope that `mthds_inputs_template` returns by default (`explicit: true`). An envelope's inner `content` is interpreted exactly as the compact value would be, and the envelope is **preserved on output** — the `concept` annotation rides through to the run, which the runtime accepts as a first-class explicit form. The envelope is recognized by the strict rule "a plain object whose keys are *exactly* `concept` and `content`", so a declared structured concept that merely happens to carry both fields is not misread as one. This matches `@pipelex/sdk`'s `prepareInputs` (0.9.0+) and the console's pass-through mirror behaves identically.

**Signature-driven asset identification (inherited from the SDK).** The SDK resolves the pipe's declared signature (via `buildInputs`, `explicit: true`) and walks the caller's `inputs` top-down against it. Only values at Image/Document-declared positions are treated as assets; the identical bare string at a Text position is never touched. Per file-bearing value:

| Source at a file-bearing input | Action |
| --- | --- |
| Local filesystem path (Node) / `data:` URL / inline bytes | Uploaded to Pipelex storage → rewritten to `pipelex-storage://` |
| Existing `pipelex-storage://` URI | Already prepared — passes through unchanged |
| `http(s)` URL | Passes through unchanged |

**Per-deployment asset boundary (the seam).** Uploading a local/byte asset requires reading the caller's bytes, which only the deployment co-located with those bytes can do. This is the same per-deployment split as the `{ path }` arm, gated by a per-deployment capability seam on the capability context (analogous to the file `resolver`):

- The **local workshop** prepares local paths, `data:` URLs, and bytes within its asset boundary, uploading with the user's `PIPELEX_API_KEY`. It delegates the upload walk to the SDK's `prepareInputs`.

  **The upload size ceiling is ~7.5 MiB decoded, not the documented 50 MiB.** Measured 2026-07-31 against the hosted API: 7.4 MiB uploads, 7.5 MiB is rejected `413`. `POST /v1/upload` takes a base64 JSON body behind an AWS API Gateway HTTP API integration, whose 10 MiB request limit is a hard quota; base64's 4/3 inflation puts the decoded wall at exactly 7.5 MiB. The app-level `MAX_UPLOAD_MIB` (50 MiB) is therefore unreachable through the public gateway and must not be quoted as the limit anywhere. The failure is already classified correctly (`RejectedAssetError` → `input_domain`), but it arrives only *after* the whole asset has been read and base64-encoded — a pre-flight size check that refuses before that work, naming the real limit, is the improvement owed here. This applies to the workshop as shipped, independently of the attachment channel.
- The **hosted console** is **pass-through only**: it accepts `http(s)` URLs and `pipelex-storage://` URIs, and **refuses any input that would require an upload** — a `data:` URL, inline bytes, or a local path — with an instructive `input_domain` no-verdict located at `inputs`, naming the local workshop (`npx @pipelex/mcp`) and the pass-through alternatives. The console never reads a filesystem and never uploads. (BYOK gives each console caller their own key, which settles *whose* storage an upload would target — but inline `data:` bytes still bloat the model's context, the exact cost the workshop's `{ path }` design exists to avoid, so console byte upload stays deferred until a proper out-of-band attachment channel exists; see Non-Goals.)

Because the console refuses uploads before any SDK upload call, the SDK's upload-side errors (`InvalidLocalSourceError`, `RejectedAssetError`, `UnsupportedUploadCapabilityError`, `UploadAuthenticationError`, `UploadTransportError`) arise only on the **workshop**; on the console the sole upload-related failure is its own pre-flight refusal.

> **Enforcement constraint (implementation, for Phase 2b).** The console must not hand raw `inputs` to the SDK's `prepareInputs`: for a bare-path value at a file position the SDK reads the *server's* filesystem (`readLocalPath`) before failing at the upload boundary — an LFI-read / DoS (`/dev/zero`) / path-existence-oracle hazard on a public endpoint. The console therefore resolves the pipe's signature itself and rejects any non-pass-through file-bearing input up front — the console's analogue of the workshop's filesystem resolver, a per-deployment seam rather than a fork of the tool contract. (A future SDK classification helper could let the console reuse the SDK's file-position detection without a local walk — the same "SDK-canonical, swappable-for-native" posture as `getMethodClosure`.)

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;                 // true on the produced (success) arm — see verdict discipline below
  pipe_ref?: string;                 // echoed when the caller supplied it (the SDK does not return the resolved default)
  inputs?: Record<string, unknown>;  // the prepared (rewritten) inputs — ready for mthds_run
  uploads?: string[];                // the pipelex-storage:// uris of the assets uploaded this call ([] when all pass-through)
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

**Verdict discipline.** A produced result is `status: "ok"`, `is_valid: true`, carrying the rewritten `inputs` and the `uploads` uri list. Unlike `mthds_inputs_template`, `mthds_prepare_inputs` has **no produced-invalid arm**: an unresolvable closure (invalid bundle, unknown `pipe_ref`, unresolvable `main_pipe`) is a **no-verdict** `status: "error"` `input_domain`, because the SDK's `prepareInputs` throws `InputPreparationError` on an invalid closure without returning the structured `validation_errors[]` list. The agent's recovery path is `mthds_validate` / `mthds_inputs_template`, which *do* produce the structured diagnostics — prepare sits downstream of them and delegates the verdict surface rather than duplicating it (re-fetching the list would cost a redundant `buildInputs` round-trip).

`status: "error"` + `errors[]` cover every failure:

- `input_domain` — bad request shape (neither `files` nor `method_id`, a blank `method_id`, a blank `pipe_ref`); a stored method with no MTHDS source (`EmptyMethodSourceError`, at `method_id`, raised without calling the build/prepare route); an unresolvable closure (`InputPreparationError` "the method signature did not resolve") and an unknown `pipe_ref` / unresolvable `main_pipe` default (the internal `buildInputs` 422, at `pipe_ref`); a rejected asset (`RejectedAssetError`, a 413 past the service size cap, at `inputs`); an invalid local source (`InvalidLocalSourceError` — missing/unreadable path, at `inputs`); the console's pass-through-only upload refusal (at `inputs`). Workshop-only, except the last two categories' console refusal.
- `config` — auth failure (`UploadAuthenticationError` / `ClientAuthenticationError`, 401/403, carrying the deployment's auth texture), a paywall (402, the org's plan does not cover the call), an unreachable API, and a deployment with no upload route (`UnsupportedUploadCapabilityError`, 404).
- `runtime` — a transport/server fault reaching the upload route (`UploadTransportError`, a 5xx / unreachable host / malformed `data:` payload), and a reachable-but-malformed report.

Each is classified in `classifyError` (extended for the `InputPreparationError` family — these derive from `PipelineRequestError`, so they must be mapped ahead of the generic arm, as `EmptyMethodSourceError` already is in `fetchMethodFiles`) with its `retryable` verdict, using per-route `ClassifyErrorOptions` (400/422 located at `pipe_ref`; the by-id 404 at `method_id`; the deployment auth texture threaded from the context's `authError`).

**Summary.** The build/prepare surface returns no `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe (when known), a one-line note of how many assets were uploaded vs passed through, and the prepared `inputs` in a fenced JSON block (the `mthds_inputs_template` duplication pattern — the prepared inputs are the small payload the model must carry to `mthds_run`).

## Attachment Ingest Scope (`mthds_upload_attachments`) — hosted console only

`mthds_upload_attachments` turns a file the user attached in the conversation into a run-ready `pipelex-storage://` reference. It is the hosted console's answer to the question the workshop answers with `{ path }` items: *how does the user's actual PDF reach a run without its bytes crossing the model's context?* The console fetches the host's signed attachment URL server-side and uploads the bytes to Pipelex storage under the caller's BYOK key; only small URI strings return to the model.

It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` — the returned URIs are small structured data the model reads directly and fills into an inputs template.

**Where it sits in the flow.** `mthds_upload_attachments` → the URIs → filled into the `mthds_inputs_template` output → `mthds_run`. It **composes with the existing tools without changing any of them**: a `pipelex-storage://` URI is already a pass-through value everywhere downstream, so `mthds_prepare_inputs` needs no change and can be skipped entirely when every file-bearing input is an ingested attachment. This is the whole reason the capability is a separate tool rather than an `attachments` argument on `mthds_prepare_inputs`: no binding convention between an attachment and an input slot has to be invented, and the console's "pass-through only" property stays a true statement rather than an exception.

**Host support: ChatGPT only.** The channel exists because ChatGPT's Apps runtime rewrites a model-authored file reference into a signed-URL object before the call reaches us. Verified against a live connection on desktop web and iOS, with PDFs from 140 KB to 19.6 MB. **claude.ai has no equivalent** — no file id, no signed URL, no host-injected reference reaches a connector — and MCP has nothing in-spec (SEP-2631 remains an open draft). On a host with no channel the model can only fabricate a URL, which the fetch boundary refuses; that refusal doubles as the "this host cannot attach files" diagnostic and its hint says so.

### The attachment object (the four-field rule)

```ts
{
  attachments: Array<{
    download_url: string;   // required — the host's signed HTTPS URL
    file_id: string;        // required — e.g. "sediment://file_0000…"; a scheme-prefixed URI, not an opaque token
    mime_type?: string;     // optional
    file_name?: string;     // optional
  }>;
}
```

This shape is **mandated, not chosen**. Any field named in the tool's `_meta["openai/fileParams"]` must declare exactly these four properties with exactly this required/optional split; a fifth property, a missing one, or a wrongly-required optional fails OpenAI's app-review "Scan Tools" step. It is also a **runtime** gate, not only a review checkbox: the host substitutes a file reference only into a field whose declared schema matches, so a deliberately lenient schema is not a fallback — it is invisible to the mechanism and would never be populated. There is consequently no "accept whatever arrives and classify it" arm to build.

Three consequences follow:

- **`attachments` is required, and the description must push the model to fill it.** An optional field with a neutral or defensive description silently yields calls with the field absent, which looks exactly like a host failure. This was measured: under a description that said "do not invent values for `attachments`", every observed call omitted the field; under a description that says *always* pass the user's attached file, the model populated it unprompted on the first try. **The description text is load-bearing mechanism, not documentation, and gets the same review rigour as the schema.**
- **The schema is declared in the capability layer, not imported from `skybridge/server`.** Skybridge ships an equivalent `FileRef`, but the capability core is Skybridge-free by construction (`src/tools.ts` and `src/capabilities/` import zero Skybridge symbols) and importing it would drag Skybridge into the tsup-bundled workshop binary. A local Zod object emits a byte-identical JSON Schema, so the constraint costs nothing.
- **A malformed payload never reaches the capability layer.** The MCP SDK rejects a non-conforming argument at its own boundary. On the hosted shell that surfaces to the model as an `isError` result carrying the raw validation text, from which the model has been observed to self-correct on the next call. This is why no bespoke handling exists for the reported mobile-placeholder defect (which did not reproduce on iOS with a PDF): the failure is self-correcting in practice, and a description hint is the whole mitigation.

### Attachment fetch boundary (console)

Fetching a host-supplied URL from a public endpoint is an SSRF surface, and it is the one genuinely new risk this capability introduces. The boundary is a named policy, enforced by a dedicated module that denies by default — the console's analogue of the workshop's path trust boundary. It ships **with** the first fetch, not as a hardening follow-up.

- **Scheme**: `https:` only.
- **Host allowlist**: the host must match an OpenAI-owned pattern — `oaisdmntpr<azure-region>.blob.core.windows.net`, or the vendor-documented `files.oaiusercontent.com`. Everything else is refused. A **literal** host list is not an option: four captures in one afternoon, from one user in one location, came back from three different Azure regions (`newzealandnorth`, `koreacentral`, `westus`), so the region is assigned per upload and bears no relation to the user. A **suffix-only** rule (`*.blob.core.windows.net`) is equally unacceptable in the other direction: any Azure customer can create a storage account under that suffix, so the `oaisdmntpr` prefix is required, never optional.
- **Redirects**: refused outright. A signed SAS URL has no reason to redirect, and refusing is simpler and stricter than comparing hosts across a redirect chain.
- **Size**: refused **before the body is read**. A ranged GET reveals the total from `content-range` / `content-length`; over the cap, the request is abandoned without pulling bytes. The stream is *also* bounded mid-flight, so a lying header cannot exceed the cap.
- **Timeout**: a bounded connect+read budget on the fetch leg.
- **Credentials**: none forwarded — no cookies, no auth headers, no ambient identity.
- **Response**: non-2xx is refused.

The classic SSRF targets — link-local metadata, loopback, RFC1918 — are unreachable *by construction* under https-only + host allowlist + no-redirects. But the `oaisdmntpr` prefix is undocumented vendor infrastructure that can change without notice, so the byte cap, the timeout, and the no-redirect rule must hold on their own: **the host check is a filter, not the defence.**

**Request metadata is never logged.** ChatGPT attaches `openai/userLocation` (city, region, country, timezone, and latitude/longitude), plus stable opaque `openai/subject` / `openai/session` / `openai/organization` identifiers, to **every** `tools/call` — arriving on a surface we did not ask for. Production must not log request `_meta`, on this route or any other.

### The size cap is forced by the transport, not chosen

Measured against the hosted API (2026-07-31): a decoded asset of **7.4 MiB uploads; 7.5 MiB is rejected `413`**. That wall is exactly AWS API Gateway's 10 MiB request limit divided by base64's 4/3 inflation — `POST /v1/upload` takes a base64 JSON body behind an HTTP API integration. **The app-level 50 MiB `MAX_UPLOAD_MIB` is unreachable through the public gateway** and must not be quoted as the limit.

The console therefore caps an attachment at **7 MiB**, leaving headroom for the JSON envelope around the base64 payload. This is a transport ceiling, not a product judgment about what makes a sane MTHDS input.

The uncomfortable consequence, stated plainly because users will meet it: **ChatGPT hands over files far larger than we can ingest** — a 19,631,193-byte PDF was accepted by the host with no refusal or truncation. Oversize attachments are therefore an ordinary case, not an edge case, and the refusal must be excellent: it names the limit in MiB, it fires before any bytes are fetched, and it is called out in the release notes. Raising the ceiling means bypassing the gateway for uploads (a presigned direct-upload redesign), which is out of scope here and belongs to the hosted storage owner.

Timing is not a constraint: an end-to-end ingest at the cap costs roughly 6 s (~2.3 s fetch at the observed 3.2 MB/s, ~2.9 s upload at the observed 2.5 MB/s) against a signed-URL lifetime of ~305 s. A **synchronous** ingest tool fits comfortably in one call.

### Structured output

```ts
{
  status: "ok" | "error";
  is_valid: boolean;                  // true iff EVERY attachment was ingested
  attachments?: Array<{
    file_id: string;
    file_name?: string;
    uri?: string;                     // the pipelex-storage:// reference, on success
    content_type?: string;
    size?: number;                    // decoded bytes
    error?: ToolError;                // per-item failure — see below
  }>;
  uploads?: string[];                 // the successful uris (the mthds_prepare_inputs field, same meaning)
  errors?: Array<ToolError>;          // no-verdict only
}
```

**Verdict discipline**, consistent with every other tool: a *produced* result is `status: "ok"`, discriminated on `is_valid`. Once the per-item walk runs, the result is produced — `is_valid: true` when every attachment ingested, `is_valid: false` when at least one failed, with each failure on its own `attachments[i].error`. **Partial success is a produced verdict, not an error**: the successful uploads already exist in storage, and discarding them because a sibling failed would waste them and strand the model. `status: "error"` + top-level `errors[]` is reserved for the genuine no-verdict conditions — an empty `attachments` array (`input_domain`), a missing/invalid key or unreachable API (`config`), or a fault before any item was attempted.

**Per-item error classes** (each carrying `retryable`, decided where the concrete failure is known, per the standing rule):

- `input_domain` — a host outside the allowlist (not retryable; the hint names ChatGPT as the only host with an attachment channel, and asks for an `http(s)` URL otherwise); an attachment over the size cap (not retryable, naming the limit); a `413` from the upload route (`RejectedAssetError`, not retryable — a backstop, since the pre-flight cap should pre-empt it).
- `config` — upload auth failure (`UploadAuthenticationError` / `ClientAuthenticationError`, 401/403, carrying the console's BYOK texture), a paywall (402), an unreachable API, a deployment with no upload route (`UnsupportedUploadCapabilityError`, 404).
- `runtime` — a fetch timeout or network fault, a non-2xx from the storage host, and a transport/server fault reaching the upload route (`UploadTransportError`); retryable.

One case deserves its own note: a **`403` on the download URL** is an expired signed link, classified `input_domain` at that attachment and **retryable — by re-attaching the file**, not by repeating the same call. The link's life is about five minutes from the tool call, which is why the bytes are ingested during the call rather than forwarded (see below); the hint says to ask the user to attach the file again.

### Why ingest rather than forward the URL

The host's `download_url` is an Azure SAS link with a **~305-second** life measured from the tool call — confirmed empirically, not merely read off the URL: a captured link re-fetched `206` at +288 s and `403` at +328 s, bracketing its declared expiry. A durable run's workers fetch minutes to hours after the tool call, so forwarding the raw URL into `mthds_run` would hand them a dead link in the *ordinary* case, not the edge case. The bytes must be fetched and re-hosted during the tool call, and the run must receive a `pipelex-storage://` reference.

This creates a deliberate asymmetry worth stating so it does not read as an inconsistency: **this tool ingests the host's URL, while `mthds_prepare_inputs` still passes an ordinary user-pasted `http(s)` URL through unchanged.** Host attachment URLs expire in minutes; user URLs generally do not. Opt-in ingest for ordinary URLs remains a separate, additive future item (see Non-Goals).

### The tool description is cached and cannot be hot-fixed

ChatGPT caches a connector's tool list at add-time and does not refresh it: across a session with four `initialize` handshakes and five `tools/call` invocations, `tools/list` was issued **zero** times; the list refreshed only when the connector was removed and re-added. Combined with the description being load-bearing mechanism rather than documentation, this means **a description defect is not hot-fixable** — shipping a fix leaves every existing installation on the old text until each user re-adds the connector.

Two obligations follow, and both are release blockers rather than polish: the initial wording gets the same review rigour as the schema, and the release notes tell users to re-add the connector.

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

`RunStatus` is the hosted lifecycle set: `PENDING | STARTED | RUNNING | COMPLETED | FAILED | CANCELLED | TERMINATED | TIMED_OUT`. The `content` summary states the run was accepted, gives the id, and spells out follow-up etiquette for the model (check with `mthds_run_status`, fetch with `mthds_run_results` when terminal, don't poll in a tight loop). Deliberately not exposed in v1: `output_name`, `output_multiplicity`, `dynamic_output_concept_ref`, `extra`, webhooks, client-supplied run ids. Binary inputs (PDFs, images) ride reachable https URLs inside `inputs`, or are turned into `pipelex-storage://` references first by `mthds_prepare_inputs` (see Prepare Inputs Scope) — on the local workshop from local paths/bytes, on the hosted console from `http(s)`/`pipelex-storage://` pass-through only.

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
  usage?: RunUsage;                             // state=completed only — RUN-LEVEL token & USD-cost totals; per-pipe rollup + full per-call list ride _meta (see below)
  available_view_specs: Array<"run_graph">;     // populated when graph_spec rides _meta
  errors?: ToolError[];
}
```

On `completed`, `content` composes a Markdown summary with the main output in a fenced code block (the `mthds_inputs_template` duplication pattern: the payload the model must read is deliberately repeated in the prose), bounded by the same cap as `structuredContent`. The executed `graph_spec`, the **full** (unbounded) `main_stuff`, the **full** per-call `tokens_usages` record list, and the per-pipe usage rollup ride the view-only `_meta` channel (keys mirror the API field names where they exist: `_meta.graph_spec`, `_meta.main_stuff`, `_meta.tokens_usages`, plus our own `_meta.usage_by_pipe`), never model context. A `state: "running"` result is a produced verdict ("no result *yet*" is an answer): `status: "ok"` with the retry hint. On `failed`, the summary carries the terminal status and failure message and states plainly that no graph exists for failed runs.

**Bounding `main_stuff`**: an output can be huge. The structured copy (and the fenced summary block) is bounded to a serialized cap (~32KB, tunable constant): JSON trees are pruned deterministically (deepest levels and longest collections first, with an ellipsis marker); plain text keeps head+tail. When bounded, `truncated: true` and the summary says the output was cut. The full output always rides `_meta` for views.

**Run usage & cost**: on a `completed` result, `structuredContent.usage` carries **run-level** token and cost totals projected from the SDK's `RunResults.tokens_usages` — the per-inference-call record list (token counts by category, server-computed USD `cost`, and the `pipe_code` that made the call). It is a small, fixed-shape totals object; there is deliberately **no per-pipe breakdown in the model-facing usage** (the agent gets the run's bottom line, not a table). The per-pipe rollup and the **full** per-call `tokens_usages` list ride the view-only `_meta` channel (`_meta.usage_by_pipe`, `_meta.tokens_usages`) — never model context, exactly like `main_stuff` — where a future detailed-cost tool/view can read them. Usage is also **never rendered into the `content` prose**: the totals live only in `structuredContent.usage`.

```ts
usage: {
  cost_usd: number | null;      // Σ per-call cost, null-aware: null when NO call was priced (own-GPU/mock/dry-run) — distinct from 0 (a run that made no inference)
  cost_partial?: boolean;       // some calls priced, some not — cost_usd is a lower bound
  tokens: number | null;        // Σ (input + output) across calls; null when no call reported counts. input_cached / output_reasoning are documented subsets and deliberately excluded to avoid double-counting
  calls: number;                // number of inference calls (0 → the run did no inference)
  assembly_error?: string;      // usage assembly broke for this run (the SDK's usage_assembly_error)
}
```

Presence follows the SDK's usage signal, branching on `usage_assembly_error` (**not** on the list being null — all of "off", "broke", and "pre-artifact run" leave `tokens_usages` null): `tokens_usages` a non-empty list → `usage` with the computed totals; `[]` (assembly ran, no inference) → `usage` with zero totals; `tokens_usages` null **with** `usage_assembly_error` set → `usage` carrying `assembly_error` and null totals; `tokens_usages` null **without** an error (usage off / run predates the artifact) → `usage` omitted entirely. Cost is null-aware: a `null` per-call `cost` means the model had no rate table (own-GPU/mock/dry-run) and `0` means it was priced at zero, so a total of `null` ("no priced call") is deliberately distinct from `0` ("no inference"), and `cost_partial` flags a mix. Tokens sum only the two documented joined totals (`input`, `output`) to avoid double-counting the non-additive subsets. The per-pipe rollup on `_meta.usage_by_pipe` uses the same null-aware cost and `input`+`output` token math per pipe, sorted by cost descending (a `null` `pipe_code` groups the runtime-unattributed calls) — it is computed on every completed run with a usage list, unbounded (it rides `_meta`, not the model's context), and carried even on the tools-only local shell so a programmatic consumer keeps it.

**Run verdict discipline**: `status: "ok"` means the API answered the question about the run — including "it failed" and "not done yet". A FAILED/CANCELLED/TIMED_OUT run is a produced verdict (`status: "ok"` with the terminal `run_status`), and so is a `state: "running"` results lookup. `status: "error"` + `errors[]` is reserved for no-verdict conditions:

- `input_domain` — empty/blank `run_id`, blank `pipe_code`, neither `files` nor `method_id` supplied, a blank `method_id`, request-shape 400/422 at start, unknown `run_id` (a 404 on the run routes with the server's structured error envelope), unknown `method_id` (a 404 on `/v1/start`, located at `method_id`, not retryable — the hint says to check the id as the catalog returned it; the catalog is org-scoped to the API key's org, so a method from another org reads exactly like a miss). On an id-only start the 400/422 arm covers two causes with one combined hint at `method_id`: the stored method may have no MTHDS source yet, and if the error mentions organization context the key's org binding is the issue (mint a key in the right org) — no message-sniffing to split them. On a mixed start (files + `method_id`) a 400/422 locates at `files` instead — the files are the executed source, so the rejection is about the submitted bundle/pipe_code/inputs, never the stored method (stored-source resolution does not run on that path).
- `config` — missing/invalid `PIPELEX_API_KEY` (401/403), a paywall 402 (the org's plan does not cover the call — classified on the HTTP status, never the problem `code`, no location, not retryable, with a hint pointing at the org's plan/billing on app.pipelex.com; this arm is generic across routes), unreachable API, `RunLifecycleUnavailableError` (the configured base URL points at a bare runner — durable runs need the hosted API).
- `runtime` — 5xx, malformed report (e.g. a completed result missing `main_stuff`, the SDK's `MissingMainStuffError`).

The unknown-id 404 vs missing-route 404 distinction comes from the SDK: a missing lifecycle route throws `RunLifecycleUnavailableError` (`config`), while an unknown id surfaces as a plain 404 `ApiResponseError` (`input_domain`, via a per-route classification override). The same holds for an unknown `method_id` on `/v1/start`: any `ApiResponseError` 404 that reaches classification there is the platform's structured unknown-method envelope (a bare runner's missing-route 404 was already intercepted as `RunLifecycleUnavailableError`), so the `notFound` override at `method_id` is safe. The classify options follow the executed source, in three shapes: an id-only request gets the full by-id texture (400/422 and 404 both at `method_id`); a mixed request (files + `method_id`) keeps the files 400/422 texture but retains the by-id unknown-method 404 at `method_id` (a 404 there is about the linkage id, the one field the files cannot explain); a files-only request keeps today's options so nothing regresses.

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

The server must not add Pipelex Hosted API deployment behavior, OAuth token verification (the hosted console's bring-your-own-key middleware forwards the caller's key and verifies nothing — the API is the authority; see Deployments), blocking execution (`POST /v1/execute` or the SDK's blocking wrappers), run cancellation, resources, logs, package publishing (of MTHDS method packages to a registry — not this server's own npm distribution, which is how the workshop ships; see Deployments), subprocess fallbacks, or a production validation UI. Filesystem reads are scoped per deployment: the **hosted console** never reads files (a `{ path }` submission is rejected instructively — see Deployments); the **local workshop** reads exactly the `{ path }` items submitted to it, within its trust boundary. The workshop registers no views at launch (tools-first — see Deployments); local view delivery is a later increment gated on self-contained view bundles. Also out of scope for this increment: per-user OAuth. `mthds_prepare_inputs` (see Prepare Inputs Scope) now covers turning file-bearing inputs into run-ready `pipelex-storage://` references — on the **local workshop**, from local paths/bytes/`data:` URLs using the user's key. **Console-side byte upload was deferred *conditionally* — "until a proper out-of-band attachment channel exists" — and that condition is now met on exactly one host.** ChatGPT's Apps runtime substitutes a signed attachment URL into a declared tool argument, which is precisely the out-of-band channel the deferral was waiting for: the bytes travel server-to-server and never enter the model's context. `mthds_upload_attachments` takes that channel (see Attachment Ingest Scope). What the deferral still covers, unchanged:

- **`mthds_prepare_inputs` on the console stays pass-through only.** Its contract is untouched: `http(s)` / `pipelex-storage://` accepted, upload-needing values refused. It gains nothing from the attachment channel because ingested attachments arrive at it already as storage URIs.
- **Inline asset bytes in tool arguments remain out of scope on every deployment.** Nothing may return base64 to the model or accept it as an argument — that invariant is what made the original deferral correct and it is unchanged. BYOK settles *whose* storage an upload targets; it never settled the context-cost concern.
- **claude.ai and every other console host remain unserved**, because no channel exists there: no file id, no signed URL, no host-injected reference reaches a connector, and MCP has nothing in-spec (SEP-2631 is an open draft that already replaced one predecessor and has landed in no host). Those users keep pasting URLs. Adopting a standard intake when a host ships one will be additive — the `pipelex-storage://` design is already its shape, not a rewrite.
- **The console still never reads a filesystem.** Fetching a host-supplied URL is a *network* read; the `readLocalPath` refusal in Prepare Inputs Scope stands exactly as written.
- **Opt-in `http(s)`→storage ingest** for ordinary user-pasted URLs stays parked — an `http(s)` URL at a file position passes through unchanged, and ingesting it is a later, additive SDK feature. The asymmetry with `mthds_upload_attachments` (which does ingest) is deliberate and explained in Attachment Ingest Scope: host attachment URLs expire in minutes, user URLs generally do not.
- **A view-side attach flow** via Skybridge's `useFiles()` / `selectFiles()` is not pursued: the `imageIds` round-trip back to the model is a known-broken path, and the console's views are ChatGPT/Cowork-only. The attachment surface stays tools-first. Registered-method access by catalog id is in scope (`method_id` on `mthds_validate`, `mthds_run`, and `mthds_inputs_template` — see Validation Scope, Run Scope, and Inputs Template Scope), all via the same fetch-and-forward leg where the route itself has no by-id support. This does not extend to a dedicated "show me a registered method's graph" surface independent of validation — that belongs to the undecided conducted-views workstream (`wip/dual-server-conducted-views.md`), which is about a different concern (a hosted-connector-conducted scenario where content would cross the model twice); fetch-and-forward never puts content in the model's context, so it doesn't bear on that question either way. Around this catalog surface, these stay out: catalog discovery tools (listing methods or fetching method detail — the id arrives out-of-band until those land; they are the natural next increment after this one), a publish/save tool from the workshop, and stored-`input_data` defaulting (an omitted `inputs` passes through as-is; platform behavior governs).

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

Prepare filled inputs for a run:

1. After filling the `mthds_inputs_template` output, the assistant calls `mthds_prepare_inputs` with the same files (or `method_id`), the pipe, and the filled `inputs`.
2. On the local workshop, file-bearing values (local paths, `data:` URLs, bytes) are uploaded and rewritten to `pipelex-storage://`; `http(s)` / `pipelex-storage://` values pass through unchanged. On the hosted console, only pass-through values are accepted — an upload-needing input is refused instructively (use the workshop, or a URL / storage reference).
3. The assistant passes the prepared `inputs` straight to `mthds_run`. An inputs set that is already all pass-through can skip this step. An unresolvable closure is a no-verdict error; the assistant repairs via the validation flow and retries.

Run a method on a file attached in the chat (hosted console, ChatGPT only):

1. The user drops a PDF (or other asset) into the conversation and asks to run a method on it.
2. The assistant calls `mthds_upload_attachments`, referencing the attached file; ChatGPT's runtime rewrites that reference into the signed-URL object and asks the user to approve sharing it.
3. The console fetches the bytes within the attachment fetch boundary and uploads them to Pipelex storage under the caller's BYOK key, returning `pipelex-storage://` URIs — the bytes never enter the conversation.
4. The assistant fills those URIs into the `mthds_inputs_template` output and calls `mthds_run`. `mthds_prepare_inputs` can be skipped: a storage URI is already run-ready.
5. On a host with no attachment channel (claude.ai, and every non-ChatGPT connector), the model has nothing to reference; the tool's fetch boundary refuses a fabricated URL and the hint asks the user for an `http(s)` URL instead.

Run a method durably:

1. The user asks the assistant to run a `.mthds` method (usually after validating it and filling the inputs template).
2. The assistant submits the files (same per-deployment forms as validation), the pipe to run, and the filled inputs to `mthds_run`; the tool returns the durable `run_id` immediately and the `run-follow` view follows the run live.
3. The assistant checks on the run with `mthds_run_status` when asked (honoring the retry hint rather than spin-polling); when the run reaches its terminal outcome the view's completion handoff prompts the assistant, which reports via `mthds_run_results`.
4. Days later, the same `run_id` still answers `mthds_run_status` / `mthds_run_results` — the run is durable and the MCP is stateless.

Run a registered method by reference:

1. The user names a registered method by its catalog id (`mt_…`) — obtained out-of-band for now (the webapp catalog, a teammate); catalog discovery tools are the natural next increment.
2. The assistant may first call `mthds_validate` with `method_id` (no files) to confirm the stored method's current content still validates — e.g. after a suspected edit — getting the same structured verdict and dry-run graph view as a files-based call, with no bundle entering the conversation.
3. The assistant calls `mthds_inputs_template` with `method_id` (no files) and fills the returned template with user data.
4. The assistant calls `mthds_run` with `method_id` and the filled `inputs` — no bundle ever enters the conversation, and the run executes the method's current stored content.
5. Everything downstream is unchanged: the `run-follow` view, `mthds_run_status`, and `mthds_run_results` operate on the durable `run_id` and don't care how the run started.

## Tools and Views

**Server instructions**: The server sets a short MCP `instructions` string (server-wide, on the `McpServer` constructor options) that hosts surface to the model. It states that the server validates `.mthds` method files (returning an interactive dry-run graph on a valid verdict), projects a method's declared inputs as a fill-in template, prepares filled inputs for a run (uploading file-bearing values to storage on the local workshop), and runs methods durably on the hosted Pipelex API (start from files or from a registered method's catalog id, then check status and fetch results by durable run id). The hosted console's instructions additionally state that a file the user attached in the chat can be turned into a run-ready storage reference with `mthds_upload_attachments`; the workshop's do not, since it does not register that tool. It is a server-level hint only — argument-level detail stays in the tool `description`.

**Tool: `mthds_validate`**

- **Input**: `{ files?, method_id?, include_graph? }` — at least one of `files` / `method_id` (see Validation Scope)
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, available_view_specs, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. On a positive verdict the graph rides the view-only `_meta` channel (`_meta.graph_spec`), never `structuredContent`; `available_view_specs` tells the model the `"dry_run_graph"` view is available to surface.
- **Behavior**: Validates request shape, calls the Pipelex API against `PIPELEX_BASE_URL` or `https://api.pipelex.com` with signatures and markdown enabled, and maps produced validation verdicts into flattened structured content. With `method_id` and no files, fetch-and-forward: the SDK's `getMethodClosure` resolves the stored method's closure, which is forwarded to `/v1/validate` (files win when both are supplied).
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: `run-graph` — renders `_meta.graph_spec` with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle); compact empty state when there is no graph. Works identically whether the validated content came from `files` or a `method_id` fetch.

**Tool: `mthds_inputs_template`**

- **Input**: `{ files?, method_id?, pipe_ref?, explicit?, format? }` — at least one of `files` / `method_id` (see Inputs Template Scope)
- **Output**: `{ status, is_valid, pipe_ref?, format?, explicit?, inputs?, inputs_toml?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that includes the template in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/build/inputs` against `PIPELEX_BASE_URL` or `https://api.pipelex.com` (adapting `uri` → `source`), and maps the produced verdict into flattened structured content with the same `status`/`is_valid` discipline as `mthds_validate`. With `method_id` and no files, fetch-and-forward: the SDK's `getMethodClosure` resolves the stored method's closure, which is forwarded to the build route (files win when both are supplied).
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — the template is small structured data the model reads directly.

**Tool: `mthds_prepare_inputs`**

- **Input**: `{ files?, method_id?, pipe_ref?, inputs }` — at least one of `files` / `method_id`, plus the filled `inputs` (see Prepare Inputs Scope)
- **Output**: `{ status, is_valid, pipe_ref?, inputs?, uploads?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that repeats the prepared `inputs` in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Resolves the pipe's declared signature, uploads file-bearing input values to Pipelex storage, and rewrites them to `pipelex-storage://` (wrapping `@pipelex/sdk`'s `prepareInputs`); `http(s)` / `pipelex-storage://` values pass through unchanged. With `method_id` and no files, fetch-and-forward (files win when both are supplied). Per-deployment asset boundary: the local workshop uploads with the user's key; the hosted console is pass-through only and refuses upload-needing inputs instructively (it never reads a filesystem or uploads). An unresolvable closure is a no-verdict error (the SDK throws without a structured verdict).
- **Annotations**: NOT read-only (`readOnlyHint: false` — it uploads on the workshop), non-destructive, no open-world publishing.
- **View**: none — the prepared inputs are small structured data the model reads directly.

**Tool: `mthds_upload_attachments`** — hosted console only (see Deployments)

- **Input**: `{ attachments }` — a required array of the mandated four-field host attachment object `{ download_url, file_id, mime_type?, file_name? }` (see Attachment Ingest Scope). The shape is fixed by OpenAI's app review *and* by the host's runtime substitution gate; it is not ours to loosen.
- **Output**: `{ status, is_valid, attachments?, uploads?, errors? }` in `structuredContent`, plus a text summary listing each attachment's filename and resulting `pipelex-storage://` URI (the payload the model must carry into the inputs template, deliberately repeated in the prose). No `_meta`, no `available_view_specs`.
- **Behavior**: For each attachment, fetches the bytes from the signed URL within the attachment fetch boundary (https-only, OpenAI host-pattern allowlist, no redirects, 7 MiB cap enforced before the body is read, bounded timeout, no credentials forwarded), then uploads them to Pipelex storage with the caller's BYOK key via `@pipelex/sdk`'s `uploadFile`, returning the `pipelex-storage://` URI. Never reads a filesystem. Partial success is a produced verdict: successful uploads are returned alongside per-item failures.
- **Annotations**: NOT read-only (`readOnlyHint: false` — it uploads), non-destructive, and **`openWorldHint: true`** — the first tool in this server to set it, because it fetches an arbitrary host-supplied URL rather than only talking to the configured Pipelex API.
- **Host metadata**: the hosted shell registers it with `_meta["openai/fileParams"]: ["attachments"]`, which is what makes the host substitute the user's attachment into that argument, plus the usual `openai/toolInvocation` strings.
- **View**: none — the returned URIs are small structured data the model reads directly.

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
