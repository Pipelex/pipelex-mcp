# Pipelex MCP

## Value Proposition

Pipelex MCP lets developers and coding agents validate MTHDS content from inside an MCP host while they are authoring or repairing `.mthds` files.

Target users are Pipelex/MTHDS developers working with an AI assistant in a local development loop. Today, validation requires leaving the assistant flow, knowing the local API or SDK details, and manually mapping diagnostics back to file content. The first product slice is intentionally narrow: validate submitted MTHDS file contents and return structured results the assistant can use to fix issues.

Core actions for v0.1:

- Validate one or more submitted MTHDS files.
- Return valid, invalid, pending-signature, and no-verdict failure states in a stable envelope.
- Return optional graph and markdown artifacts when the local API provides them.

## Why LLM?

**Conversational win**: The user can say "validate this method" while the assistant already has the relevant file contents and can immediately iterate on fixes.

**LLM adds**: The assistant can choose the files to submit, explain validation results, modify source content, and repeat validation until the bundle is usable.

**What LLM lacks**: The assistant does not have Pipelex validation semantics, access to the local `pipelex-api`, or structured verdicts such as pending signatures, pipe IO contracts, validation errors, graph specs, or rendered markdown.

## UI Overview

v0.1 is a tool-only MCP experience with no custom Skybridge view. The shared surface is the assistant conversation plus the structured tool result.

**First view**: The MCP host lists a single useful Pipelex tool, `mthds_validate`.

**Validation flow**:

1. The assistant submits `files: [{ content, uri? }]` to `mthds_validate`.
2. The MCP server validates request shape and provenance.
3. The capability calls `mthds-js` and the local `pipelex-api`.
4. The result is projected into a stable MCP envelope.

**End states**:

- Valid runnable bundle: `is_valid=true`, `is_runnable=true`, pipe IO contracts, optional graph spec, optional rendered markdown.
- Valid pending-signature bundle: `is_valid=true`, `is_runnable=false`, populated pending signatures.
- Invalid produced verdict: `status="ok"`, `is_valid=false`, populated validation errors.
- No-verdict failure: `status="error"` with an error class of `input_domain`, `config`, or `runtime`.

v0.2 may add a Skybridge validation view that groups diagnostics and renders `graph_spec`, but v0.1 should not block on visual graph rendering.

## Product Context

- **Existing products**: Pipelex, MTHDS, `mthds-js`, and local `pipelex-api`.
- **App shell**: `pipelex-mcp`, a Skybridge MCP app scaffold.
- **Runtime API**: local `pipelex-api`, defaulting to `http://localhost:8081`.
- **SDK dependency**: `mthds` from the sibling `../mthds-js` package during the local prototype.
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
  bundle_uri?: string | null;
  allow_signatures?: boolean;
  include_graph?: boolean;
  render_markdown?: boolean;
}
```

`bundle_uri` is provenance only in v0.1. If supplied, it must match one submitted file `uri`; the local `/v1/validate` endpoint does not select an entry file.

`include_graph` defaults to true. When false, omit `graph_spec` from returned `data`.

`render_markdown` maps to API render option `["markdown"]`.

The v0.1 output envelope is:

```ts
{
  status: "ok" | "error";
  summary: string;
  data?: {
    is_valid: boolean;
    is_runnable: boolean;
    pending_signatures: string[];
    validation_errors?: unknown[];
    pipe_io_contracts?: Record<string, unknown>;
    graph_spec?: unknown;
    rendered_markdown?: string;
  };
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    location?: string;
    message: string;
    hint?: string;
  }>;
}
```

## Non-Goals

v0.1 must not add hosted deployment behavior, bearer-token extraction, run execution, status polling, resources, logs, linting, formatting, package publishing, MCP-side filesystem reads, subprocess fallbacks, or a production validation UI.

The prototype should call only the local API through `mthds-js`; it should not expose API internals such as `mthds_contents` or `mthds_sources` in the MCP schema.

## UX Flows

Validate MTHDS files:

1. The user asks the assistant to validate one or more `.mthds` files.
2. The assistant submits the file contents and optional provenance URIs to `mthds_validate`.
3. The tool returns a stable validation envelope that the assistant can summarize and use to repair the files.
4. The assistant may repeat the same flow after editing the submitted source content.

## Tools and Views

**Tool: `mthds_validate`**

- **Input**: `{ files, bundle_uri?, allow_signatures?, include_graph?, render_markdown? }`
- **Output**: `{ status, summary, data?, errors? }`
- **Behavior**: Validates request provenance, calls `mthds-js` against `MTHDS_API_URL` or `http://localhost:8081`, and maps produced validation verdicts into the v0.1 envelope.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: None for v0.1.
