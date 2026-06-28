# Pipelex MCP

## Value Proposition

Pipelex MCP lets developers and coding agents validate MTHDS content from inside an MCP host while they are authoring or repairing `.mthds` files.

Target users are Pipelex/MTHDS developers working with an AI assistant in a local development loop. Today, validation requires leaving the assistant flow, knowing the local OSS `pipelex-api` or SDK details, and manually mapping diagnostics back to file content. The first product slice is intentionally narrow: validate submitted MTHDS file contents and return structured results the assistant can use to fix issues.

Core actions for v0.1:

- Validate one or more submitted MTHDS files.
- Return valid, invalid, pending-signature, and no-verdict failure states in a stable structured result.
- Return optional graph data when requested and available.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.

**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.

**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to local OSS `pipelex-api`, or structured verdicts such as pending signatures, validation errors, and graph specs.

## UI Overview

`mthds_validate` ships a Skybridge view, `validation-graph`: on a positive verdict that carries a `graph_spec`, a Skybridge-capable host renders an interactive method graph (via `@pipelex/mthds-ui`'s `GraphViewer`) inline above the model response, with a user-triggered fullscreen toggle for exploration. Invalid verdicts, pending-signature verdicts with no graph, and `include_graph: false` calls fall back to a compact, non-crashing empty state. The shared surface is the assistant conversation, the structured tool result, and this view.

**First view**: The MCP host lists a single useful Pipelex tool, `mthds_validate`.

**Validation flow**:

1. The assistant submits `files: [{ content, uri? }]` to `mthds_validate`.
2. The MCP server validates request shape and provenance.
3. The capability calls `mthds-js` and local OSS `pipelex-api`.
4. The result is projected into stable MCP `structuredContent` plus a text summary.

**End states**:

- Valid runnable bundle: `is_valid=true`, `is_runnable=true`, optional graph spec.
- Valid pending-signature bundle: `is_valid=true`, `is_runnable=false`, populated pending signatures.
- Invalid produced verdict: `status="ok"`, `is_valid=false`, populated validation errors.
- No-verdict failure: `status="error"` with an error class of `input_domain`, `config`, or `runtime`.

The richer error-grouping validation view (diagnostics grouped by class, clickable file/line locations, pending-signatures backlog) is a later increment; the `validation-graph` view ships graph rendering only.

## Product Context

- **Existing products**: Pipelex, MTHDS, `mthds-js`, and local OSS `pipelex-api`.
- **App shell**: `pipelex-mcp`, a Skybridge MCP app scaffold.
- **Runtime API**: local OSS `pipelex-api`, defaulting to `http://localhost:8081`.
- **SDK dependency**: the `@pipelex/sdk` npm package (`PipelexApiClient`, published from `../pipelex-sdk-js`). It re-exports the `mthds/protocol` surface, so the MCP imports one SDK and still reaches the open protocol routes; `mthds` rides along as a transitive dependency.
- **Auth**: optional `MTHDS_API_KEY`; local development normally runs without hosted auth.
- **Primary environment variable**: `MTHDS_API_URL`, defaulting to `http://localhost:8081`.

## v0.1 Scope

Implement exactly one Pipelex capability: `mthds_validate`.

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

`include_graph` defaults to true. The graph rides the tool result's view-only `_meta` channel (`_meta.graph_spec`, consumed by the `validation-graph` view), never `structuredContent`. When false, omit it entirely.

The capability always permits pending signatures and always requests rendered markdown from local OSS `pipelex-api`.

The v0.1 structured output is:

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

The graph (`graph_spec`) is not part of `structuredContent`; on a positive verdict it rides the tool result's view-only `_meta` channel (`_meta.graph_spec`) for the `validation-graph` view, so the model never pays its tokens. Because the model never sees `_meta`, `available_view_specs` is its signal that a view exists to surface: it lists the renderable view kinds for this result. The only kind for now is `"dry_run_graph"` — the method graph from the validation dry run, whose spec rides `_meta.graph_spec`. It contains `"dry_run_graph"` exactly when that spec was produced (valid verdict with `include_graph` not false), and is empty otherwise. On those same verdicts a short `## Views` note is appended to the `content` summary so agents that read the prose more reliably than the structured fields also learn the view exists.

The MCP `content` text contains the human-readable summary. The summary is not duplicated in structured output.

## Non-Goals

v0.1 must not add Pipelex Hosted API deployment behavior, bearer-token extraction, run execution, status polling, resources, logs, package publishing, MCP-side filesystem reads, subprocess fallbacks, or a production validation UI.

Repository quality gates are in scope for v0.1 development: ESLint, Prettier, TypeScript type checking, Vitest unit tests, and a combined `npm run check` command should remain available locally.

The prototype should call only local OSS `pipelex-api` through `mthds-js`; it should not expose API internals such as `mthds_contents` or `mthds_sources` in the MCP schema.

## UX Flows

Validate MTHDS files:

1. The user asks the assistant to validate one or more `.mthds` files.
2. The assistant submits the file contents and optional provenance URIs to `mthds_validate`.
3. The tool returns structured validation facts plus a text summary that the assistant can use to repair the files.
4. The assistant may repeat the same flow after editing the submitted source content.

## Tools and Views

**Tool: `mthds_validate`**

- **Input**: `{ files, include_graph? }`
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, available_view_specs, validation_errors?, errors? }` in `structuredContent`, plus a text summary in MCP `content`. On a positive verdict the graph rides the view-only `_meta` channel (`_meta.graph_spec`), never `structuredContent`; `available_view_specs` tells the model the `"dry_run_graph"` view is available to surface.
- **Behavior**: Validates request shape, calls the Pipelex API against `MTHDS_API_URL` or `http://localhost:8081` with signatures and markdown enabled, and maps produced validation verdicts into flattened structured content.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: `validation-graph` — renders `_meta.graph_spec` with `@pipelex/mthds-ui`'s `GraphViewer` (inline preview plus a user-triggered fullscreen toggle); compact empty state when there is no graph.
