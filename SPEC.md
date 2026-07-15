# Pipelex MCP

## Value Proposition

Pipelex MCP lets developers and coding agents validate MTHDS content and project a method's declared inputs from inside an MCP host while they are authoring, repairing, or preparing to run `.mthds` files.

Target users are Pipelex/MTHDS developers working with an AI assistant in a local development loop. Today, validation requires leaving the assistant flow, knowing the local OSS `pipelex-api` or SDK details, and manually mapping diagnostics back to file content. The first product slice is intentionally narrow: validate submitted MTHDS file contents and return structured results the assistant can use to fix issues.

Core actions:

- Validate one or more submitted MTHDS files.
- Return valid, invalid, pending-signature, and no-verdict failure states in a stable structured result.
- Return optional graph data when requested and available.
- Project a pipe's declared inputs as a fill-in template (`mthds_inputs`), so an assistant can prepare inputs for a run without leaving the conversation. This unblocks the CLI-free skills in `../pipelex-plugins` (`pipelex-inputs`, `pipelex-design`) that used to shell out to `mthds-agent inputs bundle`.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.

**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.

**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to local OSS `pipelex-api`, or structured verdicts such as pending signatures, validation errors, and graph specs. It also cannot resolve a pipe's effective input contract (needs of the pipe minus what upstream pipes produce) — that projection is computed by the API from the parsed closure.

## UI Overview

`mthds_validate` ships a Skybridge view, `run-graph`: on a positive verdict that carries a `graph_spec`, a Skybridge-capable host renders an interactive method graph (via `@pipelex/mthds-ui`'s `GraphViewer`) inline above the model response, with a user-triggered fullscreen toggle for exploration. Invalid verdicts, pending-signature verdicts with no graph, and `include_graph: false` calls fall back to a compact, non-crashing empty state. The shared surface is the assistant conversation, the structured tool result, and this view.

**First view**: The MCP host lists the Pipelex tools: `mthds_validate` and `mthds_inputs`. Only `mthds_validate` carries a Skybridge view; `mthds_inputs` is a plain tool whose template is small structured data the model reads directly.

**Validation flow**:

1. The assistant submits `files: [{ content, uri? }]` to `mthds_validate`.
2. The MCP server validates request shape and provenance.
3. The capability calls the Pipelex API (`POST /v1/validate`) through `@pipelex/sdk`'s `PipelexApiClient`.
4. The result is projected into stable MCP `structuredContent` plus a text summary.

**End states**:

- Valid runnable bundle: `is_valid=true`, `is_runnable=true`, optional graph spec.
- Valid pending-signature bundle: `is_valid=true`, `is_runnable=false`, populated pending signatures.
- Invalid produced verdict: `status="ok"`, `is_valid=false`, populated validation errors.
- No-verdict failure: `status="error"` with an error class of `input_domain`, `config`, or `runtime`.

**Inputs template flow**:

1. The assistant submits `files: [{ content, uri? }]` (and optionally `pipe_ref`, `explicit`, `format`) to `mthds_inputs`.
2. The MCP server validates request shape and provenance.
3. The capability calls the Pipelex API (`POST /v1/build/inputs`) through `@pipelex/sdk`'s `PipelexApiClient`, adapting the `uri` provenance label to the build envelope's `source` field.
4. The result is projected into stable MCP `structuredContent` plus a text summary that includes the template itself in a fenced code block.

**End states**:

- Template produced: `is_valid=true`, resolved `pipe_ref`, template in `inputs` (json) or `inputs_toml` (toml).
- Unresolvable closure: `status="ok"`, `is_valid=false`, populated validation errors (the API's 200 verdict discipline — same as validation).
- No-verdict failure: `status="error"` with an error class of `input_domain`, `config`, or `runtime`. An unknown `pipe_ref` or a closure with no resolvable `main_pipe` (none declared, or several across domains) is a no-verdict error — the API rejects the request (422) rather than producing a verdict.

The richer error-grouping validation view (diagnostics grouped by class, clickable file/line locations, pending-signatures backlog) is a later increment; the `run-graph` view ships graph rendering only.

## Product Context

- **Existing products**: Pipelex, MTHDS, `@pipelex/sdk`, and the Pipelex API (local OSS `pipelex-api` during development).
- **App shell**: `pipelex-mcp`, a Skybridge MCP app scaffold.
- **Runtime API**: the hosted Pipelex API, defaulting to `https://api.pipelex.com` (point `PIPELEX_BASE_URL` at a local OSS `pipelex-api` on `http://localhost:8081` during development).
- **SDK dependency**: the `@pipelex/sdk` npm package (`PipelexApiClient`, published from `../pipelex-sdk-js`). It re-exports the `mthds/protocol` surface, so the MCP imports one SDK and still reaches the open protocol routes; `mthds` rides along as a transitive dependency.
- **Auth**: optional `PIPELEX_API_KEY`; local development normally runs without hosted auth.
- **Primary environment variable**: `PIPELEX_BASE_URL`, defaulting to `https://api.pipelex.com`.

## Validation Scope (`mthds_validate`)

The public MCP input shape is:

```ts
{
  files: Array<{
    content: string;
    uri?: string | null;
  }>;
  include_graph?: boolean;
}
```

`include_graph` defaults to true. The graph rides the tool result's view-only `_meta` channel (`_meta.graph_spec`, consumed by the `run-graph` view), never `structuredContent`. When false, omit it entirely.

The capability always permits pending signatures and always requests rendered markdown from local OSS `pipelex-api`.

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
  }>;
}
```

The graph (`graph_spec`) is not part of `structuredContent`; on a positive verdict it rides the tool result's view-only `_meta` channel (`_meta.graph_spec`) for the `run-graph` view, so the model never pays its tokens. Because the model never sees `_meta`, `available_view_specs` is its signal that a view exists to surface: it lists the renderable view kinds for this result. The only kind for now is `"dry_run_graph"` — the method graph from the validation dry run, whose spec rides `_meta.graph_spec`. It contains `"dry_run_graph"` exactly when that spec was produced (valid verdict with `include_graph` not false), and is empty otherwise. On those same verdicts a short `## Views` note is appended to the `content` summary so agents that read the prose more reliably than the structured fields also learn the view exists.

The MCP `content` text contains the human-readable summary. The summary is not duplicated in structured output.

## Inputs Template Scope (`mthds_inputs`)

`mthds_inputs` projects a pipe's declared inputs as a fill-in template, wrapping `POST /v1/build/inputs` through `@pipelex/sdk`'s `buildInputs`. It is a plain tool: no Skybridge view, no `_meta` channel, no `available_view_specs` field — the template is small structured data the model must read, so it belongs in `structuredContent`.

The public MCP input shape is:

```ts
{
  files: Array<{
    content: string;
    uri?: string | null;
  }>;
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}
```

- `files` mirrors `mthds_validate`'s shape for consistency. The SDK's build envelope spells the provenance label `source` (`MthdsFileItem`), so the capability adapts `uri` → `source` at its boundary, the way validate adapts to `/v1/validate`'s parallel arrays.
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
  }>;
}
```

Verdict discipline is identical to `mthds_validate`: any *produced* verdict is `status: "ok"`, discriminated on `is_valid`. On the valid arm the tool returns the resolved `pipe_ref` (always qualified), the echoed `format`/`explicit`, and the template on exactly one of `inputs` / `inputs_toml` (chosen by `format`; the unused field is absent). An unresolvable closure is a produced verdict: `is_valid: false` with `validation_errors[]` — the route answers 200 and consumers branch on the field, never on transport. `status: "error"` + `errors[]` is reserved for no-verdict conditions: bad request shape (`input_domain`), unreachable/misconfigured API or auth failure (`config`), unknown `pipe_ref` / unresolvable `main_pipe` default (API 422 → `input_domain`), or server faults (`runtime`) — classified by the same `classifyError` the validation capability uses.

The build routes return a plain `message` rather than `rendered_markdown`, so the capability composes its own `content` summary: the resolved pipe, the API message, and the template itself in a fenced code block (` ```json ` or ` ```toml ` to match `format`). Unlike validation, the template is deliberately duplicated between `structuredContent` and the summary — it is the payload the model must read, and some hosts read prose more reliably than structured fields.

## Non-Goals

The server must not add Pipelex Hosted API deployment behavior, bearer-token extraction, run execution, status polling, resources, logs, package publishing, MCP-side filesystem reads, subprocess fallbacks, or a production validation UI.

Repository quality gates are in scope: ESLint, Prettier, TypeScript type checking, Vitest unit tests, and a combined `npm run check` command should remain available locally.

The prototype should call the Pipelex API (local OSS `pipelex-api` during development) only through `@pipelex/sdk`'s `PipelexApiClient`; it should not expose API internals such as `mthds_contents` or `mthds_sources` in the MCP schema.

## UX Flows

Validate MTHDS files:

1. The user asks the assistant to validate one or more `.mthds` files.
2. The assistant submits the file contents and optional provenance URIs to `mthds_validate`.
3. The tool returns structured validation facts plus a text summary that the assistant can use to repair the files.
4. The assistant may repeat the same flow after editing the submitted source content.

Prepare inputs for a method:

1. The user asks the assistant to prepare inputs for a `.mthds` method (or a skill needs the method's input schema).
2. The assistant submits the file contents (and optionally a qualified `pipe_ref`) to `mthds_inputs`.
3. The tool returns the fill-in template plus the resolved pipe, which the assistant fills with user data, synthetic data, or placeholders.
4. On an invalid closure, the tool returns the validation errors instead; the assistant can repair via the validation flow and retry.

## Tools and Views

**Server instructions**: The server sets a short MCP `instructions` string (server-wide, on the `McpServer` constructor options) that hosts surface to the model. It states that the server validates `.mthds` method files (returning an interactive dry-run graph on a valid verdict) and projects a method's declared inputs as a fill-in template. It is a server-level hint only — argument-level detail stays in the tool `description`.

**Tool: `mthds_validate`**

- **Input**: `{ files, include_graph? }`
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, available_view_specs, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. On a positive verdict the graph rides the view-only `_meta` channel (`_meta.graph_spec`), never `structuredContent`; `available_view_specs` tells the model the `"dry_run_graph"` view is available to surface.
- **Behavior**: Validates request shape, calls the Pipelex API against `PIPELEX_BASE_URL` or `https://api.pipelex.com` with signatures and markdown enabled, and maps produced validation verdicts into flattened structured content.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: `run-graph` — renders `_meta.graph_spec` with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle); compact empty state when there is no graph.

**Tool: `mthds_inputs`**

- **Input**: `{ files, pipe_ref?, explicit?, format? }`
- **Output**: `{ status, is_valid, pipe_ref?, format?, explicit?, inputs?, inputs_toml?, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content` that includes the template in a fenced code block. No `_meta`, no `available_view_specs`.
- **Behavior**: Validates request shape, calls `POST /v1/build/inputs` against `PIPELEX_BASE_URL` or `https://api.pipelex.com` (adapting `uri` → `source`), and maps the produced verdict into flattened structured content with the same `status`/`is_valid` discipline as `mthds_validate`.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: none — the template is small structured data the model reads directly.
