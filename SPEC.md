# Pipelex MCP

## Value Proposition

Pipelex MCP lets developers and coding agents discover registered methods, validate MTHDS content, project a method's declared inputs, and run methods durably on the hosted Pipelex API from inside an MCP host while they are authoring, repairing, or running `.mthds` files.

Target users are Pipelex/MTHDS developers working with an AI assistant in a local development loop. Today, validation requires leaving the assistant flow, knowing the local OSS `pipelex-api` or SDK details, and manually mapping diagnostics back to file content. The first product slice is intentionally narrow: validate submitted MTHDS file contents and return structured results the assistant can use to fix issues.

Core actions:

- List the methods visible to the active API key's organization as bounded, source-free catalog metadata, so an assistant can resolve a user's name or intent to a canonical `method_id` without leaving the conversation.
- Validate one or more submitted MTHDS files.
- Return valid, invalid, pending-signature, and no-verdict failure states in a stable structured result.
- Return optional graph data when requested and available.
- Project a pipe's declared inputs as a fill-in template (`mthds_inputs_template`), so an assistant can prepare inputs for a run without leaving the conversation. This unblocks the CLI-free skills in `../pipelex-plugins` (`pipelex-inputs`, `pipelex-design`) that used to shell out to `mthds-agent inputs bundle`.
- Generate typed code for a method (`mthds_codegen`): project its concept set into typed models — TypeScript (`ts-zod`) or Python (`python-pydantic`, `python-structures`), the target chosen from the project's context — stamped and locked by the Pipelex codegen engine, so an assistant working in a project writes the generated files and the lock verbatim and the offline check passes on the tree. On the local workshop, `output_dir` writes that tree straight into the project, so the bytes never enter the conversation at all.
- Prepare a pipe's *filled* inputs for a run (`mthds_prepare_inputs`): upload file-bearing values (local paths, `data:` URLs, bytes) to Pipelex storage and rewrite them to `pipelex-storage://`, so the inputs are run-ready — on the local workshop, using the user's key; the hosted console stays pass-through only.
- Turn a file the user attached in the chat into a run-ready storage reference (`mthds_upload_attachments`, hosted console only): fetch the host's signed attachment URL server-side and upload the bytes to Pipelex storage, returning `pipelex-storage://` URIs the assistant fills into an inputs template. This is what lets a ChatGPT user drop a PDF into the conversation and run a method on it without ever pasting a URL.
- Start a durable run of a method on the hosted Pipelex API (`mthds_run`), then check on it (`mthds_run_status`) and report its results (`mthds_run_results`) by durable run id — the run outlives any single tool call and even the conversation.
- Bring a completed run's produced files back to disk (`mthds_download_artifacts`, local workshop only): every `pipelex-storage://` reference in the run's main output is resolved to a fresh link through the API and saved under the server's working directory. This is the download counterpart of `mthds_prepare_inputs` — a generated image or PDF lands where the user is, instead of living behind a presigned link that expires within the hour.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.

**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.

**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to local OSS `pipelex-api`, or structured verdicts such as pending signatures, validation errors, and graph specs. It also cannot resolve a pipe's effective input contract (needs of the pipe minus what upstream pipes produce) — that projection is computed by the API from the parsed closure.

## UI Overview

`mthds_validate` ships a Skybridge view, `run-graph`: on a positive verdict that carries a `graph_spec`, a Skybridge-capable host renders an interactive method graph (via `@pipelex/mthds-ui`'s `GraphViewer`) inline above the model response, with a user-triggered fullscreen toggle for exploration. On a **runnable** verdict the same view also renders the method's **input form** below the graph — `@pipelex/mthds-ui`'s `RunPanel` over the wire input-form descriptor (`_meta.input_form`, requested from `/v1/validate` via the opt-in `views: ["input_form"]` token) with the per-pipe IO contracts co-walked beside it (`_meta.pipe_io_contracts`, keyed by the same namespaced `pipe_ref` set), defaulting to the bundle's main pipe (`_meta.main_pipe_ref`) and switching when the user clicks a pipe node in the graph. Since kernel `@pipelex/mthds-form` 0.5.0 the descriptor IS the field derivation — no schema heuristics — so the form appears only when both artifacts arrived. The form's Run button starts the method through `mthds_run` from the view (`useCallTool`, with the same `files` / `method_ref` / `method_id` the validation was called with), then follows the run by polling `mthds_run_status` and hands the conversation back to the model on the terminal outcome with the same canned prompt `run-follow` uses, so the assistant fetches and reports the results as its own turn. **Spike-level boundaries, stated plainly:** the form passes no `uploadFile` to the panel, so a file-bearing input renders a dropzone that cannot store anything on the console (there is no console tool that accepts browser bytes — `mthds_prepare_inputs` is pass-through-only there and `mthds_upload_attachments` takes host attachments, not files); text, number, choice and structured inputs run end to end. Invalid verdicts, pending-signature verdicts with no graph, and `include_graph: false` calls without contracts fall back to a compact, non-crashing empty state. The shared surface is the assistant conversation, the structured tool result, and this view.

`mthds_run` ships a second Skybridge view, `run-follow`: a self-polling status card that follows a durable run live (friendly status label, elapsed wall-clock, spinner) without any model turns — it polls the read-only `mthds_run_status` on a timer via `useCallTool`. On completion it fetches `mthds_run_results` once and renders the executed graph from the response's view-only metadata plus a compact output preview; on failure it shows the terminal status and failure message (and states plainly that no graph exists for failed runs). Once the terminal outcome is resolved (completed or failed), the view hands the conversation back to the model on its own via `sendFollowUpMessage` — one canned prompt naming the run id — so the assistant reports the outcome without the user prompting (the completion handoff, detailed in Run Scope). On remount it re-resolves the run by id, so reopening the conversation restores the card without re-firing the handoff.

**First view**: The MCP host lists the Pipelex tools: `mthds_list_methods`, `mthds_validate`, `mthds_inputs_template`, `mthds_prepare_inputs`, `mthds_run`, `mthds_run_status`, and `mthds_run_results`, plus `mthds_upload_attachments` on the hosted console only and `mthds_download_artifacts` on the local workshop only (see Deployments). `mthds_validate` and `mthds_run` carry the same two Skybridge views as before; the others are plain tools whose payloads are small structured data the model reads directly. `mthds_list_methods` is the assistant-first catalog entry point and deliberately adds no third view.

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
- **Auth**: optional for the validation and inputs tools; local development normally runs without hosted auth. The run tools execute on the hosted API, so a credential is effectively mandatory for them — a missing or invalid one is a `config` no-verdict. Each deployment sources it differently: the workshop reads a `plx_sk_` platform key from `PIPELEX_API_KEY` in the host-supplied process env; the hosted console authenticates each caller with per-user OAuth and forwards that caller's verified token (see Deployments).
- **Primary environment variable**: `PIPELEX_BASE_URL`, defaulting to `https://api.pipelex.com`.

## Deployments

The product ships as **two servers from one repo and one capability core**, sharing one logical identity: the same server key (`pipelex`), the same tool names (with one documented console-only exception, below), the same structured contracts, and the same verdict discipline. The capability core (`capabilities/`) knows nothing about which shell invoked it.

- **Hosted console** — the existing Skybridge HTTP server, deployed on Alpic. Serves remote-connector hosts (ChatGPT, claude.ai, Claude Desktop/Cowork as consumers). Registers the Skybridge views (`run-graph`, `run-follow`). Auth is **per-user OAuth, and only that**: the caller signs in with their Pipelex account through WorkOS AuthKit acting as an OAuth authorization server for MCP, and Skybridge owns the whole handshake (protected-resource metadata, `/.well-known/oauth-authorization-server`, Dynamic Client Registration discovery, JWKS bearer verification, per-host quirks). The verified token is lifted into every capability context (`src/hosted/contexts.ts`) and forwarded upstream as `Authorization: Bearer`, so identity flows through: the console mints nothing, stores nothing, and holds no key of its own. The token rides the transport only — never a tool argument, so it never enters the model's context. There is **no keyless or shared-key fallback**: the verified token always overrides any server-held `PIPELEX_API_KEY` (the credential determines the active organization and therefore the whole visible catalog), and the entrypoint refuses to boot unless both `WORKOS_AUTHKIT_DOMAIN` and `PIPELEX_MCP_RESOURCE_INDICATOR` are set. Because no console tool allows anonymous, Skybridge mounts `requireBearerAuth` across `/mcp`, so an unauthenticated request is rejected at the transport and never reaches a handler; the "no verified sign-in" texture in `contextsForRequest` is a fail-closed guard for an unreachable branch, not a served posture (it sets the credential to the empty string rather than leaving it absent, so the SDK's env-var fallback cannot substitute a server-held key). An auth failure the API reports (expired or revoked session, an org the account cannot reach) surfaces as a `config` no-verdict at `authorization` telling the caller to reconnect the connector and sign in again. (Bring-your-own-key — the interim posture where each caller pasted a `plx_sk_` key into a header or the connector URL — has been removed.)
- **Local workshop** — an npm-distributed stdio server (`@pipelex/mcp`, bin `pipelex-mcp`) that coding-agent hosts (Claude Code, Codex, Cursor, Cowork-as-builder) spawn via `npx`. Built on the plain MCP SDK (`McpServer` + `StdioServerTransport`) over the shared capability core. **Tools-first: it registers no views at launch** — the empirically verified V1 posture (view-rendering workshop hosts penalize localhost asset origins; the text summaries carry the flow on their own in text-only hosts). Auth is a per-user `plx_sk_` platform key in `PIPELEX_API_KEY`, supplied through the host's MCP server config env — per-user auth for free, no OAuth machinery.

Both shells register `mthds_list_methods` through the shared tool table. Catalog listing uses the same org-bound credential source as the existing by-id catalog paths: the request-scoped verified OAuth token on the hosted console and `PIPELEX_API_KEY` on the workshop. The credential determines the active organization and therefore the entire visible catalog; no catalog data is embedded in static server instructions.

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

**Path trust boundary (workshop, write side).** Two tools write into the user's workspace — `mthds_download_artifacts` saves a run's produced files, `mthds_codegen` writes a generated tree under `output_dir` — and they share one containment routine, on real paths, enforced on both sides of the one `mkdir`. A lexical check refuses `..` escapes and absolute paths before the filesystem is touched; then the deepest *existing* ancestor of the target directory is real-path-checked **before** `mkdir`, so a symlink inside the workspace pointing outside cannot have directories created at its target; then the created directory is real-path-checked again, which closes the window between the two. Refusals are `input_domain` at the caller's own field (`dir`, `output_dir`). Containment is also available *without* creation, which is what lets a writer contain every destination before deciding whether to write any of them.

**What the two writers do NOT share is policy, and they must not.** `mthds_download_artifacts` never overwrites, because its filenames come from a storage key and a collision means two different files. `mthds_codegen` must overwrite its own previous output and only that, because its paths come from the engine and the lock hashes them. One shared "write a file" helper would either suffix a regeneration or let a download clobber. Each scope states its own policy; the boundary above is all that is common.

**The tool table is shared except for one per-shell tool on each side.** Both shells register the same tool table from `src/tools.ts`, with two documented exceptions, one per shell — and each is deliberate rather than incidental, for the same reason inverted: the tool could never fire on the other shell, so advertising it there would spend every user's tokens on every `tools/list` for a capability that cannot work, and would invite the model to attempt it.

- **`mthds_upload_attachments` is registered on the hosted console only.** The tool's sole argument is a host-substituted attachment reference, and the substitution is gated by the host on the declared JSON Schema — a field only receives a file if it declares the mandated four-field object shape (see Attachment Ingest Scope). No stdio host performs that substitution, so on the workshop the tool would be *structurally unreachable*, not merely unused: nothing could ever populate it.
- **`mthds_download_artifacts` is registered on the local workshop only.** It saves a run's produced files under the server's working directory (see Artifact Download Scope). The console has no working directory and never writes a file — its users download run outputs from the app's UI — so there the tool would have nowhere to save to.

The shells already differ in behavior behind shared names (views on the console only, the `{ path }` resolver and the upload boundary on the workshop only); these two extend that per-deployment split to presence, for the tools whose input or output only one shell can handle. The invariant that still holds, and that matters for routing: **no tool name means different things on the two shells.**

**One host, one server.** A host should be connected to exactly one of the two shells, never both — same tool names on both mean a both-installed host has ambiguous routing. Notably, a claude.ai Pipelex connector syncs into Claude Code; a workshop user disables it there (`/mcp`) in favor of the local server.

## Naming Conventions

Tools are the contract; the `../pipelex-plugins` skills are the manual. The naming follows that split:

- **Server key: `pipelex`** — the product brand (Pipelex is the service; MTHDS is the language). Hosts derive their flattened tool names from it (`mcp__pipelex__mthds_validate` on Codex, `mcp__plugin_pipelex_pipelex__mthds_validate` on Claude Code).
- **Tool names: `mthds_<stem>`, snake_case** — operations on MTHDS-language artifacts, and on the assets that feed an MTHDS run. The `mthds_` prefix stays even though the server prefix could be argued to cover it: some hosts display or match bare tool names, generic verbs (`validate`, `run`, `upload`) collide across servers in a multi-server session, and a `pipelex_` prefix would stutter against the server key. The "and the assets that feed a run" widening is what admits `mthds_upload_attachments`: uploading to Pipelex storage is a runtime-specific operation on a user's file rather than on MTHDS-language content, so the brand boundary would argue for a bare or `pipelex_`-prefixed name — but a single unprefixed tool in an otherwise uniform list costs the model more (one incoherent family, one collision risk) than the loose prefix costs the brand. The tool is named for the workflow it serves, not for the storage it writes to.
- **Lifecycle families share a stem prefix** — `mthds_run`, `mthds_run_status`, `mthds_run_results` sort and display adjacently, so hosts and models see them as one family.
- **Names state what you get** — a noun-only name must name the artifact it returns (`mthds_inputs_template`, renamed from the ambiguous `mthds_inputs`); otherwise lead with the operation (`mthds_validate`).
- **Catalog listing is deliberately `mthds_list_methods`** — the repeated English word is acceptable: `mthds_` is the stable product-family prefix, while `list_methods` is the clearest operation/resource stem and stays recognizable when a host displays the bare tool name.
- **The two per-shell tools mirror each other by name** — `mthds_upload_attachments` (console: a chat attachment goes *up* into storage) and `mthds_download_artifacts` (workshop: a run's produced files come *down* to disk). Both lead with the direction, both name the thing moved, and neither borrows the run family's `mthds_run_` stem even though the download tool is keyed on a `run_id`: a noun-only `mthds_run_artifacts` would read as a listing, and "names state what you get" wins over family adjacency.
- **Parameter names mirror the route each tool wraps, not each other.** The same pipe selector is `pipe_ref` on `mthds_inputs_template` and `mthds_prepare_inputs` (the `/v1/build/*` envelope and the SDK's `prepareInputs` say `pipe_ref`) and `pipe_code` on `mthds_run` (`/v1/start` says `pipe_code`); both take the same qualified `domain.pipe_code` value. This is the workspace convention applied — `_code` is the default and may be qualified, `_ref` is reserved for where "always namespaced" genuinely matters — and neither name is wrong under it, so neither is renamed away from its route. What the surface owes the caller is that the two names must not surprise it: each parameter's description names the other tool's parameter as the same value, so an agent copying a pipe selector from the template call into the run call is told it can.
- **Tools are self-sufficient; the dependency on skills is one-way** — tool names, descriptions, and the server `instructions` never reference the plugin skills, because many consumers (ChatGPT, claude.ai connectors, raw MCP hosts) will never see them. The skills reference tool names verbatim, and where a skill is the manual for one tool the two share a stem (`pipelex-inputs` ↔ `mthds_inputs_template`); that side of the convention is recorded in `../pipelex-plugins/docs/decisions.md`.

## Method Selectors (`files` / `method_ref` / `method_id`)

Every method-taking tool (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`, `mthds_run`) selects the method it operates on in one of three forms — the platform's addressing contract, stated once here so the per-tool sections carry only their own mechanics:

- **`files`** — inline source: the shared submitted-files shape (`{ content, uri? } | { path }` — see Deployments). The method's contents travel in the request.
- **`method_ref`** — a published method's address: `github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`. Resolved **server-side by the runner**: the repository is fetched at the tag, the package is located by manifest identity, and the resolved commit SHA is recorded — no bundle ever enters the conversation. The registry form (any non-address reference) is reserved and answers `501`.
- **`method_id`** — a registered method's hosted catalog id (`mt_…`), org-scoped, from `mthds_list_methods`. Resolved server-side by the hosted platform wherever the platform supports it; always requires a credential, and always resolves the method's CURRENT stored content (methods are not versioned).

Two uniform rules govern how the selectors combine — there is no per-tool precedence folklore:

1. **Tooling tools (`mthds_validate`, `mthds_inputs_template`, `mthds_codegen`, `mthds_prepare_inputs`): exactly one selector.** Give files, an address, or an id — never several. A second selector is an instructive `input_domain` no-verdict located at the extra field (mirroring the API's own 422). These operations are stateless: there is no Run row, so "linkage" has no referent, and an extra selector could only be ignored — the worst contract of the three. This retires the old "files win, `method_id` is ignored" behavior, which was exactly the folklore the rule replaces.
2. **`mthds_run`: inline files win, and `method_id` beside them demotes to run-history linkage.** `files` + `method_id` together is legal — the files run and the id is recorded on the platform's Run row (the webapp's "run the editor's unsaved buffer, file it under its method"). `method_ref` is a complete run source of its own and pairs with **nothing**: `files` + `method_ref` and `method_ref` + `method_id` are both rejected — an address run carries its own provenance and needs no linkage id.

Where each selector is accepted, and who resolves it:

| Tool | `files` | `method_ref` | `method_id` |
| --- | --- | --- | --- |
| `mthds_validate` | yes | yes — server pass-through (`POST /v1/validate` resolves it) | yes — server pass-through (the hosted platform resolves it; hosted-only) |
| `mthds_inputs_template` | yes | yes — server pass-through (`POST /v1/build/inputs` resolves it) | yes — SDK-canonical client expansion (see below) |
| `mthds_codegen` | yes | yes — server pass-through (`POST /v1/codegen` resolves it) | yes — server pass-through (the hosted platform resolves it; hosted-only) |
| `mthds_prepare_inputs` | yes | no (see below) | yes — SDK-canonical client expansion |
| `mthds_run` | yes | yes — server pass-through (`POST /v1/start` resolves it; provenance returned) | yes — server pass-through (native on `/v1/start`) |

**Two deliberate asymmetries, stated so they do not read as drift.** The hosted platform's `method_id` tooling selector covers `validate`/`resolve`/`codegen` only — the `/v1/build/*` projections are deliberately excluded (frozen, being replaced by the codegen surface), and the SDK's `prepareInputs` is a client-side signature walk with no server leg at all. So the by-id paths of `mthds_inputs_template` and `mthds_prepare_inputs` expand the stored method client-side via the SDK's `getMethodClosure` (`buildInputs({ files: await getMethodClosure(methodId) })` — the SDK's own documented pattern for these surfaces), one shared leg with one place that maps `EmptyMethodSourceError`/404. The tool contract is unchanged by this mechanics: exactly one selector, the id resolves the method's current stored content, a credential is required. And `mthds_prepare_inputs` takes no `method_ref`: preparation is a client-side walk over a closure the caller supplies, an address's files live server-side, and only the console's pass-through arm could reach the signature without them — supporting the selector on one shell and not the other would fork the tool contract behind one name. The by-address flow is template-by-address → fill → run-by-address; prepare exists for local/byte assets, a workshop concern with files at hand.

**Verdict discipline on selector resolution.** A selector-resolution failure — an unknown or foreign-org `method_id` (404), a `method_ref` that does not parse or cannot be fetched (422), no package matching the address (404), an ambiguous address (422), the fetched-package structures refusal (403 — hosted execution accepts MTHDS concepts and sandboxed PipeFuncs, not in-process Python), a registry-form ref (501) — is a **no-verdict** `status: "error"`, never `is_valid: false`, which stays reserved for a verdict about actual MTHDS content. Each failure classifies with its location at the selector that caused it.

**Availability.** `method_ref` resolution is served by any pipelex-api ≥ 0.21.0 deployment, bare or hosted. On `api.pipelex.com`, hosted `method_ref` support and the tooling-route `method_id` selector land with the platform deploy the addressing campaign tracks as its Checkpoint 3; until that deploy is live, a selector-shaped call there answers a no-verdict error rather than a verdict, and the tools surface it as such.

## Catalog Discovery Scope (`mthds_list_methods`)

`mthds_list_methods` lists the registered methods visible to the active API key's organization through `@pipelex/sdk`'s `PipelexApiClient.listMethods()` (`GET /v1/methods`). It is a plain, read-only tool with no Skybridge view and no `_meta` payload: the assistant needs bounded names, descriptions, and canonical ids to choose a method, and a human catalog-management flow does not exist in this increment. Listing executes no method and spends no inference credit.

The public MCP input is:

```ts
{
  query?: string;  // case-insensitive substring, matched server-side over name and description
  limit?: number;  // integer 1..50; default 20
  cursor?: string; // opaque next_cursor from a previous call
}
```

`query` is trimmed and blank means no filter — the trimmed-away case omits `q` entirely rather than sending an empty string, which the API treats as bad input rather than as "no filter". Search, ordering and paging are all applied server-side: `q` matches across the whole catalog rather than one page, and rows arrive ordered newest first by the immutable `created_at` the catalog pages on. The MCP re-sorts and re-filters nothing — re-sorting would reorder a page against the cursor that produced it, and re-filtering would search only the rows the server already selected. A cursor is opaque and is passed back verbatim to continue.

Success projects exactly:

```ts
{
  status: "ok";
  returned_count: number;
  next_cursor: string | null;
  methods: Array<{
    method_id: string;
    name: string;
    name_truncated: boolean;
    description: string | null;
    description_truncated: boolean;
    created_at: string;
  }>;
}
```

The model-facing `name` is bounded to 200 Unicode code points and `description` to 500, with explicit truncation flags; the server's search examines their full stored values. `created_at` is reported rather than `updated_at`, because the catalog orders on `created_at` and showing a timestamp other than the sort key makes "newest first" unreadable. There is no total count in either form: counting a catalog means reading all of it, which is the cost paging exists to avoid. Missing descriptions normalize to `null`. Empty catalogs and no-match queries are successful empty results.

**There is no `has_source` flag.** The catalog index projection does not carry a method's source, and recomputing the flag would cost a `getMethod` per listed row — exactly the read the index exists to avoid. A source-less method instead announces itself where the answer is actionable rather than advisory: passing its id to by-id validate, inputs-template, prepare or run fails fast as an `input_domain` no-verdict at `method_id`.

The projection boundary is strict: `mthds`, `python`, `input_data`, `pipe_output`, `org_id`, and `created_by_user_id` never enter `structuredContent`, `content`, view metadata, or logs. The index projection no longer returns them, but the boundary is enforced on what actually arrives rather than on what the type declares, so a looser server cannot leak through it. A response that is not a page object, a page missing its `items` array, a **missing or** non-string `nextCursor`, or a row whose `method_id`, `name`, or `created_at` is not a string is a reachable, non-retryable `runtime` contract error rather than a partial list. `nextCursor` is checked as strictly as `items` on purpose: the SDK reads the raw wire key, so a renamed or dropped `next_cursor` arrives as `undefined`, and treating that as the end of the catalog would hide every method past the first page while every live check stayed green. The text summary repeats the bounded name, description, and canonical id for each returned row, and includes cursor/query guidance without source or stored defaults.

**The summary specifies the listing's presentation, because the name alone is not an answer.** A catalog listing is read almost verbatim by the user, and the description is what lets them choose; observed live on the same two-method catalog, one host answer rendered name + description while another rendered bare names and volunteered "both contain source code, but I haven't checked whether they validate" — the model filling the silence with the one field that carries no verdict. So the summary leads its list with an explicit render directive ("report every method with BOTH its name and its description"), puts name and description first on each row with `method_id` demoted to a trailing parenthetical, and says nothing at all about source or validity — the flag that once carried that caveat is gone, and a row that volunteered it demonstrably leaked into user-facing answers as a half-verdict. The directive lives in the summary rather than the tool description on purpose: ChatGPT caches a connector's tool list at add-time and never refreshes it, so the summary is the only channel where a presentation fix reaches existing installations. The tool description carries the same instruction as a backup for hosts that weight it at selection time. Names and descriptions are org-authored and therefore untrusted: each is collapsed to a single line so it cannot break out of its bullet, and the directive names them as data to display rather than instructions to follow. The directive is omitted when the page is empty.

No-verdict failures use the shared error shape. Unreachable API is retryable `config` at `PIPELEX_BASE_URL`; missing or rejected auth is `config` with the shell's texture (the console's reconnect-and-sign-in-again wording, the workshop's `PIPELEX_API_KEY` wording); 402 is the existing billing `config` arm, tagged `kind: "paywall"` so the headline names the plan rather than connectivity; a 400/422 is classified by request shape, because the route has two unrelated bad-request causes and only the caller's own input separates them: with no `cursor` supplied it is missing active-org context, `config` at the deployment's credential location; with a `cursor` supplied it is the cursor, `input_domain` at `cursor` with a start-over hint, since a machine consumer branches on the class and a paging fault must not read as an auth fault; missing `/v1/methods` (404) is `config` at `PIPELEX_BASE_URL`; 5xx and unexpected transport failures are retryable `runtime`; malformed success payloads are non-retryable `runtime`.

## Validation Scope (`mthds_validate`)

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[]; // { content, uri? } | { path } — see Deployments
  method_ref?: string;          // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;           // catalog id (mt_…) of a registered method
  include_graph?: boolean;
}
```

Exactly one of (non-empty `files`, `method_ref`, `method_id`) is required — the tooling rule from Method Selectors: no selector is `input_domain` at `files`, a second selector is `input_domain` at the extra field, and a supplied-but-blank selector is `input_domain` at that selector. Both selector forms are **server pass-throughs** carried on `POST /v1/validate` itself via `@pipelex/sdk`'s `validate({ method_ref })` / `validate({ method_id })`: the runner resolves an address through the same fetch path as a `method_ref` run, the hosted platform resolves an id against the org's catalog and injects the stored source before the runner sees the request. Nothing is expanded client-side, and diagnostics get their source labels from the package's (or the stored method's) real file names rather than an MCP-side `uri` relabel. Selector-resolution failures are no-verdict errors per Method Selectors, located at the selector: an unknown/foreign-org id or no package at the address (404), a ref that does not parse or fetch (422), the structures refusal (403), a registry-form ref (501); a paywall stays the generic 402 `config` arm (`kind: "paywall"`). A credential is required for by-id calls; the dry-run graph view and the input form work identically regardless of which selector supplied the content.

`include_graph` defaults to true. The graph rides the tool result's view-only `_meta` channel (`_meta.graph_spec`, consumed by the `run-graph` view), never `structuredContent`. When false, omit it entirely. The form's two per-pipe artifacts ride the same channel (`_meta.pipe_io_contracts`, the report's own map keyed by namespaced `pipe_ref`; `_meta.input_form`, the wire input-form descriptor the capability requests via the opt-in `views: ["input_form"]` token; plus `_meta.main_pipe_ref` — `domain.main_pipe` derived from the bundle blueprint) on a valid **and runnable** verdict that carries both, independently of `include_graph`. They are absent on pending-signature verdicts (a form whose Run can only fail is not worth advertising) and when the runner returned no descriptor (the token is lenient, so an older runner just omits `input_form` — the kernel derives the fields from the descriptor, so without it nothing is advertised rather than an empty form).

The capability always permits pending signatures and always requests rendered markdown from the Pipelex API.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: Array<"dry_run_graph" | "input_form">;
  validation_errors?: unknown[];
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    kind?: "paywall";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

The graph (`graph_spec`) and the form's artifact pair (`pipe_io_contracts`, `input_form`) are not part of `structuredContent`; on a positive verdict they ride the tool result's view-only `_meta` channel (`_meta.graph_spec`, `_meta.pipe_io_contracts`, `_meta.input_form`, `_meta.main_pipe_ref`) for the `run-graph` view, so the model never pays their tokens. Because the model never sees `_meta`, `available_view_specs` is its signal that a view exists to surface: it lists the renderable view kinds for this result. `"dry_run_graph"` is the method graph from the validation dry run, present exactly when its spec was produced (valid verdict with `include_graph` not false); `"input_form"` is the fill-in form for the main pipe's inputs, present exactly when both artifacts ride `_meta` (valid, runnable, non-empty contracts, and the descriptor returned by the `views` opt-in). The list is empty otherwise. On those same verdicts a short `## Views` note is appended to the `content` summary, worded for whichever views are present, so agents that read the prose more reliably than the structured fields also learn the views exist.

The MCP `content` text contains the human-readable summary. The summary is not duplicated in structured output. On a no-verdict error (`status: "error"`), the content summary is a terse headline followed by a Markdown list of each `errors[]` entry — its `location`, `message`, and `hint`. This surfacing is shared by every tool (the same `toolResultContent` helper): the agent reads `content`, so the actionable detail the capability writes into `errors[]` (e.g. the hosted `{ path }` rejection naming the local workshop) must reach that stream, not sit only in `structuredContent.errors` where a host that shows the agent only the top content line would strand it. `structuredContent.errors` stays the untouched machine contract.

**`kind` refines a class the headline cannot use.** Every no-verdict headline is derived from the error's `class`, which is the coarse machine contract and stays that way. One condition needs more: a **402 paywall** is deliberately `config` (the call cannot be made as credentialed), so a class-derived headline announces "the Pipelex API is unreachable or misconfigured" for what is a plan limit — and on a host that shows the agent only the top content line, that is the whole message, sending it to debug the base URL. So `classifyError`'s 402 arm also sets `kind: "paywall"`, and each capability's headline table declares a `paywall` entry alongside its three class entries; `summaryForToolError` consults `kind` first. The class contract is untouched — a machine consumer still branches on `class`, and `kind` is what lets it (and the headline) tell a billing refusal from an unreachable API without sniffing the message, exactly as `retryable` distinguishes a transient `config` from a permanent one. The headline table's type (`ErrorSummaries`) makes the `paywall` entry **mandatory**, so a new capability cannot inherit the connectivity headline for a billing refusal by omission — the miss is a type error rather than something a reviewer must catch. Adding a member to `kind` is how a future such cause gets its own headline; re-classifying it is not. One deployment note: the emitted `errors[]` object carries `additionalProperties: false`, so `kind` is a tool-schema change — a host that caches a connector's tool list at add-time and validates strictly (ChatGPT) must re-add the connector before it can receive a paywall result. The headline is unaffected either way: it rides the `content` text stream, which has no schema.

## Inputs Template Scope (`mthds_inputs_template`)

`mthds_inputs_template` projects a pipe's declared inputs as a fill-in template, wrapping `POST /v1/build/inputs` through `@pipelex/sdk`'s `buildInputs`. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` field — the template is small structured data the model must read, so it belongs in `structuredContent`.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[]; // { content, uri? } | { path } — see Deployments
  method_ref?: string;          // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;           // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}
```

- Exactly one of (non-empty `files`, `method_ref`, `method_id`) is required — the tooling rule from Method Selectors, with the same locations (no selector → `input_domain` at `files`; a second or blank selector → `input_domain` at that selector).
- `files` mirrors `mthds_validate`'s shape for consistency. The SDK's build envelope spells the provenance label `source` (`MthdsFileItem`), so the capability adapts `uri` → `source` at its boundary, the way validate adapts to `/v1/validate`'s parallel arrays.
- `method_ref` projects a published method by its address, as a **server pass-through**: `POST /v1/build/inputs` accepts the address on the wire (`BuildInputsRequest.method_ref`) and the runner resolves it through the same fetch path as a `method_ref` run, the package's real file names feeding the diagnostics. The registry form stays a 501. Selector-resolution failures are no-verdict errors at `method_ref` per Method Selectors.
- `method_id` projects a registered method by its catalog id. The build routes take no `method_id` (the hosted tooling selector deliberately excludes them — see Method Selectors), so the capability expands the stored method client-side via the SDK's `getMethodClosure` (a `GET /v1/methods/{id}` fetch plus the canonical parse of the polymorphic `MethodData.mthds` source — either raw `.mthds` source or a JSON-serialized `[{ name, content }]` file array, the webapp editor format), and forwards the resulting contents as the build envelope's files, each carrying the method id as its `source` provenance label so diagnostics point back at the registered method. A stored method with no MTHDS source is an `input_domain` no-verdict at `method_id` ("the stored method has no MTHDS source yet"), raised without calling the build route. Expansion-leg failures classify against the route `/v1/methods/{id}`: an unknown or foreign-org id is a 404 → `input_domain` at `method_id` (the catalog is org-scoped to the key's org, so a foreign-org method reads exactly like a miss; unlike `/v1/start`, the SDK does not intercept a missing-route 404 on this route, so a bare-runner base URL reads the same — the hint covers both causes), a paywall 402 → `config` (the generic billing arm, `kind: "paywall"`), and auth failures get the deployment's usual `config` texture — a key is required for by-id calls.
- `pipe_ref` is the pipe to project, as a qualified `domain.pipe_code` — the same value `mthds_run` takes as `pipe_code` (the names mirror their routes; see Naming Conventions). Optional; it defaults server-side to the closure's declared `main_pipe` (for a `method_ref`, the manifest's `main_pipe`), which fails as a no-verdict error (API 422) when the closure declares none or several across its domains.
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
    kind?: "paywall";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

Verdict discipline is identical to `mthds_validate`: any *produced* verdict is `status: "ok"`, discriminated on `is_valid`. On the valid arm the tool returns the resolved `pipe_ref` (always qualified), the echoed `format`/`explicit`, and the template on exactly one of `inputs` / `inputs_toml` (chosen by `format`; the unused field is absent). An unresolvable closure is a produced verdict: `is_valid: false` with `validation_errors[]` — the route answers 200 and consumers branch on the field, never on transport. `status: "error"` + `errors[]` is reserved for no-verdict conditions: bad request shape (`input_domain`), unreachable/misconfigured API or auth failure (`config`), unknown `pipe_ref` / unresolvable `main_pipe` default (API 422 → `input_domain`), or server faults (`runtime`) — classified by the same `classifyError` the validation capability uses.

The build routes return a plain `message` rather than `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe, the API message, and the template itself in a fenced code block (` ```json ` or ` ```toml ` to match `format`). Unlike validation, the template is deliberately duplicated between `structuredContent` and the summary — it is the payload the model must read, and some hosts read prose more reliably than structured fields.

## Codegen Scope (`mthds_codegen`)

`mthds_codegen` projects a method's concept set into typed artifacts in the language the calling context needs, wrapping `POST /v1/codegen` through `@pipelex/sdk`'s `codegen()`. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` field — decided on 2026-08-29: the summary's fenced blocks already carry the artifacts to every host, and ChatGPT has no download path for a view to improve on. It takes the same thin-front-end posture as every other tool here: the engine projects, the MCP selects the method, chooses nothing on the user's behalf that the model can choose from context, and hands the artifacts back verbatim so the codegen trust chain (stamps, `codegen.lock`, the offline check — the workspace's `docs/specs/pipelex-codegen.md`) survives the trip through a conversation.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[];   // { content, uri? } | { path } — see Deployments
  method_ref?: string;            // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;             // catalog id (mt_…) of a registered method — hosted-only, platform-resolved
  target: "ts-zod" | "python-pydantic" | "python-structures";
  output_dir?: string;            // local workshop only — write the tree here instead of returning its content
}
```

- Exactly one of (non-empty `files`, `method_ref`, `method_id`) — the tooling rule from Method Selectors, with the same locations. **Every selector is a server pass-through**: `method_ref` is resolved by the runner (the repository fetched at the tag), `method_id` by the hosted platform's tooling selector (`PipelexHostedToolingExtensions.method_id` on the SDK's `CodegenRequest`). There is no fetch-and-forward leg and no method source in the conversation; the tool is hosted-first for `method_id` exactly as `mthds_validate` is.
- `target` is **required and has no default** — the engine's flavor identifier, verbatim. There is no `language: "typescript" | "python"` alias layer: the codegen spec rejects a flat enum that mixes artifact kinds with output formats, the two Python targets differ by *audience* rather than language, and an alias would be a second vocabulary to keep in sync with the engine's. The enum is typed from the SDK's `CodegenTarget` and closed in both directions (`satisfies` rejects a target the SDK dropped; a `Record` over the union rejects one it gained), so a widened SDK widens the tool in a deliberate edit that also has to write the new target's profile. Picking the target is the tool's whole point, so the decision rule lives in the tool description and is derived from those profiles: the user's explicit request wins; a TypeScript or JavaScript project wants `ts-zod` (`types.ts` — zod schemas and inferred types, depending only on zod — plus `binder.ts`, a parse/serialize pair per concept; keep both); a Python consumer with no Pipelex runtime wants `python-pydantic` (`models.py`, plain `BaseModel`s); a Pipelex host or a `@pipe_func` implementation wants `python-structures` (`structures.py`, runtime `StructuredContent` classes). File names are fixed per target; what varies per method is the type names inside them. Field keys are wire-native snake_case in every target, TypeScript included.
- `kind` is **not exposed**: the engine serves one kind (`types`, the crate's whole concept set), and a single-member enum on every `tools/list` spends tokens on a choice that does not exist. The capability always sends `kind: "types"` and never a `pipe_ref` (the route rejects one on `types` with a 422 rather than ignoring it). When per-pipe kinds ship (`docs`, `tools`, `tests`), `kind?` and `pipe_ref?` are added together as optional fields — additive, not a rename.

The structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  target?: "ts-zod" | "python-pydantic" | "python-structures";
  kind?: "types";
  crate_fingerprint?: string;
  engine_version?: string;
  artifacts?: Array<{ path: string; bytes: number; content?: string; written_to?: string }>;
  lock?: { filename: string; bytes: number; content?: string; written_to?: string };
  truncated?: boolean;             // some content was withheld for size — whole files only, never a cut file
  // The written arm (output_dir was supplied and the write succeeded):
  output_dir?: string;             // the generated directory, relative to the working directory
  is_current?: boolean;            // the offline check's verdict over what landed on disk
  orphans?: string[];              // always present on this arm, empty when clean
  orphans_truncated?: boolean;     // a walk bound tripped, so orphan detection is partial
  drifts?: unknown[];              // present when non-empty — any drift that is NOT an orphan
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

**Verdict discipline** is `mthds_inputs_template`'s: a produced verdict is `status: "ok"` discriminated on `is_valid`; an unresolvable closure is `is_valid: false` with the shared `validation_errors[]` (the same items `mthds_validate` renders, so the assistant repairs through the validation flow and retries); `status: "error"` + `errors[]` is reserved for no-verdict conditions. On the valid arm the tool echoes `target` and `kind`, the crate fingerprint and engine version the stamps carry, and the artifact set plus its lock.

**Artifacts and the lock are handed over verbatim, always.** No reformatting, no re-serialized lock, no trimmed trailing newline: any byte change breaks the stamp's content hash and the lock's artifact hash, and the point of the trust chain is that a tree written from this tool is byte-identical to a local `pipelex codegen types` run, so `pipelex codegen check` and the SDK's `runCodegenCheck` pass on it. `bytes` is each file's UTF-8 size and is present even when its content is withheld. Prettier and ruff settings that rewrite generated files are the user's concern. What arrives is checked rather than trusted, because what arrives is what gets written into a user's tree — and the check runs on **both shells**, not only the write path: the console relays these bytes to a model that will write them, so a report the workshop would refuse is one the console must not hand over either. One notion of a valid report is what keeps the shells from diverging.

The check is the SDK's own: every valid response is fed to `runCodegenCheck` in memory before anything is written or relayed. That one call establishes far more than a hand-rolled rule set would — the lock parses and its `lock_version` is readable, every path in the lock and in the artifact set is safe, canonical and unique (control characters and drive prefixes included), and every artifact's stamp and body hash agree with the lock. A `CodegenLockError` and a non-current verdict are equally contract violations, and both are `runtime` no-verdicts. What remains hand-checked is only what the SDK cannot know: that `artifacts`, `lock` and `lock_filename` are present and typed, that every artifact path is one the check can verify (`isStampableArtifactPath`), that **the report answers the request that was sent** — `target` and `kind` are documented as an echo of the request's projection axes, and a report for another language is internally current and passes the offline check, so only comparing the echo catches it, which matters most on the write arm where `output_dir` would otherwise fill with another language's files and be reported as a current tree — and that **`lock_filename` is exactly `codegen.lock`** — the one name the SDK's own contract fixes, pinned rather than merely checked for being bare. That last rule is not decoration, and it earns three things at once: the writer joins the lock filename under the generated directory and the console hands it to a model that will do the same, so a `lock_filename` of `../../…` is the one value in the whole path that would otherwise reach a write uncontained; the lock lands where the offline check looks for it, so `pipelex codegen check` finds the tree this tool says passes; and it cannot **alias an artifact path**, since an artifact must carry a stampable suffix to reach here and so can never be `codegen.lock` — which closes the one case the in-memory preflight structurally cannot see, `runCodegenCheck` taking the lock content separately and never learning its filename, where the writer would overwrite an artifact it had just written with lock text and report that as drift. Containment in the writer still stands on its own — canonical is not the same as contained — but the rule belongs where it holds for both shells.

**The streams rule is written for size.** The artifacts are the payload the model must act on and also the largest thing this server puts in a response. `content` is present on `structuredContent.artifacts[].content` and `lock.content`, and the Markdown summary repeats each file in a fenced block tagged for its language (` ```ts `, ` ```python `, ` ```toml ` for the lock; the fence grows past any backtick run inside the file), because some hosts read prose more reliably than structured fields and the model needs the exact bytes to write files itself. Both copies are bounded by one budget over the whole set (`CODEGEN_CONTENT_CAP`, 64 KiB of UTF-8 — sized so a small method never truncates and a large concept set degrades rather than breaks), applied **by whole file, in order, stopping at the first that does not fit**, with **the lock's bytes reserved off the top** and the artifacts filling what remains. Filling artifacts first and letting the lock fall off the end would drop the trust anchor to fit the code it anchors, leaving the model code it cannot check under an instruction promising the offline check will pass on what it writes; the lock is the smallest file in the set, so the reservation costs the artifacts almost nothing. A lock that alone exceeds the cap is the one remaining truncation of it, and nothing rides then. The withheld files carry `path` and `bytes` with `content` absent, and `truncated: true` names what happened. A half file is worse than no file (a partial `types.ts` neither compiles nor passes the check), and a `binder.ts` without its `types.ts` is no more useful than none. The summary of a truncated result lists the withheld files with their sizes and points at generating locally with the CLI. Nothing rides `_meta`: there is no view to feed, and a non-LLM consumer reading the raw MCP result sees exactly what the model sees.

**Error classification** uses `classifyError` with route options chosen by request shape, like `mthds_validate`'s. On a files request a 400/422 locates at `target`: an unresolvable closure is a produced verdict on this route and the client sends only `kind: "types"` with no `pipe_ref`, so the projection axes are what is left, and the hint names the targets. A by-ref request's 422 / 404 / 501 locate at `method_ref` (parse or fetch failure, no matching package, the reserved registry form); a by-id request's 422 / 404 at `method_id` (no stored source or a deployment that does not resolve the selector on this route; an unknown or foreign-org id). A 402 is `config` with `kind: "paywall"`. **A 403 carries the deployment's auth wording plus the gate**: the hosted authorizer requires the `FF_PLAYGROUND` feature flag for `/v1/codegen` beside the plan checks, so a caller whose credential is perfectly valid can still be refused, and "check your key" would send them to debug the wrong thing — `classifyError` gained a per-route `forbidden` hint for exactly this, read on a 403 and never on a 401, composed at call time so the console's "reconnect and sign in again" wording stays in front. 5xx and a malformed report are `runtime`.

**Per-deployment behavior.** Both shells register the tool from the shared table: codegen has no host-specific input the way attachments do, and a stdio agent and a ChatGPT user both have a use — the agent writes the files into the project, the user copies them out of the chat. The `{ path }` arm follows Deployments (resolved on the workshop, rejected instructively on the console); the credential is the caller's OAuth token on the console and `PIPELEX_API_KEY` on the workshop.

### The write arm (`output_dir`) — local workshop only

Passing `output_dir` writes the generated tree to disk instead of returning its content, so the artifact bytes never enter the conversation at all. The directory is relative to the server's working directory, created if missing, and required to stay inside it — the write-side path trust boundary in Deployments.

**Both shells advertise `output_dir`, `readOnlyHint: false` and `destructiveHint: true`**, although only the workshop can write. An annotation says what a tool *may* do, and the console refuses the argument instructively (`input_domain` at `output_dir`, naming `npx @pipelex/mcp`) exactly as it refuses `files: { path }`. The alternative — a per-shell tool definition — was considered and rejected: this repo already ships two precedents for a shared definition whose affordances one shell refuses, and the invariant that no tool name means different things on the two shells is worth more than the cosmetic mismatch.

**Overwrite policy is the inverse of `mthds_download_artifacts`'s, deliberately.** That tool never overwrites, because its filenames come from a storage key and a collision means two different files. This one *must* overwrite, because its paths come from the engine, the lock hashes them, and regeneration has to land on the same names. So it overwrites its own previous output and only that:

- A destination that does not exist is written.
- A destination that is a **regular file carrying a codegen stamp** — for an artifact, the file's text starts with the begin marker in its suffix's comment syntax; for the lock, the text starts with `# codegen.lock` — is overwritten. **Whether or not it was hand-edited**: the stamp says not to edit by hand, edits below it are discarded without warning, and a formatter run over the generated directory must not become a permanent block on regeneration. The lock's test pins the `# codegen.lock` prefix rather than the engine's full header sentence, whose trailing prose the lock parser ignores entirely — a verbatim match would turn a reworded header into a "foreign file" refusal on a file this tool wrote itself.
- **Anything else refuses the whole write**: an unstamped file, a **symlink whatever it points at** (destinations are inspected with `lstat`, because an overwrite through a symlink writes wherever it points), a directory, anything not a regular file. The refusal is `input_domain` at `output_dir`, names the file, and points at using a dedicated generated directory.

**"Whole tree or nothing" describes the refusal path, not a crash.** Every destination — the lock included — is contained *before* anything is created, and every existing one is inspected before anything is written, so a refusal leaves the tree byte-identical, directories included. There is no temp-and-rename dance: what matters is that a half-written tree is *detectable*, which the lock already makes true, so the guarantee is **detectable**, not atomic. A failure mid-write is a `runtime` error naming what landed, with the hint to call again with the same `output_dir` — regeneration overwrites its own files, so the retry finds the stamped files it left and proceeds. The window between inspection and write is accepted: the workshop is one user in one working directory.

**After writing, the tree is checked against itself.** The directory is walked recursively — symlinks skipped, vendor and VCS directories pruned (`node_modules`, `.git`, `dist`, `build`, `target`, `.next`, `.venv`, `__pycache__`) — filtered with `isStampableArtifactPath`, decoded with a **strict** UTF-8 decoder (`readFile(p, "utf8")` substitutes U+FFFD and never throws, so a corrupted artifact could otherwise hash to the locked value and report current), and handed to `runCodegenCheck` with **the lock re-read from disk**, not the copy that was meant to be written — passing the in-memory copy would leave the one write the check exists to verify unverified. The walk is bounded by a file count and a decoded-bytes budget, because `output_dir: "."` is legal and would otherwise read a whole repository into a long-lived stdio process; the bounds apply to orphan candidates only, so the files just written are always read back and a tripped bound can never fabricate a `missing` drift. A tripped bound sets `orphans_truncated`, and the summary then says orphan detection was partial rather than reporting a clean tree it did not fully see.

**Orphans are reported and never deleted.** A stamped file the new lock does not list — left by an earlier generation into the same directory, a different target, or an engine version that renamed an artifact — comes back in `orphans` and stays on disk. Consequence, stated rather than discovered: **a directory holding more than one generation stays non-current by design.** The summary says what the orphans actually are and that a dedicated directory per generation is the fix; "delete them by hand" would be wrong advice the moment a user has generated two methods into one place.

**On the written arm, content is withheld from every stream.** `artifacts[]` carries `path`, `bytes` and `written_to`; `lock` carries `filename`, `bytes` and `written_to`; the summary names the files and the check verdict and carries **no fenced blocks**. `truncated` is always `false` — nothing rode, so nothing was withheld for size. **`output_dir`'s presence is the arm discriminator** (with `written_to` per file), not `truncated` and not a new field: a third encoding of one fact is a third thing to keep aligned.

**A refused or failed write is a no-verdict `status: "error"`, never a fallback to riding the content.** The caller asked for a write and none happened; silently inlining tens of kilobytes they did not ask for would both blow the budget and change the shape they expected, and the retry is one cheap call with a fixed `output_dir`. A **produced-invalid** verdict never touches disk at all, on either shell: it carries no artifacts, so the write arm is never reached.

## Prepare Inputs Scope (`mthds_prepare_inputs`)

`mthds_prepare_inputs` prepares a pipe's *filled* inputs for a run: it uploads the file-bearing values to Pipelex storage and rewrites them to the canonical content shape carrying `pipelex-storage://`, so the returned `inputs` can be handed straight to `mthds_run`. It wraps `@pipelex/sdk`'s `prepareInputs`. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` — the prepared inputs are small structured data the model reads directly.

Where it sits in the flow: `mthds_inputs_template` produces the empty template → the agent fills it (with text, `http(s)` URLs, local file references, or inline bytes) → `mthds_prepare_inputs` turns the filled inputs into run-ready inputs → `mthds_run` executes them. The prepare step is what makes local/byte assets runnable; an inputs set that is already all pass-through (`http(s)` URLs, existing `pipelex-storage://` URIs) can skip prepare and go straight to `mthds_run`.

The public MCP input shape is:

```ts
{
  files?: SubmittedFileInput[];    // { content, uri? } | { path } — the method closure (signature source)
  method_id?: string;              // catalog id (mt_…) of a registered method
  pipe_ref?: string;               // qualified domain.pipe_code; omit to default to the closure's main_pipe
  inputs: Record<string, unknown>; // the caller's FILLED inputs (the mthds_inputs_template output, populated) — compact or the explicit {concept, content} envelope
}
```

- Exactly one of (non-empty `files`, `method_id`) is required — the tooling rule from Method Selectors (no selector → `input_domain` at `files`; both, or a blank `method_id` → `input_domain` at `method_id`). There is deliberately no `method_ref` on this tool — preparation is a client-side signature walk, and an address's files live server-side (see Method Selectors). A `method_id`-only request expands the stored method via the shared `getMethodClosure` leg (`fetchMethodFiles`), exactly as `mthds_inputs_template` does — one by-id expansion path across the two build/prepare-surface tools, one place that maps `EmptyMethodSourceError`/404 — and the capability then always calls `prepareInputs({ files })` (the SDK's `prepareInputs` takes files only).
- `pipe_ref` is the pipe whose declared signature drives asset identification — the same qualified value as `mthds_inputs_template`'s `pipe_ref` and `mthds_run`'s `pipe_code`. Optional; it defaults server-side to the closure's `main_pipe`. Unlike `mthds_inputs_template` there is no `format` / `explicit` — this tool returns prepared inputs, not a template.
- `inputs` is **required** (it is the whole point — the filled values to prepare). An empty object `{}` is accepted (nothing to prepare); it passes through and uploads nothing. **Both filled template shapes are accepted**: the compact value, and the explicit `{concept, content}` envelope that `mthds_inputs_template` returns by default (`explicit: true`). An envelope's inner `content` is interpreted exactly as the compact value would be, and the envelope is **preserved on output** — the `concept` annotation rides through to the run, which the runtime accepts as a first-class explicit form. The envelope is recognized by the strict rule "a plain object whose keys are *exactly* `concept` and `content`", so a declared structured concept that merely happens to carry both fields is not misread as one. This matches `@pipelex/sdk`'s `prepareInputs` (0.9.0+) and the console's pass-through mirror behaves identically.

**Signature-driven asset identification (inherited from the SDK).** The SDK resolves the pipe's declared signature (via `buildInputs`, `explicit: true`) and walks the caller's `inputs` top-down against it. Only values at Image/Document-declared positions are treated as assets; the identical bare string at a Text position is never touched. Per file-bearing value:

| Source at a file-bearing input | Action |
| --- | --- |
| Local filesystem path (Node) / `data:` URL / inline bytes | Uploaded to Pipelex storage → rewritten to `pipelex-storage://` |
| Existing `pipelex-storage://` URI | Already prepared — passes through unchanged |
| `http(s)` URL | Passes through unchanged |

**Per-deployment asset boundary (the seam).** Uploading a local/byte asset requires reading the caller's bytes, which only the deployment co-located with those bytes can do. This is the same per-deployment split as the `{ path }` arm, gated by a per-deployment capability seam on the capability context (analogous to the file `resolver`):

- The **local workshop** prepares local paths, `data:` URLs, and bytes within its asset boundary, uploading with the user's `PIPELEX_API_KEY`. It delegates the upload walk to the SDK's `prepareInputs`.

  **The upload size ceiling is ~7.5 MiB decoded, not the documented 50 MiB.** Measured 2026-07-31 against the hosted API: 7.4 MiB uploads, 7.5 MiB is rejected `413`. `POST /v1/upload` takes a base64 JSON body behind an AWS API Gateway HTTP API integration, whose 10 MiB request limit is a hard quota; base64's 4/3 inflation puts the decoded wall at exactly 7.5 MiB. The app-level `MAX_UPLOAD_MIB` (50 MiB) is therefore unreachable through the public gateway and must not be quoted as the limit anywhere.

  The ceiling is enforced client-side by `SizeGuardedPipelexApiClient` (`capabilities/upload-ceiling.ts`), a `PipelexApiClient` subclass overriding `upload` — the one seam the MCP owns, since the SDK's `prepareInputs` walk reaches the wire through `this.upload`. One override therefore covers both the workshop's delegated walk and `mthds_upload_attachments`'s own `uploadFile` calls. It throws the same `RejectedAssetError` a real `413` maps onto, so every downstream classifier is unchanged; what improves is that the message can name the actual limit, which the server's cannot. **What it does not do is skip reading and base64-encoding the asset first**: for a local path the SDK owns that step inside `uploadFile` (`readLocalPath`), so refusing before the read needs a pre-flight in `@pipelex/sdk` itself — a cross-repo item, carried alongside the presigned direct-upload redesign. The wasted network round-trip, the expensive half, is gone either way. `MAX_UPLOAD_BYTES` is derived from the gateway quota rather than hardcoded, so the derivation stays visible.
- The **hosted console** is **pass-through only**: it accepts `http(s)` URLs and `pipelex-storage://` URIs, and **refuses any input that would require an upload** — a `data:` URL, inline bytes, or a local path — with an instructive `input_domain` no-verdict located at `inputs`, naming the local workshop (`npx @pipelex/mcp`) and the pass-through alternatives. The console never reads a filesystem and never uploads. (Per-user OAuth gives each console caller their own identity, which settles *whose* storage an upload would target — but inline `data:` bytes still bloat the model's context, the exact cost the workshop's `{ path }` design exists to avoid, so console byte upload stays deferred until a proper out-of-band attachment channel exists; see Non-Goals.)

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
    kind?: "paywall";
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
- `config` — auth failure (`UploadAuthenticationError` / `ClientAuthenticationError`, 401/403, carrying the deployment's auth texture), a paywall (402, the org's plan does not cover the call, tagged `kind: "paywall"`), an unreachable API, and a deployment with no upload route (`UnsupportedUploadCapabilityError`, 404).
- `runtime` — a transport/server fault reaching the upload route (`UploadTransportError`, a 5xx / unreachable host / malformed `data:` payload), and a reachable-but-malformed report.

Each is classified in `classifyError` (extended for the `InputPreparationError` family — these derive from `PipelineRequestError`, so they must be mapped ahead of the generic arm, as `EmptyMethodSourceError` already is in `fetchMethodFiles`) with its `retryable` verdict, using per-route `ClassifyErrorOptions` (400/422 located at `pipe_ref`; the by-id 404 at `method_id`; the deployment auth texture threaded from the context's `authError`).

**Summary.** The build/prepare surface returns no `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe (when known), a one-line note of how many assets were uploaded vs passed through, and the prepared `inputs` in a fenced JSON block (the `mthds_inputs_template` duplication pattern — the prepared inputs are the small payload the model must carry to `mthds_run`).

## Attachment Ingest Scope (`mthds_upload_attachments`) — hosted console only

`mthds_upload_attachments` turns a file the user attached in the conversation into a run-ready `pipelex-storage://` reference. It is the hosted console's answer to the question the workshop answers with `{ path }` items: *how does the user's actual PDF reach a run without its bytes crossing the model's context?* The console fetches the host's signed attachment URL server-side and uploads the bytes to Pipelex storage under the signed-in caller's own identity; only small URI strings return to the model.

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
- **Host allowlist**: the host must be OpenAI-owned — `oaiusercontent.com` at the apex or on **any** subdomain, or `oaisdmntpr<azure-region>.blob.core.windows.net`. Everything else is refused. The two rules are asymmetric on purpose, and the asymmetry is the whole point:
  - On `blob.core.windows.net` a **literal** host list is not an option (four captures in one afternoon, from one user in one location, came back from three different Azure regions — `newzealandnorth`, `koreacentral`, `westus` — so the region is assigned per upload and bears no relation to the user), and a **suffix-only** rule is equally unacceptable in the other direction, because that suffix is **multi-tenant**: any Azure customer can create a storage account under it. Hence the `oaisdmntpr` prefix, required and never optional.
  - On `oaiusercontent.com` that reasoning does not apply. The domain is registered and locked by OpenAI and served from their own nameservers, so there is no "any customer" hazard for a prefix to filter out. A narrower rule would buy no security and would break at the next subdomain rename — which is exactly what happened: the boundary shipped knowing only the Azure endpoint and `files.oaiusercontent.com`, and refused every ChatGPT attachment the day serving moved to `sdmntpr<azure-region>.oaiusercontent.com` (same region token, Cloudflare-fronted). The accepted residual risk is a dangling-subdomain takeover on OpenAI's domain, granting one bounded, credential-free, non-redirected GET of a public name.
  - The subdomain test anchors on the dot separator, so a lookalike registration (`oaiusercontent.com.evil.com`, `notoaiusercontent.com`) cannot satisfy it.
- **Redirects**: refused outright. A signed SAS URL has no reason to redirect, and refusing is simpler and stricter than comparing hosts across a redirect chain.
- **Size**: refused **before the body is read**. `fetch` resolves on the response headers, so a `content-length` over the cap is refused there and the body is cancelled without a byte of payload being pulled — one request, no ranged pre-flight needed. The stream is *also* bounded mid-flight, so an absent or lying header cannot exceed the cap.
- **Timeout**: a bounded connect+read budget on the fetch leg.
- **Credentials**: none forwarded — no cookies, no auth headers, no ambient identity.
- **Response**: non-2xx is refused.

The classic SSRF targets — link-local metadata, loopback, RFC1918 — are unreachable *by construction* under https-only + host allowlist + no-redirects. But these hosts are undocumented vendor infrastructure that changes without notice — it already has once — so the byte cap, the timeout, and the no-redirect rule must hold on their own: **the host check is a filter, not the defence.**

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
- `config` — upload auth failure (`UploadAuthenticationError` / `ClientAuthenticationError`, 401/403, carrying the console's reconnect-and-sign-in texture), a paywall (402, tagged `kind: "paywall"`), an unreachable API, a deployment with no upload route (`UnsupportedUploadCapabilityError`, 404).
- `runtime` — a fetch timeout or network fault, a non-2xx from the storage host, and a transport/server fault reaching the upload route (`UploadTransportError`); retryable.

One case deserves its own note: a **`403` on the download URL** is an expired signed link, classified `input_domain` at that attachment. Recovery is **re-attaching the file**, not repeating the same call — so it carries `retryable: false`, and the hint is what states the fix. (The `retryable` field means precisely "retrying *this same call* may succeed"; the link is dead permanently, and a new attachment is a different call with a different URL. Marking it `true` would invite a pointless identical retry.) The link's life is about five minutes from the tool call, which is why the bytes are ingested during the call rather than forwarded (see below).

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
  method_ref?: string;               // published method address — see run-by-address below
  method_id?: string;                // catalog id (mt_…) of a registered method — see run-by-reference below
  pipe_code?: string;                // pipe to run — the same qualified value mthds_inputs_template takes as pipe_ref; omitted → server resolves the bundle's (or the manifest's) main pipe
  inputs?: Record<string, unknown>;  // method inputs, as filled from the mthds_inputs_template template
}

// structuredContent
{
  status: "ok" | "error";
  run_id?: string;             // the durable pipeline_run_id — the handle for everything else
  run_status?: RunStatus;      // initial state from the ack, when the server includes one
  created_at?: string;
  method_provenance?: {        // method_ref runs only — what was actually fetched
    address: string;
    tag: string | null;        // null for a bare address (default branch at HEAD)
    commit_sha: string;        // the honest cache key; what keeps the run explainable when a tag moves
  };
  available_view_specs: Array<"live_run_status">;
  errors?: ToolError[];        // no-verdict only
}
```

`RunStatus` is the hosted lifecycle set: `PENDING | STARTED | RUNNING | COMPLETED | FAILED | CANCELLED | TERMINATED | TIMED_OUT`. The `content` summary states the run was accepted, gives the id, and spells out follow-up etiquette for the model (check with `mthds_run_status`, fetch with `mthds_run_results` when terminal, don't poll in a tight loop). Deliberately not exposed in v1: `output_name`, `output_multiplicity`, `dynamic_output_concept_ref`, `extra`, webhooks, client-supplied run ids. Binary inputs (PDFs, images) ride reachable https URLs inside `inputs`, or are turned into `pipelex-storage://` references first by `mthds_prepare_inputs` (see Prepare Inputs Scope) — on the local workshop from local paths/bytes, on the hosted console from `http(s)`/`pipelex-storage://` pass-through only.

**Run-by-reference (`method_id`)**: the tool also starts a registered method by its catalog id, so the model never carries the bundle — a run of a registered method is a tens-of-tokens call from any host. `method_id` is a separate optional top-level argument beside a now-optional `files` — deliberately **not** a third arm on the files union (a method id is not a file, and a mixed array would falsely suggest merging) and not a distinct tool (one run tool for the model; the lifecycle family keeps its stem). Request shape follows the run rule from Method Selectors: at least one source among (non-empty `files`, `method_ref`, `method_id`) is required, else `input_domain`; a supplied-but-blank selector is `input_domain` at that selector; id format beyond non-blank stays server-owned (the same stance as `run_id`). Precedence mirrors the platform: **inline `files` win** — when both are supplied, the files run and `method_id` is recorded as the run-history linkage on the platform's Run row (the webapp's own semantics for saved methods); `method_id` alone resolves the stored method's source server-side, natively on `POST /v1/start` (no fetch round-trip, no bundle on the wire). Methods have no versioning: a by-id run always executes the method's **current** stored content — the tool description states this explicitly so agents don't assume a run pins what they previously validated. By-id calls require a credential (the catalog is org-scoped to its org); an unauthenticated call fails with the existing instructive `config` auth texture.

**Run-by-address (`method_ref`)**: the tool also starts a published method by its address — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0` — as a **server pass-through**: the SDK's typed `method_ref` start option rides `POST /v1/start`, the runner fetches the repository at the tag, locates the package by manifest identity, and runs it. A `method_ref` is a complete run source and pairs with nothing (`files` + `method_ref` and `method_ref` + `method_id` are both `input_domain` rejections — see Method Selectors); `pipe_code` beside it is legal and overrides the manifest's `main_pipe`. The start ack's `method_provenance` (`{address, tag, commit_sha}`) is surfaced in `structuredContent` and echoed in the summary — the resolved SHA is what keeps the run explainable when a tag moves. Selector-resolution failures are no-verdict errors at `method_ref` (a ref that does not parse or fetch → 422; no matching package → 404; the structures refusal → 403; a registry-form ref → 501), classified before anything executes — no inference credit is spent on a failed resolution.

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

**On the local workshop, a completed summary whose output references stored files says so.** A run that produced an image, a PDF or a document carries it in `main_stuff` as content with a `pipelex-storage://` reference in `url` beside a presigned `public_url` that expires within the hour. The results summary is the moment the agent decides what to do with that, so on the shell that registers `mthds_download_artifacts` the summary counts those references (on the full output, not the bounded copy) and names the tool with the expiry stated. The nudge is prose only — `structuredContent` is unchanged — and it is gated on the run context's `artifactDownloadAvailable`, set by the workshop shell alone, so the console (which has no such tool) never emits it.

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

- `input_domain` — empty/blank `run_id`, blank `pipe_code`, no run source supplied (none of `files` / `method_ref` / `method_id`), a blank selector, an illegal selector pairing (`files` + `method_ref`, `method_ref` + `method_id` — rejected before the wire), request-shape 400/422 at start, unknown `run_id` (a 404 on the run routes with the server's structured error envelope), unknown `method_id` (a 404 on `/v1/start`, located at `method_id`, not retryable — the hint says to check the id as the catalog returned it; the catalog is org-scoped to the API key's org, so a method from another org reads exactly like a miss), and the `method_ref` resolution failures (parse/fetch/ambiguity 422, no-matching-package 404, the structures refusal 403, a registry-form ref 501 — all at `method_ref`). On an id-only start the 400/422 arm covers two causes with one combined hint at `method_id`: the stored method may have no MTHDS source yet, and if the error mentions organization context the key's org binding is the issue (mint a key in the right org) — no message-sniffing to split them. On a mixed start (files + `method_id`) a 400/422 locates at `files` instead — the files are the executed source, so the rejection is about the submitted bundle/pipe_code/inputs, never the stored method (stored-source resolution does not run on that path).
- `config` — missing/invalid `PIPELEX_API_KEY` (401/403), a paywall 402 (the org's plan does not cover the call — classified on the HTTP status, never the problem `code`, no location, not retryable, tagged `kind: "paywall"` so all three run headlines name the plan instead of connectivity, with a hint pointing at the org's plan/billing on app.pipelex.com; this arm is generic across routes), unreachable API, `RunLifecycleUnavailableError` (the configured base URL points at a bare runner — durable runs need the hosted API).
- `runtime` — 5xx, malformed report (e.g. a completed result missing `main_stuff`, the SDK's `MissingMainStuffError`).

The unknown-id 404 vs missing-route 404 distinction comes from the SDK: a missing lifecycle route throws `RunLifecycleUnavailableError` (`config`), while an unknown id surfaces as a plain 404 `ApiResponseError` (`input_domain`, via a per-route classification override). The same holds for an unknown `method_id` on `/v1/start`: any `ApiResponseError` 404 that reaches classification there is the platform's structured unknown-method envelope (a bare runner's missing-route 404 was already intercepted as `RunLifecycleUnavailableError`), so the `notFound` override at `method_id` is safe — and the same interception makes the `method_ref` `notFound` override safe on an address-shaped start (a 404 there is the runner's no-matching-package refusal). The classify options follow the executed source, in four shapes: an address request gets the by-ref texture (400/422, 404, and 501 all at `method_ref`); an id-only request gets the full by-id texture (400/422 and 404 both at `method_id`); a mixed request (files + `method_id`) keeps the files 400/422 texture but retains the by-id unknown-method 404 at `method_id` (a 404 there is about the linkage id, the one field the files cannot explain); a files-only request keeps today's options so nothing regresses.

Every `errors[]` entry also carries `retryable` — whether retrying the same call may succeed. It is decided in `classifyError`, where the concrete SDK error / HTTP status is still known, because the class+locator pair alone cannot: an unreachable API (transient) and a missing run lifecycle (permanent) both classify as `config` at `PIPELEX_BASE_URL`, and a 5xx (transient) and a malformed report (permanent) are both `runtime`. The `run-follow` view's poll loops branch on this flag (`isTransientPollError`) — transient errors keep the follow alive with a reassuring note, hard errors stop polling and surface the classified message.

**Start-time rejection on the hosted API**: `/v1/start` reports runner-rejected submissions — an invalid bundle, missing required inputs — as a 422 carrying the real rejection reason (`input_domain`); earlier platform builds answered a generic 503 "Failed to start pipeline". The per-route 5xx hint is kept for any 503 that still occurs, pointing the agent at `mthds_validate` / `mthds_inputs_template` before blaming the platform, and the `mthds_run` tool description still nudges validating first — validation gives a structured, repairable verdict, where a start-time rejection only reports the failure.

**View: `run-follow`** (registered on `mthds_run`) — described in UI Overview. `available_view_specs` on `mthds_run` lists `"live_run_status"` when the view is registered; `mthds_run_results` lists `"run_graph"` when the executed graph rides its `_meta` (the kind is minted now; a view directly on the results tool is a later increment).

**Completion handoff**: when the view resolves the run's terminal outcome — its results fetch settles on `completed` or `failed` — it fires one `sendFollowUpMessage` with a canned prompt naming the run id ("Run <id> completed — report the results." / "Run <id> failed — report what went wrong."), handing the conversation back to the model so the assistant reports the outcome without the user prompting. This deliberately reverses the earlier opt-in-only stance (design note §6.6): an unsolicited turn that closes the loop on a run the user started is worth more than the silence. Rules:

- **At most one handoff per run.** A `notified` flag rides the host-persisted view state (alongside `run_id`/`last_known`), so a remount of an already-notified run — reopening the conversation — stays silent; an in-mount ref guards the window while the view-state write round-trips.
- **Best-effort, never retried in-session.** A host that rejects the view-initiated turn gets no in-session retry (a reject → rollback → retry loop otherwise); the persisted flag rolls back so a later remount may attempt once more. The "Summarize in chat" button on the completed card remains as the manual re-trigger/fallback, sending the same run-id-bearing prompt.
- **Run outcomes only.** Hard poll errors and results-fetch errors never auto-fire — they are failures of the *follow*, not of the run (which may still be executing server-side); those cards keep their `data-llm` text only.
- **Both outcomes notify.** A failed run hands off too — the failure is precisely when the user wants the assistant to step in and explain.

**Output image trust model**: an image `public_url` in `main_stuff` renders in the completed card only inside two containment layers.

## Artifact Download Scope (`mthds_download_artifacts`) — local workshop only

`mthds_download_artifacts` brings a completed run's produced files back to disk. It is the workshop's download counterpart to its upload path: `mthds_prepare_inputs` pushes local files *into* Pipelex storage and rewrites them to `pipelex-storage://` references; nothing brought a run's outputs back *out*. A run that produces an image, a PDF or a document returns it in `mthds_run_results` as content carrying its `pipelex-storage://` reference in `url` beside a presigned `public_url` with a one-hour life — so every file a run produced reached the user as a link that dies within the hour, and whether it ever landed on disk depended on the agent thinking to fetch it in time (observed live: the generated image reached the user only because the agent happened to fetch the link before expiry, and first into a scratch directory rather than the workspace). This tool makes that outcome the default. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` — the saved paths are small structured data the model reports directly.

**Why a companion tool and not an option on `mthds_run_results`.** Two shapes were plausible: a `save_artifacts` flag on the results tool, or this companion. The companion keeps the tool contract simplest on four counts. First, `mthds_run_results` is registered on both shells under one name, and a flag only the workshop could honor would make that name mean different things on the two deployments — the one invariant the per-shell split is built to preserve. Second, the results tool is annotated read-only; writing files to the user's disk is not a read, and a per-shell annotation is a contract fork behind a shared name. Third, the results projection is already the busiest surface in the repo (bounding, usage, three `_meta` channels); a filesystem write does not belong inside it. Fourth, a separate tool answers the durable case on its own terms — "save the files from run X" days later is one call with the id, no re-projection of a result the agent already read. The cost is one more tool on the workshop's list, and it is the cost `mthds_upload_attachments` already pays on the console for the same reason.

**Why it is keyed on the run id, not on a list of URIs.** The run id is the durable handle the whole family already uses, and the agent holds it. Taking `uris` instead would have the agent copy references out of a bounded result (a pruned copy could have dropped one) and would invite misspelled schemes; taking the id lets the tool walk the run's **full** main output, find every reference, and resolve each through the API to a **fresh** presigned link (`POST /v1/resolve-storage-url`, the SDK's `resolveStorageUrl`) — so the hour-long life of the `public_url` embedded in the results never matters, and the same call still works days after the run. Finding the references is a contract, not a heuristic: the scheme is unambiguous, so every string beginning with `pipelex-storage://` anywhere in the output is a produced file (or an input the output echoes — accepted, and harmless). Nothing is guessed from field names.

The public MCP input shape is:

```ts
{
  run_id: string;   // the durable run id from mthds_run
  dir?: string;     // where to save, relative to the server's working directory; created if missing; must stay inside it
}
```

- `run_id` follows the run family's stance: non-blank is the only client-side check, format is server-owned.
- `dir` is optional and relative. A blank value, an absolute path, a lexical escape (`../x`) and a symlink inside the workspace that points out of it are all refused as `input_domain` at `dir`. Omitted, files land directly in the working directory — that is where the user is.

**Behavior.** The tool reads the run (`GET /v1/runs/{id}/results`, the same route and classification as `mthds_run_results`) and branches on its state exactly as the results tool does: `running` and `failed` are produced verdicts (`status: "ok"` with `state`), since "nothing to save yet" and "a failed run produced nothing" are answers. On `completed`, it collects the storage references from the full output; a completed run with none is a produced, vacuously successful verdict (`artifacts: []`, `all_saved: true`) and no directory is created. Otherwise it resolves the target directory, then per reference, sequentially: resolve the reference to a fresh link and its content type through the API, derive the filename, download within the boundary below, and record the outcome. Per-item failures ride the item; the walk continues.

**Write policy (this tool's own).** Containment is the shared write-side boundary described in Deployments. What is specific here is the *filename* and the *collision rule*, and both follow from where the names come from. The filename is never taken from anything the caller typed: it is the last segment of the storage key, reduced to `[A-Za-z0-9._-]` with leading dots stripped (no hidden file, no `..`), capped in length with the extension preserved where one fits, and given an extension from the object's content type when the key carries none (a short table: the image, PDF, text and JSON types a run produces; an unknown type gets no extension rather than a guessed one). An empty result falls back to `artifact-N`. Path separators are the split point, so no traversal survives. **Files are never overwritten**: the file is created exclusively (`wx`) and a name collision gets a numeric suffix (`name-1.ext`). A collision here means two *different* files, so suffixing is the right answer — the exact inverse of `mthds_codegen`'s write arm, whose paths come from the engine and whose regeneration must land on the same names. The two writers share containment and nothing above it.

**Download boundary.** The link is the configured API's own answer, so this is not the SSRF surface the attachment fetch boundary guards — but a download that writes to the user's disk is bounded regardless of who named the URL: `http(s)` only (`http:` accepted deliberately, because the local stack's object store hands out plain-http presigned links and the tool is dogfooded there), no credentials in the URL, redirects refused outright, a bounded timeout covering the body read, and a byte cap enforced from `content-length` before a byte is written and again mid-stream. The cap (1 GiB) is an accident guard against filling the disk, not a product limit: run outputs are produced server-side, so a user cannot shrink one the way they can shrink an upload, and a low ceiling would leave them with no recourse but the expiring link. A refused or failed download leaves no partial file behind. A `404`/`410` from the object store is a vanished object (`input_domain`, not retryable); a `401`/`403` is the store refusing a *fresh* signature (clock skew, a signing misconfiguration), which retrying — hence re-minting — may fix, so it is `runtime` and retryable; other non-2xx and network faults are retryable `runtime`.

The structured output is:

```ts
{
  status: "ok" | "error";
  run_id?: string;
  state?: "running" | "completed" | "failed";   // mirrors mthds_run_results
  retry_after_seconds?: number | null;          // state=running only
  run_status?: RunStatus;                       // state=failed only
  failure_message?: string;                     // state=failed only
  artifacts?: Array<{                           // state=completed only — one per storage reference, in discovery order
    uri: string;                                // the pipelex-storage:// reference found in the output
    path?: string;                              // where it was saved, relative to the working directory — on success
    content_type?: string | null;
    size?: number;                              // bytes written
    error?: ToolError;                          // per-item failure
  }>;
  saved_paths?: string[];                       // state=completed only — the successes
  all_saved?: boolean;                          // state=completed only — every reference saved (vacuously true for none)
  errors?: ToolError[];                         // no-verdict only
}
```

**Verdict discipline**, consistent with the run family and with `mthds_upload_attachments`: once the run has been read, the result is produced (`status: "ok"`), discriminated on `state`; once the per-file walk has run, `all_saved` is the produced discriminator for the walk. **Partial success is a produced verdict, not an error** — the files that landed are on disk and useful, and a sibling's failure must not hide them. `status: "error"` + `errors[]` is reserved for no-verdict conditions: a blank `run_id` or a bad `dir` (`input_domain`), an unknown `run_id` (the results route's 404, `input_domain` at `run_id`), a missing or rejected credential, a paywall (`kind: "paywall"`), an unreachable API or a bare runner without the run lifecycle (`config`), a malformed report (`runtime`), and — fail-closed — a deployment with no working directory to save into (`config`, with a hint naming the workshop and the app's UI; unreachable in practice, since only the workshop registers the tool). Per-item errors classify the resolve leg against `/v1/resolve-storage-url` (a 400/422 or 404 there locates at `artifacts[i].uri`) and the download leg as above, each located at `artifacts[i].uri`.

**Summary.** The saved paths are deliberately repeated in the prose (the `mthds_inputs_template` pattern — they are what the agent must report), with the working directory named once so the paths read as locations, each item's content type and size, and the never-overwrite rule stated. Per-item failures ride here too, since they are not in the top-level `errors[]`. A completed run with nothing to save says so and points back at `mthds_run_results` for the output itself.

**Live coverage.** The hermetic suite fakes the API client and the downloader, but exercises the real filesystem (a temp working directory) and, for the download boundary, a real loopback http server — the cap, the cleanup and the never-overwrite rule are proven on the wire and on disk, not on stubs. A live end-to-end leg needs a completed run that produced a file, which spends inference credit, so it belongs with the run family's paid tier rather than the free suite. First, `narrowImageUrl` accepts nothing but `http(s)` URLs that are image-shaped or carry an `image/*` mime hint — no other scheme reaches the DOM. Second, the view's CSP `resourceDomains` is a tight host allowlist naming exactly the hosted platform's per-env storage buckets (`pipelex-app-{dev,staging,prod}.s3.us-west-2.amazonaws.com`, where run outputs are served as presigned URLs) — never a wildcard; any other host (including a third-party generation-provider URL leaking through `main_stuff`) is refused by the host CSP before a request leaves the browser. These URLs stay view-only: they ride `_meta` and are never surfaced into model context (consistent with the `result_url` rule above). A failed image load — expired presigned URL, CSP-blocked host — falls back to the text preview instead of a broken image.

## Non-Goals

The server must not add Pipelex Hosted API deployment behavior, hand-written OAuth protocol code (the console's handshake is Skybridge's `workosProvider` plus configuration — this repo contributes no token verification, no metadata endpoints, and no DCR handling of its own; see Deployments), blocking execution (`POST /v1/execute` or the SDK's blocking wrappers), run cancellation, resources, logs, package publishing (of MTHDS method packages to a registry — not this server's own npm distribution, which is how the workshop ships; see Deployments), subprocess fallbacks, or a production validation UI. Filesystem access is scoped per deployment: the **hosted console** never reads or writes files (a `{ path }` submission and an `output_dir` are both rejected instructively — see Deployments); the **local workshop** reads exactly the `{ path }` items submitted to it and writes only run artifacts (`mthds_download_artifacts`) and generated trees (`mthds_codegen`'s `output_dir`), within its trust boundaries. The workshop registers no views at launch (tools-first — see Deployments); local view delivery is a later increment gated on self-contained view bundles. `mthds_prepare_inputs` (see Prepare Inputs Scope) now covers turning file-bearing inputs into run-ready `pipelex-storage://` references — on the **local workshop**, from local paths/bytes/`data:` URLs using the user's key. **Console-side byte upload was deferred *conditionally* — "until a proper out-of-band attachment channel exists" — and that condition is now met on exactly one host.** ChatGPT's Apps runtime substitutes a signed attachment URL into a declared tool argument, which is precisely the out-of-band channel the deferral was waiting for: the bytes travel server-to-server and never enter the model's context. `mthds_upload_attachments` takes that channel (see Attachment Ingest Scope). What the deferral still covers, unchanged:

- **`mthds_prepare_inputs` on the console stays pass-through only.** Its contract is untouched: `http(s)` / `pipelex-storage://` accepted, upload-needing values refused. It gains nothing from the attachment channel because ingested attachments arrive at it already as storage URIs.
- **Inline asset bytes in tool arguments remain out of scope on every deployment.** Nothing may return base64 to the model or accept it as an argument — that invariant is what made the original deferral correct and it is unchanged. Per-user auth settles *whose* storage an upload targets; it never settled the context-cost concern.
- **claude.ai and every other console host remain unserved**, because no channel exists there: no file id, no signed URL, no host-injected reference reaches a connector, and MCP has nothing in-spec (SEP-2631 is an open draft that already replaced one predecessor and has landed in no host). Those users keep pasting URLs. Adopting a standard intake when a host ships one will be additive — the `pipelex-storage://` design is already its shape, not a rewrite.
- **The console still never reads a filesystem — and never writes one.** Fetching a host-supplied URL is a *network* read; the `readLocalPath` refusal in Prepare Inputs Scope stands exactly as written. In the other direction, `mthds_download_artifacts` (see Artifact Download Scope) is registered on the local workshop only: the console has no working directory to save a run's files into, and its users download run outputs from the app's UI, so it gets no download tool and no `save_artifacts` option on `mthds_run_results`.
- **Opt-in `http(s)`→storage ingest** for ordinary user-pasted URLs stays parked — an `http(s)` URL at a file position passes through unchanged, and ingesting it is a later, additive SDK feature. The asymmetry with `mthds_upload_attachments` (which does ingest) is deliberate and explained in Attachment Ingest Scope: host attachment URLs expire in minutes, user URLs generally do not.
- **A view-side attach flow** via Skybridge's `useFiles()` / `selectFiles()` is not pursued: the `imageIds` round-trip back to the model is a known-broken path, and the console's views are ChatGPT/Cowork-only. The attachment surface stays tools-first. Method access by selector is in scope (`method_ref` and `method_id` per the Method Selectors table — see Validation Scope, Run Scope, and Inputs Template Scope), server-resolved wherever the platform supports it and expanded via the SDK's `getMethodClosure` on the two build/prepare surfaces the platform deliberately excludes. This does not extend to a dedicated "show me a registered method's graph" surface independent of validation — that belongs to the undecided conducted-views workstream, which is about a different concern (a hosted-connector-conducted scenario where content would cross the model twice); neither selector puts content in the model's context, so they don't bear on that question either way. Catalog listing is now in scope through `mthds_list_methods`; method detail/source retrieval, catalog create/update, a publish/save tool from the workshop, delete, dynamic per-method tool projection, and stored-`input_data` defaulting remain out of scope for this increment. Code generation is in scope through `mthds_codegen` (see Codegen Scope), and only that: no `mthds_resolve` tool (the crate itself is not something a model reads), no `codegen check` tool (the check is offline by design — a workshop agent runs `pipelex codegen check` or the SDK's `runCodegenCheck` directly), no per-pipe kinds until the engine serves them, no JSON Schema target until the engine has one (a cross-repo cascade, not an MCP composition of the per-pipe `build/output` schemas), no reformatting of artifacts, no deletion of orphaned generated files (they are reported and left on disk), no detection or reporting of hand-edits before an overwrite (a stamped file is this tool's, edited or not), and no console view over the artifacts.

Repository quality gates are in scope: ESLint, Prettier, TypeScript type checking, Vitest unit tests, and a combined `npm run check` command should remain available locally.

The prototype should call the Pipelex API (local OSS `pipelex-api` during development) only through `@pipelex/sdk`'s `PipelexApiClient`; it should not expose API internals such as `mthds_contents` or `mthds_sources` in the MCP schema.

## UX Flows

Discover a registered method:

1. When the user asks what saved methods exist, names one without an id, or a saved method may plausibly solve the task, the assistant calls `mthds_list_methods` (with a focused `query` when possible).
2. One strong match supplies its canonical `method_id`; several plausible matches are presented by bounded name/description for the user to choose; no matches are reported without inventing an id.
3. A listed row is never presented as a validation or runnable verdict — the listing carries no such signal. A method whose stored source is missing surfaces that at the point of use, as an `input_domain` no-verdict at `method_id` from by-id validate/template/prepare/run.
4. The chosen id feeds the existing current-content flow: optional `mthds_validate` → `mthds_inputs_template` → fill/prepare inputs → `mthds_run`.

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

Generate typed code for a method:

1. The user asks for types or models for a method in their project, or an assistant building a consumer needs them — a TypeScript app reading run results, a Python service, a Pipelex host.
2. The assistant picks the target from the project (the user's explicit request wins: a TypeScript or JavaScript project wants `ts-zod`, a Python consumer `python-pydantic`, a Pipelex host or `@pipe_func` implementation `python-structures`) and calls `mthds_codegen` with the files (same per-deployment forms as validation), a `method_ref` address, or a `method_id`.
3. **On the local workshop it passes `output_dir`** — a dedicated generated directory such as `src/generated/<method>/`. The tool writes the artifacts and `codegen.lock` there verbatim, reports where each landed and whether the offline check finds the tree current, and returns no file content at all. Regeneration into the same directory overwrites the stamped files it wrote before; a foreign file there refuses the whole write instructively.
4. **Without `output_dir`** — on the hosted console, or when the assistant wants the bytes — the tool returns the stamped artifacts and `codegen.lock`; the assistant writes each artifact at its path and the lock beside them, verbatim, into a dedicated generated directory. `pipelex codegen check` (or the SDK's `runCodegenCheck`) then passes on that tree.
5. On an unresolvable closure the tool returns the validation errors instead; the assistant repairs via the validation flow and retries. A set too large for the response is withheld by whole file (`truncated: true`); the assistant passes `output_dir` on the workshop, or generates locally with the CLI, rather than writing a partial file.

Prepare filled inputs for a run:

1. After filling the `mthds_inputs_template` output, the assistant calls `mthds_prepare_inputs` with the same files (or `method_id`), the pipe, and the filled `inputs`.
2. On the local workshop, file-bearing values (local paths, `data:` URLs, bytes) are uploaded and rewritten to `pipelex-storage://`; `http(s)` / `pipelex-storage://` values pass through unchanged. On the hosted console, only pass-through values are accepted — an upload-needing input is refused instructively (use the workshop, or a URL / storage reference).
3. The assistant passes the prepared `inputs` straight to `mthds_run`. An inputs set that is already all pass-through can skip this step. An unresolvable closure is a no-verdict error; the assistant repairs via the validation flow and retries.

Run a method on a file attached in the chat (hosted console, ChatGPT only):

1. The user drops a PDF (or other asset) into the conversation and asks to run a method on it.
2. The assistant calls `mthds_upload_attachments`, referencing the attached file; ChatGPT's runtime rewrites that reference into the signed-URL object and asks the user to approve sharing it.
3. The console fetches the bytes within the attachment fetch boundary and uploads them to Pipelex storage under the signed-in caller's own identity, returning `pipelex-storage://` URIs — the bytes never enter the conversation.
4. The assistant fills those URIs into the `mthds_inputs_template` output and calls `mthds_run`. `mthds_prepare_inputs` can be skipped: a storage URI is already run-ready.
5. On a host with no attachment channel (claude.ai, and every non-ChatGPT connector), the model has nothing to reference; the tool's fetch boundary refuses a fabricated URL and the hint asks the user for an `http(s)` URL instead.

Run a method durably:

1. The user asks the assistant to run a `.mthds` method (usually after validating it and filling the inputs template).
2. The assistant submits the files (same per-deployment forms as validation), the pipe to run, and the filled inputs to `mthds_run`; the tool returns the durable `run_id` immediately and the `run-follow` view follows the run live.
3. The assistant checks on the run with `mthds_run_status` when asked (honoring the retry hint rather than spin-polling); when the run reaches its terminal outcome the view's completion handoff prompts the assistant, which reports via `mthds_run_results`.
4. Days later, the same `run_id` still answers `mthds_run_status` / `mthds_run_results` — the run is durable and the MCP is stateless.

Save a run's produced files to disk (local workshop only):

1. A completed run's results carry a produced image, PDF or document as content with a `pipelex-storage://` reference beside a presigned `public_url` that expires within the hour. On the workshop, the results summary counts those references and names `mthds_download_artifacts`.
2. The assistant calls `mthds_download_artifacts` with the run id (optionally a `dir` relative to the working directory). The tool walks the run's full output, resolves each reference to a fresh link through the API, and saves the files under the working directory — never overwriting, suffixing on collision.
3. The assistant reports the saved paths. Days later, the same call with the same run id still works; no presigned link is ever the thing the user has to catch in time.
4. On the hosted console there is no such tool: the user downloads run outputs from the app's UI.

Run a registered method by reference:

1. The user names a registered method. If no catalog id (`mt_…`) is supplied, the assistant resolves it in-band with `mthds_list_methods` and disambiguates by name/description when necessary.
2. The assistant may first call `mthds_validate` with `method_id` (no files) to confirm the stored method's current content still validates — e.g. after a suspected edit — getting the same structured verdict and dry-run graph view as a files-based call, with no bundle entering the conversation.
3. The assistant calls `mthds_inputs_template` with `method_id` (no files) and fills the returned template with user data.
4. The assistant calls `mthds_run` with `method_id` and the filled `inputs` — no bundle ever enters the conversation, and the run executes the method's current stored content.
5. Everything downstream is unchanged: the `run-follow` view, `mthds_run_status`, and `mthds_run_results` operate on the durable `run_id` and don't care how the run started.

Run a published method by address:

1. The user pastes or names a method address — `github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g. `github.com/Pipelex/methods/documents@v0.1.0`. Nothing needs discovering: the address is the reference, no catalog and no id.
2. The assistant calls `mthds_inputs_template` with `method_ref` (no files) and fills the returned template with user data. It may first call `mthds_validate` with `method_ref` for a structured verdict and the dry-run graph view — the server fetches the package either way, so no bundle enters the conversation.
3. The assistant calls `mthds_run` with `method_ref` and the filled `inputs`. The start ack carries `method_provenance` — the address, the tag, and the commit SHA that was actually fetched — which the assistant can report so the run stays explainable if the tag later moves.
4. Everything downstream is unchanged: the `run-follow` view, `mthds_run_status`, and `mthds_run_results` operate on the durable `run_id`.

## Tools and Views

**Server instructions**: The server sets a short MCP `instructions` string (server-wide, on the `McpServer` constructor options) that hosts surface to the model. It states that `mthds_list_methods` resolves a saved method name or plausible task fit to a canonical id before the existing validate/template/run flow; that the server validates `.mthds` method files (returning an interactive dry-run graph on a valid verdict), projects a method's declared inputs as a fill-in template, generates typed code for a method's concepts (TypeScript or Python, the target chosen from the project's context, written verbatim with its lock), prepares filled inputs for a run (uploading file-bearing values to storage on the local workshop), and runs methods durably on the hosted Pipelex API (start from files, from a published method's `github.com/...` address, or from a registered method's catalog id, then check status and fetch results by durable run id). The instructions do not embed a dynamic catalog because hosted auth is request-scoped and host instructions may be cached. Each shell's instructions additionally name its own per-shell tool and not the other's: the hosted console's state that a file the user attached in the chat can be turned into a run-ready storage reference with `mthds_upload_attachments`; the workshop's state that a completed run's stored files can be saved under the working directory with `mthds_download_artifacts`. It is a server-level hint only — argument-level detail stays in the tool `description`.

**Tool: `mthds_list_methods`**

- **Input**: `{ query?, limit?, cursor? }` — trimmed case-insensitive search applied server-side, bounded page size, opaque continuation cursor (see Catalog Discovery Scope)
- **Output**: `{ status, returned_count?, next_cursor?, methods?, errors? }` in `structuredContent`, plus a bounded text summary that opens with a render directive (report each method with its name **and** description) and then repeats names, descriptions, ids, and cursor guidance. No method source, stored inputs/outputs, org/user ids, `_meta`, or view payload.
- **Behavior**: Asks the platform for one page of the active key's organization catalog through the SDK, immediately validates and projects the rows it returns, and treats empty catalogs and no-match queries as success. Listing executes nothing; a returned id can be passed to `mthds_validate`, `mthds_inputs_template`, and `mthds_run`.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — bounded catalog metadata is read directly by the model.

**Tool: `mthds_validate`**

- **Input**: `{ files?, method_ref?, method_id?, include_graph? }` — exactly one of `files` / `method_ref` / `method_id` (see Method Selectors and Validation Scope)
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, available_view_specs, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. On a positive verdict the graph rides the view-only `_meta` channel (`_meta.graph_spec`), and on a runnable one the form's artifact pair joins it (`_meta.pipe_io_contracts`, `_meta.input_form`, `_meta.main_pipe_ref`), never `structuredContent`; `available_view_specs` tells the model which of the `"dry_run_graph"` and `"input_form"` views are available to surface.
- **Behavior**: Validates request shape, calls the Pipelex API against `PIPELEX_BASE_URL` or `https://api.pipelex.com` with signatures and markdown enabled, and maps produced validation verdicts into flattened structured content. A `method_ref` or `method_id` is a server pass-through on `POST /v1/validate` itself — the runner resolves the address, the hosted platform resolves the id; nothing is expanded client-side.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: `run-graph` — renders `_meta.graph_spec` with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle) and, on a runnable verdict, the main pipe's input form below it with `RunPanel` over `_meta.input_form` and `_meta.pipe_io_contracts` (Run starts `mthds_run` from the view with the validation's own selector and follows it; see UI Overview for the spike's boundaries); compact empty state when there is neither. Works identically whichever selector supplied the validated content.

**Tool: `mthds_inputs_template`**

- **Input**: `{ files?, method_ref?, method_id?, pipe_ref?, explicit?, format? }` — exactly one of `files` / `method_ref` / `method_id` (see Method Selectors and Inputs Template Scope)
- **Output**: `{ status, is_valid, pipe_ref?, format?, explicit?, inputs?, inputs_toml?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that includes the template in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/build/inputs` against `PIPELEX_BASE_URL` or `https://api.pipelex.com` (adapting `uri` → `source`), and maps the produced verdict into flattened structured content with the same `status`/`is_valid` discipline as `mthds_validate`. A `method_ref` is a server pass-through on the build route itself; with `method_id`, the SDK's `getMethodClosure` expands the stored method's closure, which is forwarded to the build route (the build routes take no `method_id` — see Method Selectors).
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — the template is small structured data the model reads directly.

**Tool: `mthds_codegen`**

- **Input**: `{ files?, method_ref?, method_id?, target, output_dir? }` — exactly one of `files` / `method_ref` / `method_id`, plus the required `target` and, on the local workshop only, an optional `output_dir` (see Method Selectors and Codegen Scope)
- **Output**: `{ status, is_valid, target?, kind?, crate_fingerprint?, engine_version?, artifacts?, lock?, truncated?, output_dir?, is_current?, orphans?, orphans_truncated?, drifts?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. Without `output_dir` the summary repeats every artifact and the lock in fenced blocks tagged for their language; on the written arm it carries no content and no fenced blocks, only where the files landed and the check verdict. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/codegen` with `kind: "types"` and the requested `target` (never a `pipe_ref`), and projects the produced verdict with the same `status`/`is_valid` discipline as `mthds_inputs_template`. Every selector is a server pass-through — the runner resolves an address, the hosted platform resolves an id. Every valid response is preflighted through the SDK's `runCodegenCheck` on both shells before it is written or relayed. Without `output_dir`, artifacts and the lock ride the response verbatim, bounded by whole file with the lock's bytes reserved first. With `output_dir` (workshop only), the tree is written to disk — stamped files overwritten, anything else refusing the whole write — and content is withheld from every stream.
- **Annotations**: NOT read-only (`readOnlyHint: false` — it writes on the workshop) and **destructive** (`destructiveHint: true`) — regeneration overwrites the stamped files it wrote before and discards hand-edits below the stamp, which is a destructive update rather than an additive one, and this is the hint a host reads to decide whether to confirm before calling. No open-world publishing. Both shells advertise the annotations and the argument; the console refuses `output_dir` instructively, as it refuses `files: { path }`. Contrast `mthds_download_artifacts`, which stays non-destructive because it never overwrites.
- **View**: none — decided out; the fenced blocks in the summary serve the copy-out case on every host.

**Tool: `mthds_prepare_inputs`**

- **Input**: `{ files?, method_id?, pipe_ref?, inputs }` — exactly one of `files` / `method_id` (no `method_ref` — see Method Selectors), plus the filled `inputs` (see Prepare Inputs Scope)
- **Output**: `{ status, is_valid, pipe_ref?, inputs?, uploads?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that repeats the prepared `inputs` in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Resolves the pipe's declared signature, uploads file-bearing input values to Pipelex storage, and rewrites them to `pipelex-storage://` (wrapping `@pipelex/sdk`'s `prepareInputs`); `http(s)` / `pipelex-storage://` values pass through unchanged. With `method_id`, the SDK's `getMethodClosure` expands the stored method's closure first. Per-deployment asset boundary: the local workshop uploads with the user's key; the hosted console is pass-through only and refuses upload-needing inputs instructively (it never reads a filesystem or uploads). An unresolvable closure is a no-verdict error (the SDK throws without a structured verdict).
- **Annotations**: NOT read-only (`readOnlyHint: false` — it uploads on the workshop), non-destructive, no open-world publishing.
- **View**: none — the prepared inputs are small structured data the model reads directly.

**Tool: `mthds_upload_attachments`** — hosted console only (see Deployments)

- **Input**: `{ attachments }` — a required array of the mandated four-field host attachment object `{ download_url, file_id, mime_type?, file_name? }` (see Attachment Ingest Scope). The shape is fixed by OpenAI's app review *and* by the host's runtime substitution gate; it is not ours to loosen.
- **Output**: `{ status, is_valid, attachments?, uploads?, errors? }` in `structuredContent`, plus a text summary listing each attachment's filename and resulting `pipelex-storage://` URI (the payload the model must carry into the inputs template, deliberately repeated in the prose). No `_meta`, no `available_view_specs`.
- **Behavior**: For each attachment, fetches the bytes from the signed URL within the attachment fetch boundary (https-only, OpenAI host-pattern allowlist, no redirects, 7 MiB cap enforced before the body is read, bounded timeout, no credentials forwarded), then uploads them to Pipelex storage with the signed-in caller's own credential via `@pipelex/sdk`'s `uploadFile`, returning the `pipelex-storage://` URI. Never reads a filesystem. Partial success is a produced verdict: successful uploads are returned alongside per-item failures.
- **Annotations**: NOT read-only (`readOnlyHint: false` — it uploads), non-destructive, and **`openWorldHint: true`** — the first tool in this server to set it, because it fetches an arbitrary host-supplied URL rather than only talking to the configured Pipelex API.
- **Host metadata**: the hosted shell registers it with `_meta["openai/fileParams"]: ["attachments"]`, which is what makes the host substitute the user's attachment into that argument, plus the usual `openai/toolInvocation` strings.
- **View**: none — the returned URIs are small structured data the model reads directly.

**Tool: `mthds_run`**

- **Input**: `{ files?, method_ref?, method_id?, pipe_code?, inputs? }` — at least one run source; `method_ref` pairs with nothing, `files` + `method_id` is legal (see Method Selectors and Run Scope)
- **Output**: `{ status, run_id?, run_status?, created_at?, method_provenance?, available_view_specs, errors? }` in `structuredContent`, plus a start-ack text summary in MCP `content` with the run id and follow-up etiquette (and the resolved provenance on a `method_ref` run).
- **Behavior**: Validates request shape, then starts a durable run via `POST /v1/start` (fire-and-forget 202) — from inline files, from a published method's address by `method_ref` (server-resolved at the tag, provenance returned), or from a registered method's current stored content by `method_id` (files win when both are supplied; the id then rides as run-history linkage — see Run Scope). Never blocks on the result.
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

**Tool: `mthds_download_artifacts`** — local workshop only (see Deployments)

- **Input**: `{ run_id, dir? }` — the durable run id, and optionally a directory relative to the server's working directory to save into (see Artifact Download Scope).
- **Output**: `{ status, run_id?, state?, retry_after_seconds?, run_status?, failure_message?, artifacts?, saved_paths?, all_saved?, errors? }` in `structuredContent`, plus a text summary that repeats the saved paths (relative to the working directory, which it names once) and any per-file failure. No `_meta`, no `available_view_specs`.
- **Behavior**: Reads the run (`GET /v1/runs/{id}/results`) and branches on its state like `mthds_run_results`; on `completed`, finds every `pipelex-storage://` reference in the full output, resolves each to a fresh presigned link through `POST /v1/resolve-storage-url`, and streams the bytes into a file under the working directory within the download boundary (http(s) only, no redirects, bounded timeout and byte cap, no partial file left behind). Filenames are sanitized from the storage key and never overwrite an existing file; the directory is real-path-contained on both sides of `mkdir`. Partial success is a produced verdict.
- **Annotations**: NOT read-only (`readOnlyHint: false` — it writes files), non-destructive (it never overwrites), no open-world publishing (it fetches only links the configured Pipelex API minted).
- **View**: none — the saved paths are small structured data the model reports directly.
