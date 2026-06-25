# Pipelex MCP

Pipelex MCP exposes local MTHDS validation to MCP hosts through a Skybridge
server.

v0.1 is intentionally tool-only. It registers one MCP tool, `mthds_validate`,
which accepts submitted `.mthds` file contents and returns a stable validation
result the assistant can use to explain and repair diagnostics.

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

The MCP `content` text contains the human-readable summary; it is not duplicated
inside `structuredContent`.

## Local Development

Prerequisites:

- Node.js 24+
- The sibling `../mthds-js` package
- A local `pipelex-api` serving `POST /v1/validate`

Install dependencies:

```bash
npm install
```

Start the local API separately, then run the Skybridge dev server:

```bash
cd ../pipelex-api
make run
```

The local API should answer at `http://localhost:8081`. In another terminal,
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

Skybridge currently needs at least one view entry during production builds, so
`src/views/build-placeholder.tsx` is intentionally present but not registered by
any tool.
