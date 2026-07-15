# Pipelex MCP

Pipelex MCP exposes MTHDS validation and inputs projection to MCP hosts through
a Skybridge server.

It registers the MCP tools `mthds_validate` and `mthds_inputs`. `mthds_validate`
accepts submitted `.mthds` file contents and returns a stable validation result
the assistant can use to explain and repair diagnostics; on a positive verdict,
the tool's `run-graph` Skybridge view renders the method graph interactively
with `@pipelex/mthds-ui`'s `GraphViewer`. `mthds_inputs` projects a pipe's
declared inputs as a fill-in template the assistant can populate for a run.

## Tools

### `mthds_validate`

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
    retryable: boolean;
  }>;
}
```

The MCP `content` text contains the human-readable summary; it is not duplicated
inside `structuredContent`. The graph (`graph_spec`) is delivered on the tool
result's view-only `_meta` channel (`_meta.graph_spec`) for the
`run-graph` view — never in `structuredContent`, so the model never pays
its tokens. Since the model never sees `_meta`, `available_view_specs` is how it
learns a view exists to surface: it lists the renderable view kinds for this
result. The only kind for now is `"dry_run_graph"` (the method graph from the
validation dry run, whose spec rides `_meta.graph_spec`), present exactly when
that spec was produced and empty otherwise. On those verdicts a short `## Views`
note is also appended to the summary as a prose signal of the same.

### `mthds_inputs`

Input:

```ts
{
  files: Array<{ content: string; uri?: string | null }>;
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}
```

`pipe_ref` is the pipe to project, as a qualified `domain.pipe_code`; omit it to
default to the closure's declared `main_pipe`. `explicit` (default false)
requests the ceremonial `{concept, content}` envelope per input. `format`
(default `"json"`) chooses the template encoding: `"json"` returns a parsed
object in `inputs`, `"toml"` returns raw TOML text in `inputs_toml`, preserving
concept comments and key order.

Output:

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

Verdict discipline matches `mthds_validate`: a produced verdict is always
`status: "ok"`, discriminated on `is_valid` — an unresolvable closure comes back
`is_valid: false` with `validation_errors[]`, never a thrown error. `status:
"error"` + `errors[]` covers no-verdict conditions only, including an unknown
`pipe_ref` or an unresolvable `main_pipe` default (the API rejects those with a
422). The tool has no Skybridge view: the template is small structured data the
model reads directly, and the `content` summary repeats it in a fenced code
block for hosts that read prose more reliably than structured fields.

## Local Development

During early development, this repo supports the local OSS `pipelex-api` runner
so the MCP can be exercised before the Pipelex Hosted API path is fully wired.
That local runner support is temporary: the intended production target is the
Pipelex Hosted API only.

Prerequisites:

- Node.js 24+
- A local OSS `pipelex-api` serving `POST /v1/validate` and `POST /v1/build/inputs`

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
PIPELEX_BASE_URL=http://localhost:8081 npm run dev
```

`PIPELEX_BASE_URL` defaults to the hosted Pipelex API (`https://api.pipelex.com`)
when unset — set it to `http://localhost:8081` (as above) to develop against a
local OSS runner. Set `PIPELEX_API_KEY` only when the configured API requires it.

Instead of prefixing every `npm run dev`, you can put the variables in a `.env`
file at the repo root (gitignored):

```bash
PIPELEX_BASE_URL=http://localhost:8081
```

The dev server loads it via `nodemon.json` (`tsx --env-file-if-exists=.env`).
`.env` is dev-only — deployed environments get their variables from the
hosting platform — and it is not watched: restart the dev server (or type
`rs`) after editing it.

The MCP endpoint is available at `http://localhost:3000/mcp`, with Skybridge
DevTools at `http://localhost:3000`.

## Build

```bash
npm run build
```

`mthds_validate` registers the `run-graph` view (`src/views/run-graph.tsx`),
which satisfies Skybridge's "≥1 view entry" production-build requirement. Build
scans `src/views/` and regenerates `.skybridge/views.d.ts` (the view-name
registry) as its first step, so `npm run check` runs `build` before the
standalone `typecheck` — the registry must exist for `tsc` to know the view
name.

## Versioning

`pipelex-mcp` follows [Semantic Versioning](https://semver.org); `version` in
`package.json` is tagged (`vX.Y.Z`) on release. See [`CHANGELOG.md`](CHANGELOG.md)
for what has shipped. `0.1.0` is the first tagged release.
