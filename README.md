# Pipelex MCP

Pipelex MCP exposes MTHDS validation, inputs projection, and durable method
runs to MCP hosts, wrapping the Pipelex API through the `@pipelex/sdk`
`PipelexApiClient`. It ships as **two servers from one repo and one capability
core**:

- **Hosted console** — a [Skybridge](https://docs.skybridge.tech) HTTP server
  (deployed on Alpic) for remote-connector hosts (ChatGPT, claude.ai, Claude
  Desktop, Cowork). Registers the Skybridge views.
- **Local workshop** — an npm-distributed stdio server (`@pipelex/mcp`, bin
  `pipelex-mcp`) that coding-agent hosts (Claude Code, Codex, Cursor, Cowork)
  spawn via `npx`. Its headline feature is the `{ path }` file arm: it reads
  `.mthds` files from disk instead of having the model hand-copy their contents.

Both servers register the same MCP tools, with identical names, schemas, and
contracts:

| Tool | What it does |
|---|---|
| `mthds_validate` | Validate submitted `.mthds` files; on a valid verdict, ship the dry-run method graph to the `run-graph` view (hosted only). |
| `mthds_inputs_template` | Project a pipe's declared inputs as a fill-in template for a run. |
| `mthds_run` | Start a durable run on the hosted Pipelex API; returns a durable `run_id` immediately. |
| `mthds_run_status` | Check a durable run's coarse lifecycle state by `run_id`. |
| `mthds_run_results` | Fetch a durable run's terminal outcome by `run_id`. |

`SPEC.md` is the source of truth for the full tool contracts, verdict
discipline, and view behavior. This README covers what you need to install,
register, and run the servers.

## The two deployments, and the `{ path }` arm

MCP tool arguments are generated token-by-token by the host LLM — there is no
other channel from the conversation to the server. So submitting a bundle's
`.mthds` contents to the **hosted** server means the model re-emits every file
as output tokens (slow on large bundles, re-paid every repair-loop iteration and
every tool in the chain, and not guaranteed byte-identical to what's on disk).
The **local** server sidesteps this: the host spawns it in your workspace, so it
can read files from disk given only a path.

The shared submitted-files shape accepts two item forms — inline content or a
file path:

```ts
type SubmittedFileInput = { content: string; uri?: string | null } | { path: string };
```

Both servers register this same union, so the tool contract never forks; what
differs is behavior:

- The **workshop resolves `{ path }` from disk** before invoking the capability
  — near-constant token cost regardless of bundle size, byte-accurate reads, and
  real provenance (the resolved item carries `uri` = the submitted path, so
  diagnostics locate to files you can open and edit). Inline `{ content, uri? }`
  items stay accepted for parity.
- The **console rejects `{ path }` items** with an instructive `input_domain`
  error located at `files[i].path`: this deployment cannot read files; resubmit
  as `{ content, uri? }`, or use the local workshop (`npx @pipelex/mcp`).

An item is one arm or the other; on a malformed item carrying both keys,
`content` wins (first-match union semantics) and `path` is ignored.

**Path trust boundary (workshop).** `{ path }` values resolve relative to the
server's working directory. The arm is contracted to `.mthds` files, so a
non-`.mthds` extension is rejected **before any filesystem access** (a
prompt-injected `.env` or key-file path is never opened), and the resolved
target (symlinks followed) must live inside the working-directory subtree.
Non-`.mthds` paths, escapes, missing files, and non-regular files come back as
`input_domain` errors located at `files[i].path`.

## Local workshop: install & register

The workshop is published as [`@pipelex/mcp`](https://www.npmjs.com/package/@pipelex/mcp).
Hosts spawn it on demand with `npx -y @pipelex/mcp` (bin `pipelex-mcp`); you do
not install it globally. It needs **Node.js 24+** and a `PIPELEX_API_KEY` (a
`plx_sk_` platform key) for the run tools; validation and inputs work without one
against a key-less API.

The registration name is yours to choose; these snippets use `pipelex` (which
yields `mcp__pipelex__mthds_validate`-style tool names).

**Claude Code**

```bash
claude mcp add pipelex --env PIPELEX_API_KEY=plx_sk_... -- npx -y @pipelex/mcp
```

**Codex** — `~/.codex/config.toml`

```toml
[mcp_servers.pipelex]
command = "npx"
args = ["-y", "@pipelex/mcp"]
env = { PIPELEX_API_KEY = "plx_sk_..." }
```

**Cursor** — `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "npx",
      "args": ["-y", "@pipelex/mcp"],
      "env": { "PIPELEX_API_KEY": "plx_sk_..." }
    }
  }
}
```

**Cowork / Claude Desktop (builder mode)** — `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pipelex": {
      "command": "npx",
      "args": ["-y", "@pipelex/mcp"],
      "env": { "PIPELEX_API_KEY": "plx_sk_..." }
    }
  }
}
```

**Environment**

- `PIPELEX_API_KEY` — a `plx_sk_` platform key. Optional for `mthds_validate` /
  `mthds_inputs_template` against a key-less API; effectively required for the
  run family (a missing/invalid key is a `config` no-verdict).
- `PIPELEX_BASE_URL` — defaults to the hosted Pipelex API
  (`https://api.pipelex.com`). Set it to `http://localhost:8081` to develop
  against a local OSS `pipelex-api` runner. Durable runs need the hosted API; a
  bare runner has no run lifecycle.

## Hosted console: bring your own key

The hosted console holds **no server-side API key**. Until per-user OAuth
ships, every caller supplies their own `plx_sk_` platform key at the transport
level — the key never travels through tool arguments, so it never enters the
model's context. Two channels, depending on what your host's connector UI
supports:

- **`Authorization` header** — for hosts with header config (Claude Code,
  Cursor, Codex, scripted clients):

  ```bash
  claude mcp add --transport http pipelex https://<console-url>/mcp \
    --header "Authorization: Bearer plx_sk_..."
  ```

- **`?api_key=` on the connector URL** — for hosts whose connector UI accepts
  only a URL (claude.ai, ChatGPT, Cowork): register the connector as
  `https://<console-url>/mcp?api_key=plx_sk_...`. Mind that URLs can end up in
  intermediary logs — this channel is the documented compromise until real
  auth lands; use a key you can rotate.

A supplied key takes precedence over any server-held env key. Without a key
the handshake and `tools/list` still work, but every tool call returns a
`config` no-verdict at `api_key` explaining both channels.

(That said, prefer the **local workshop** on hosts that can spawn it — see the
matrix below. The header example above is for testing the console from Claude
Code, not the recommended pairing.)

## Host → server matrix

Connect each host to **exactly one** Pipelex server — the local workshop
wherever there's a filesystem, the hosted console everywhere else.

| Host | Server | How to connect |
|---|---|---|
| ChatGPT (web) | Hosted console | Apps directory |
| claude.ai (web + mobile) | Hosted console | Connector (custom URL) |
| Claude Desktop (chat mode) | Hosted console | Connector / marketplace plugin |
| Claude Code | Local workshop | `claude mcp add`, or the `pipelex` plugin from the `pipelex-plugins` marketplace (its manifest spawns the workshop) |
| ChatGPT desktop (Codex mode) | Local workshop | `~/.codex/config.toml` |
| Cursor | Local workshop | `~/.cursor/mcp.json` |
| Claude Desktop (Cowork mode) | **Dual** — console for consumers, workshop for builders | Connector, or stdio in `claude_desktop_config.json` |
| Mistral Vibe (TUI) | Local workshop | pending Vibe's MCP mechanics |
| Mistral Vibe (web) | Hosted console | Connector / config |

**On views:** the hosted console ships the `run-graph` and `run-follow`
views, which render on view-capable hosts (ChatGPT, claude.ai, Cowork) and
degrade to text on Claude Code. The **local workshop is tools-first — it ships
no views on any host today**, so it reports structured results and text
summaries directly. (Codex and Cowork are view-capable hosts and would render
workshop views if local view delivery lands in a later increment.)

## One host, one server

A host should be connected to **one** Pipelex server, never both. Same tool
names on both means a both-installed host has ambiguous routing (nothing
guarantees the model picks the local one), contradictory schemas under identical
names (the workshop accepts `{ path }`, the console rejects it), and doubled tool
registrations for no added capability.

The trap that gets you there without choosing it: **a claude.ai Pipelex
connector syncs into Claude Code automatically.** A user signed into claude.ai
with the connector enabled gets the hosted tools in coding sessions alongside a
locally-registered workshop. When you run the local workshop, disable the
connector for those sessions:

- In Claude Code, `/mcp` is the entry point. A connector you haven't signed into
  is collapsed behind a **"Show unused connectors"** row (Claude Code
  v2.1.161+) — expand it to find Pipelex.
- Config alternatives: per-project `deniedMcpServers` in `.claude/settings.json`,
  or global `disableClaudeAiConnectors: true` in user settings.

## Tools at a glance

Full contracts (verdict discipline, `_meta` channels, view behavior) live in
`SPEC.md`. The shapes below use `SubmittedFileInput` from
[the two deployments](#the-two-deployments-and-the--path--arm).

### `mthds_validate`

```ts
// input
{ files: SubmittedFileInput[]; include_graph?: boolean }

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: Array<"dry_run_graph">;
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

The graph (`graph_spec`) rides the tool result's view-only `_meta` channel
(`_meta.graph_spec`) for the `run-graph` view — never `structuredContent`, so the
model never pays its tokens. `available_view_specs` is how the model learns a
view exists to surface; `include_graph` defaults to true. The MCP `content` text
carries the human-readable summary.

### `mthds_inputs_template`

```ts
// input
{ files: SubmittedFileInput[]; pipe_ref?: string; explicit?: boolean; format?: "json" | "toml" }

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;
  format?: "json" | "toml";
  explicit?: boolean;
  inputs?: Record<string, unknown>;
  inputs_toml?: string;
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`pipe_ref` is a qualified `domain.pipe_code`; omit it to default to the closure's
declared `main_pipe`. `explicit` (default false) requests the ceremonial
`{concept, content}` envelope per input. `format` (default `"json"`) chooses the
template encoding. No Skybridge view — the template is small structured data the
model reads directly, and the `content` summary repeats it in a fenced block.

### `mthds_run` / `mthds_run_status` / `mthds_run_results`

Durable (async) method execution on the hosted Pipelex API. `mthds_run` starts a
run and returns a durable `run_id` immediately (never blocks); `mthds_run_status`
is a cheap read of the coarse lifecycle state; `mthds_run_results` fetches the
terminal outcome (main output on success, failure message otherwise). All run
state lives behind the durable `run_id` on the platform, so the flow survives
conversation gaps — days later, the same id still answers. On the hosted console,
`mthds_run` ships the `run-follow` live-status view; on the workshop these are
plain tools. See `SPEC.md` → "Run Scope" for the full contract.

### Verdict discipline (all tools)

A *produced* verdict is always `status: "ok"` — discriminate on `is_valid` (and,
for validation, `is_runnable`); an invalid bundle or unresolvable closure is a
produced `is_valid: false` verdict, not an error. `status: "error"` is reserved
for **no verdict could be produced** and carries an `errors[]` array, each tagged
`input_domain` (bad request), `config` (env/auth/unreachable API), or `runtime`
(server fault), plus a `retryable` flag. Every `errors[]` entry's `location`,
`message`, and `hint` are also surfaced in the `content` text.

## Hosted console: local development

The hosted server is a Skybridge app. During early development this repo also
supports the local OSS `pipelex-api` runner so the MCP can be exercised before
the hosted path is fully wired — temporary; the production target is the hosted
Pipelex API only.

Prerequisites:

- Node.js 24+
- A Pipelex API serving `POST /v1/validate` and `POST /v1/build/inputs` (a local
  OSS `pipelex-api` during development)

Install dependencies, start the API, then the Skybridge dev server:

```bash
npm install

cd ../pipelex-api && make run          # serves http://localhost:8081
PIPELEX_BASE_URL=http://localhost:8081 npm run dev
```

`PIPELEX_BASE_URL` defaults to the hosted Pipelex API when unset — set it to
`http://localhost:8081` to develop against a local runner. Set `PIPELEX_API_KEY`
only when the configured API requires it. Instead of prefixing every command,
put the variables in a gitignored `.env` at the repo root; the dev server loads
it via `nodemon.json` (`tsx --env-file-if-exists=.env`). `.env` is dev-only and
not watched — restart the dev server after editing it.

The MCP endpoint is at `http://localhost:3000/mcp`, with Skybridge DevTools at
`http://localhost:3000`.

To poke the **local workshop** stdio server during development:

```bash
make dev-local       # run the stdio server from TypeScript (tsx)
make inspect-local   # open MCP Inspector against it
```

## Build

```bash
npm run build        # Skybridge app (regenerates .skybridge/views.d.ts first)
npm run build:local  # tsup → dist/local/main.js (the npm-distributed bin)
npm run check        # lint + format:check + build + build:local + typecheck
```

`mthds_validate` registers the `run-graph` view (`src/views/run-graph.tsx`),
which satisfies Skybridge's "≥1 view entry" production-build requirement. The
Skybridge build scans `src/views/` and regenerates `.skybridge/views.d.ts` (the
view-name registry) as its first step, so `npm run check` runs `build` before the
standalone `typecheck` — the registry must exist for `tsc` to resolve the
registered view name. The local build follows and `prepack` rebuilds it, so a
pack/publish can never ship a stale or absent bin.

## Versioning

`pipelex-mcp` follows [Semantic Versioning](https://semver.org); `version` in
`package.json` is tagged (`vX.Y.Z`) on release, and npm publish and the Alpic
deploy ship together at one version. See [`CHANGELOG.md`](CHANGELOG.md) for what
has shipped. `0.1.0` is the first tagged release.
