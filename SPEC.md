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

v0.1 is a tool-only MCP experience with no custom Skybridge view. The shared surface is the assistant conversation plus the structured tool result.

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

v0.2 may add a Skybridge validation view that groups diagnostics and renders `graph_spec`, but v0.1 should not block on visual graph rendering.

## Product Context

- **Existing products**: Pipelex, MTHDS, `mthds-js`, and local OSS `pipelex-api`.
- **App shell**: `pipelex-mcp`, a Skybridge MCP app scaffold.
- **Runtime API**: local OSS `pipelex-api`, defaulting to `http://localhost:8081`.
- **SDK dependency**: the `mthds` npm package (published from `../mthds-js`).
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

`include_graph` defaults to true. When false, omit `graph_spec` from returned `structuredContent`.

The capability always permits pending signatures and always requests rendered markdown from local OSS `pipelex-api`.

The v0.1 structured output is:

```ts
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  validation_errors?: unknown[];
  graph_spec?: unknown;
  errors?: Array<{
    class: "input_domain" | "config" | "runtime";
    location?: string;
    message: string;
    hint?: string;
  }>;
}
```

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
- **Output**: `{ status, is_valid, is_runnable, pending_signatures, validation_errors?, graph_spec?, errors? }` in `structuredContent`, plus a text summary in MCP `content`.
- **Behavior**: Validates request shape, calls `mthds-js` against `MTHDS_API_URL` or `http://localhost:8081` with signatures and markdown enabled, and maps produced validation verdicts into flattened v0.1 structured content.
- **Annotations**: Read-only, non-destructive, no open-world publishing.
- **View**: None for v0.1.
