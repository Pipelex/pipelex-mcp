# Pipelex MCP

Pipelex MCP exposes local MTHDS validation to MCP hosts through a Skybridge
server.

It registers one MCP tool, `mthds_validate`, which accepts submitted `.mthds`
file contents and returns a stable validation result the assistant can use to
explain and repair diagnostics. On a positive verdict, the tool's
`validation-graph` Skybridge view renders the method graph interactively with
`@pipelex/mthds-ui`'s `GraphViewer`.

## Tool

`mthds_validate`

Input:

```ts
{
  files: Array<{ content: string; uri?: string | null }>;
  include_graph?: boolean;
}
```

Output:

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

The MCP `content` text contains the human-readable summary; it is not duplicated
inside `structuredContent`. The graph (`graph_spec`) is delivered on the tool
result's view-only `_meta` channel (`_meta.graph_spec`) for the
`validation-graph` view — never in `structuredContent`, so the model never pays
its tokens. Since the model never sees `_meta`, `available_view_specs` is how it
learns a view exists to surface: it lists the renderable view kinds for this
result. The only kind for now is `"dry_run_graph"` (the method graph from the
validation dry run, whose spec rides `_meta.graph_spec`), present exactly when
that spec was produced and empty otherwise. On those verdicts a short `## Views`
note is also appended to the summary as a prose signal of the same.

## Local Development

During early development, this repo supports the local OSS `pipelex-api` runner
so the MCP can be exercised before the Pipelex Hosted API path is fully wired.
That local runner support is temporary: the intended production target is the
Pipelex Hosted API only.

Prerequisites:

- Node.js 24+
- A local OSS `pipelex-api` serving `POST /v1/validate`

Install dependencies:

```bash
npm install
```

Start local OSS `pipelex-api` separately, then run the Skybridge dev server:

```bash
cd ../pipelex-api
make run
```

Local OSS `pipelex-api` should answer at `http://localhost:8081`. In another terminal,
start the MCP server:

```bash
MTHDS_API_URL=http://localhost:8081 npm run dev
```

`MTHDS_API_URL` defaults to `http://localhost:8081` when unset. Set
`MTHDS_API_KEY` only when the configured API requires it.

The MCP endpoint is available at `http://localhost:3000/mcp`, with Skybridge
DevTools at `http://localhost:3000`.

## Build

```bash
npm run build
```

`mthds_validate` registers the `validation-graph` view (`src/views/validation-graph.tsx`),
which satisfies Skybridge's "≥1 view entry" production-build requirement. Build
scans `src/views/` and regenerates `.skybridge/views.d.ts` (the view-name
registry) as its first step, so `npm run check` runs `build` before the
standalone `typecheck` — the registry must exist for `tsc` to know the view
name.
