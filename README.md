# Pipelex MCP

Pipelex MCP exposes registered-method discovery, MTHDS validation, inputs
projection and preparation, and durable method runs to MCP hosts, wrapping the Pipelex API through the
`@pipelex/sdk` `PipelexApiClient`. It ships as **two servers from one repo and
one capability core**:

- **Hosted console** — a [Skybridge](https://docs.skybridge.tech) HTTP server
  (deployed on Alpic) for remote-connector hosts (ChatGPT, claude.ai, Claude
  Desktop, Cowork). Registers the Skybridge views.
- **Local workshop** — an npm-distributed stdio server (`@pipelex/mcp`, bin
  `pipelex-mcp`) that coding-agent hosts (Claude Code, Codex, Cursor, Cowork)
  spawn via `npx`. Its headline feature is the `{ path }` file arm: it reads
  `.mthds` files from disk instead of having the model hand-copy their contents.

## Get started

Pick **one** server for a given host — the workshop wherever there is a
filesystem, the console everywhere else.

**Hosted console** — add as a custom connector in ChatGPT, claude.ai or
Claude Desktop, then sign in with your Pipelex account. Nothing to install, no
key to paste:

```
https://pipelex-mcp-a3c6a115.alpic.live/mcp
```

**Local workshop** — for hosts that can spawn a process (Claude Code, Codex,
Cursor). Needs Node.js 24+; hosts fetch it on demand, so there is nothing to
install globally:

```bash
claude mcp add pipelex --env PIPELEX_API_KEY=plx_sk_... -- npx -y @pipelex/mcp
```

Then ask it what methods you have, or point it at a `.mthds` file. Per-host
registration snippets are under [Local workshop: install &
register](#local-workshop-install--register), and which server belongs on which
host is the [Host → server matrix](#host--server-matrix).

Both servers register the same MCP tools, with identical names, schemas, and
contracts — with one documented exception, marked below:

| Tool | What it does |
|---|---|
| `mthds_list_methods` | List the active API key's organization catalog as bounded names, descriptions, and canonical ids — never method source or stored inputs/outputs. |
| `mthds_validate` | Validate submitted `.mthds` files, or a registered method by catalog id; on a valid verdict, ship the dry-run method graph to the `run-graph` view (hosted only). |
| `mthds_inputs_template` | Project a pipe's declared inputs as a fill-in template for a run. |
| `mthds_prepare_inputs` | Turn filled inputs run-ready: upload file-bearing values to Pipelex storage and rewrite them to `pipelex-storage://` (workshop uploads; console is pass-through only). |
| `mthds_upload_attachments` | **Hosted console only.** Turn a file the user attached in the chat into a run-ready `pipelex-storage://` reference (ChatGPT only — see [Chat attachments](#chat-attachments-chatgpt-only)). |
| `mthds_run` | Start a durable run on the hosted Pipelex API; returns a durable `run_id` immediately. |
| `mthds_run_status` | Check a durable run's coarse lifecycle state by `run_id`. |
| `mthds_run_results` | Fetch a durable run's terminal outcome by `run_id`. |

`mthds_upload_attachments` is the exception: its sole argument is a
host-substituted attachment reference, and the host gates that substitution on
the declared JSON Schema, so on the workshop the tool would be *structurally
unreachable* rather than merely unused. The invariant that still holds is that
**no tool name means different things on the two shells.**

`SPEC.md` is the source of truth for the full tool contracts, verdict
discipline, and view behavior. This README covers what you need to install,
register, and run the servers. `docs/readme.html` is an illustrated overview
of the same ground — the two shells, the tool surface, the flow a method
takes, and the sharp edges — for reading in a browser.

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

- `PIPELEX_API_KEY` — a `plx_sk_` platform key. Required for
  `mthds_list_methods` because the returned catalog is the key's active,
  workspace-shared organization catalog. Optional for `mthds_validate` /
  `mthds_inputs_template` calls that submit `files` against a key-less API;
  effectively required for the run family and for any `method_id` call on any
  tool, since the catalog is org-scoped (a missing/invalid key is a `config`
  no-verdict).
- `PIPELEX_BASE_URL` — defaults to the hosted Pipelex API
  (`https://api.pipelex.com`). Set it to `http://localhost:8081` to develop
  against a local OSS `pipelex-api` runner. Durable runs need the hosted API; a
  bare runner has no run lifecycle.

## Hosted console: sign in with your Pipelex account

The hosted console holds **no server-side API key** and there is nothing to
paste. Add the connector by its URL and your host walks you through signing in
with your Pipelex account:

```
https://pipelex-mcp-a3c6a115.alpic.live/mcp
```

That is the production console. The hostname is assigned by Alpic, and the
OAuth Resource Indicator registered with WorkOS is pinned to it, so it moves
only behind a deliberate migration — if it ever does, every existing
connector has to be re-added anyway.

Sign-in is OAuth through WorkOS AuthKit, which the console's MCP host drives
for you — ChatGPT, claude.ai, Claude Desktop/Cowork and Cursor all handle the
handshake themselves, including picking the organization you want to work in.
Your verified session is what authorizes every call the console makes on your
behalf, so the catalog you see and the runs you spend are your own. The token
never travels through tool arguments, so it never enters the model's context.

There is **no keyless mode**: every tool call requires a signed-in session. If
one expires or is revoked, calls come back as a `config` no-verdict at
`authorization` telling you to reconnect the connector and sign in again.

> **Upgrading from a `?api_key=` connector.** Bring-your-own-key has been
> removed. A connector still registered with `?api_key=plx_sk_...` (or an
> `Authorization: Bearer plx_sk_...` header) no longer connects at all — remove
> it and re-add it by the plain URL above. ChatGPT in particular caches a
> connector's configuration at add-time, so re-adding is the only path.

(That said, prefer the **local workshop** on hosts that can spawn it — see the
matrix below.)

## Chat attachments (ChatGPT only)

The workshop gets the user's actual file through the `{ path }` arm. The console
has no filesystem, so it gets it a different way: **ChatGPT's Apps runtime
rewrites the model's reference to an attached file into a signed-URL object**
before the call reaches the server. `mthds_upload_attachments` takes that
channel — it fetches the bytes server-side and uploads them to Pipelex storage
under your signed-in account, returning only small URI strings. **The bytes never enter
the model's context**, which is the whole reason console-side upload is allowed
here at all.

The flow, on the console:

```
user attaches a PDF in the chat
  → mthds_upload_attachments   → pipelex-storage://… uris
  → fill the uris into the mthds_inputs_template output
  → mthds_run
```

`mthds_prepare_inputs` can be **skipped** — a `pipelex-storage://` value is
already run-ready. Nothing else in the flow changes.

Three things to know:

- **Re-add the connector to get it.** ChatGPT caches a connector's tool list at
  add-time and never refreshes it, so a newly shipped tool (or a changed tool
  description) stays invisible to an existing installation until you remove and
  re-add the connector.
- **7 MiB per attachment.** This is a transport ceiling, not a product choice:
  `POST /v1/upload` takes a base64 body behind an AWS API Gateway HTTP API, whose
  10 MiB request quota divides by base64's 4/3 inflation to ~7.5 MiB decoded.
  (The app-level 50 MiB `MAX_UPLOAD_MIB` is unreachable through the public
  gateway — don't quote it.) ChatGPT hands over much larger files happily, so
  expect to meet this; the refusal fires before any bytes are fetched and names
  the limit.
- **ChatGPT only.** claude.ai injects no file reference into a connector call, and
  MCP has nothing in-spec (SEP-2631 is an open draft). On any other host the
  model can only fabricate a URL, which the fetch boundary refuses — that refusal
  is also the "this host cannot attach files, ask for an `http(s)` URL"
  diagnostic.

**Attachment fetch boundary.** Fetching a host-supplied URL from a public
endpoint is an SSRF surface, so the fetch is a deny-by-default policy: `https:`
only; the host must be `oaiusercontent.com` at the apex or on any subdomain
(OpenAI's own locked domain — where live attachment traffic is served), or
`oaisdmntpr<azure-region>.blob.core.windows.net` (where it used to be, and where
the `oaisdmntpr` prefix stays **required**, because that suffix is multi-tenant
and a suffix-only rule would admit any Azure customer's storage account); no
credentials in the URL, no non-default port; redirects refused; the size cap
enforced from `content-length` before the body is read *and* again mid-stream; a
bounded timeout; no headers forwarded; non-2xx refused. Because these hosts are
undocumented vendor infrastructure that changes without notice — it already has
once — the cap, the timeout, and the no-redirect rule hold on their own; the
host check is a filter, not the defence.

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

### `mthds_list_methods`

```ts
// input
{
  query?: string;   // trimmed, case-insensitive; matched SERVER-side over name/description
  limit?: number;   // integer 1..50; default 20
  cursor?: string;  // opaque next_cursor from a previous call
}

// structuredContent — success
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

Both shells expose this read-only, no-view catalog entry point. Search and
paging are the server's job: `query` is applied across the whole organization
catalog rather than over one page, and rows arrive already ordered newest first
by the immutable `created_at` the catalog pages on. Continue a listing by
passing the returned `next_cursor` back as `cursor`. Names are bounded to 200
Unicode code points and descriptions to 500, with explicit truncation flags.
Empty catalogs and no-match queries are successful empty results.

There is deliberately no total: counting a catalog means reading all of it,
which is the cost paging exists to avoid.

The projection is deliberately source-free: `mthds`, Python, stored inputs and
outputs, organization ids, and creator ids never enter `structuredContent`,
`content`, `_meta`, or logs — and the index projection no longer carries them
at all. A malformed row fails the whole result as a non-retryable runtime
contract error rather than returning a misleading partial list.

Name-to-run flow:

```text
mthds_list_methods({ query: "invoice" })
  → choose/disambiguate method_id
  → mthds_validate({ method_id })                 # optional current-content check
  → mthds_inputs_template({ method_id })
  → fill inputs; prepare/upload assets if needed
  → mthds_run({ method_id, inputs })
```

No method source crosses the conversation in this flow.

### `mthds_validate`

```ts
// input — at least one of files / method_id
{
  files?: SubmittedFileInput[];
  method_id?: string;          // catalog id (mt_…) of a registered method
  include_graph?: boolean;
}

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
carries the human-readable summary. `method_id` validates a registered method by
its catalog id (fetch-and-forward from the method's current stored content, the
same pattern as `mthds_inputs_template`); it requires an API key, since the
catalog is org-scoped, and when both `files` and `method_id` are supplied the
files win and the id is ignored. The graph view works identically whether the
content came from submitted files or a by-id fetch.

### `mthds_inputs_template`

```ts
// input — at least one of files / method_id
{
  files?: SubmittedFileInput[];
  method_id?: string;          // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  explicit?: boolean;
  format?: "json" | "toml";
}

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
declared `main_pipe`. `explicit` (default true) emits the ceremonial
`{concept, content}` envelope per input — the declared concept ref plus the
canonical content shape; pass `false` for the light shape (bare example values).
`format` (default `"json"`) chooses the template encoding. `method_id` projects a registered method by its catalog id
(fetch-and-forward from the method's current stored content); it requires an API
key, since the catalog is org-scoped, and when both `files` and `method_id` are
supplied the files win and the id is ignored. No Skybridge view — the template is
small structured data the model reads directly, and the `content` summary repeats
it in a fenced block.

### `mthds_prepare_inputs`

```ts
// input — at least one of files / method_id, plus the filled inputs
{
  files?: SubmittedFileInput[];
  method_id?: string;               // catalog id (mt_…) of a registered method
  pipe_ref?: string;
  inputs: Record<string, unknown>;  // the FILLED mthds_inputs_template output
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  pipe_ref?: string;                // echoed only when the caller supplied it
  inputs?: Record<string, unknown>; // the prepared (rewritten) inputs — ready for mthds_run
  uploads?: string[];               // the pipelex-storage:// uris uploaded this call ([] when all pass-through)
  errors?: ToolError[];
}
```

Sits between `mthds_inputs_template` (produces the empty template) and `mthds_run`
(executes the filled inputs): it makes file-bearing inputs run-ready. The pipe's
declared signature identifies which values are assets; each is uploaded to Pipelex
storage and rewritten to `pipelex-storage://`. `http(s)` URLs and existing
`pipelex-storage://` references pass through unchanged, so an inputs set that is
already all pass-through can skip this step. **Per-deployment asset boundary:** the
**local workshop** uploads local paths, `data:` URLs, and inline bytes with your
API key; the **hosted console is pass-through only** and refuses any upload-needing
input up front with an `input_domain` error at `inputs`, naming the workshop. No
Skybridge view — the prepared inputs are small structured data the model reads
directly, repeated in the `content` summary. Unlike the other tools this has **no
produced-invalid arm**: an unresolvable closure is a no-verdict `status: "error"`
(recover via `mthds_validate` / `mthds_inputs_template`). See `SPEC.md` →
"Prepare Inputs Scope" for the full contract.

### `mthds_upload_attachments` — hosted console only

```ts
// input — the host fills this in; never construct one yourself
{
  attachments: Array<{
    download_url: string;   // required — the host's signed HTTPS URL
    file_id: string;        // required — e.g. "sediment://file_0000…"
    mime_type?: string;
    file_name?: string;
  }>;
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;                  // true only when EVERY attachment ingested
  attachments?: Array<{
    file_id: string;
    file_name?: string;
    uri?: string;                     // the pipelex-storage:// reference, on success
    content_type?: string;
    size?: number;                    // decoded bytes
    error?: ToolError;                // per-item failure
  }>;
  uploads?: string[];                 // the successful uris
  errors?: ToolError[];               // no-verdict only
}
```

Registered on the **hosted console only**, and populated by **ChatGPT only** —
see [Chat attachments](#chat-attachments-chatgpt-only) for the flow, the 7 MiB
cap, and the fetch boundary. The four-field attachment shape is mandated, not
chosen: OpenAI's app review requires exactly these properties with exactly this
required/optional split, and the host's runtime substitution is gated on the
same schema — so a deliberately lenient variant would never be populated. **Partial
success is a produced verdict**: `status: "ok"` with `is_valid: false`, the
successful `uploads` returned alongside per-item errors rather than discarded.
No Skybridge view — the returned URIs are small structured data the model reads
directly, repeated in the `content` summary.

### `mthds_run` / `mthds_run_status` / `mthds_run_results`

Durable (async) method execution on the hosted Pipelex API. `mthds_run` starts a
run — from submitted files (`files?`, plus `pipe_code?` and `inputs?`), or from a
registered method's catalog id (`method_id?`, mt_…) — and returns a durable
`run_id` immediately (never blocks); `mthds_run_status` is a cheap read of the
coarse lifecycle state; `mthds_run_results` fetches the terminal outcome (main
output on success, failure message otherwise) along with a compact run-level
`usage` object — total USD cost (null-aware), tokens, and inference-call count.
The per-pipe rollup and the full per-call record list ride the view-only `_meta`
(`_meta.usage_by_pipe` / `_meta.tokens_usages`) for a future detailed-cost
surface, and usage never appears in the prose. A by-id run executes the method's
**current** stored content (methods are not versioned) and requires an API key;
when both `files` and `method_id` are supplied, the files run and the id is
recorded as run-history linkage on the platform. All run
state lives behind the durable `run_id` on the platform, so the flow survives
conversation gaps — days later, the same id still answers. On the hosted console,
`mthds_run` ships the `run-follow` live-status view; on the workshop these are
plain tools. See `SPEC.md` → "Run Scope" for the full contract.

### Success and verdict discipline

A successful catalog page is `status: "ok"` with counts and `methods` (there is
no `is_valid` field). For tools that produce a method verdict, a *produced*
verdict is always `status: "ok"` — discriminate on `is_valid` (and, for
validation, `is_runnable`); an invalid bundle or unresolvable closure is a
produced `is_valid: false` verdict, not an error. `status: "error"` is reserved
for **no result/verdict could be produced** and carries an `errors[]` array, each tagged
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
- A WorkOS AuthKit tenant — **the console has no keyless mode and refuses to
  start without one** (see below)

**The console requires two WorkOS variables.** Per-user OAuth is its only auth
posture, so the server throws at startup unless both are set:

| Variable | Value |
| --- | --- |
| `WORKOS_AUTHKIT_DOMAIN` | the AuthKit domain, e.g. `<tenant>.authkit.app` |
| `PIPELEX_MCP_RESOURCE_INDICATOR` | the server **origin with a trailing slash** — `http://localhost:3000/`, not `.../mcp` |

The Resource Indicator must also be registered in the WorkOS dashboard (Connect
→ Configuration), along with Dynamic Client Registration. It becomes the issued
token's `aud`, and the server verifies it byte-for-byte — registering the `/mcp`
path or dropping the trailing slash yields tokens that never validate. The
startup check rejects both mistakes with a message naming the fix, rather than
letting every tool call fail later at audience verification.

If you only need to work on the capability core, **use `make dev-local`
instead** — the workshop shell shares the same capabilities, authenticates with
a plain `PIPELEX_API_KEY`, and needs no WorkOS setup at all.

Install dependencies, start the API, then the Skybridge dev server:

```bash
npm install

cd ../pipelex-api && make run          # serves http://localhost:8081
npm run dev
```

```env
# .env at the repo root (gitignored)
WORKOS_AUTHKIT_DOMAIN=<tenant>.authkit.app
PIPELEX_MCP_RESOURCE_INDICATOR=http://localhost:3000/
PIPELEX_BASE_URL=http://localhost:8081
```

`PIPELEX_BASE_URL` defaults to the hosted Pipelex API when unset — set it to
`http://localhost:8081` to develop against a local runner. `PIPELEX_API_KEY` has
**no effect on the console**: the caller's verified OAuth token always overrides
it. `.env` is dev-only and loaded via `nodemon.json`
(`tsx --env-file-if-exists=.env`); it is not watched, so restart the dev server
after editing it.

If port 3000 is taken, Skybridge falls back to another port and prints it — the
Resource Indicator then has to match that port too, both in `.env` and in the
WorkOS dashboard.

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

## Tests

```bash
make test         # the default suite — hermetic, no network
make agent-test   # the same suite for an agent — quiet unless it fails
make test-e2e     # the live suite — real client, real Pipelex API
make smoke        # the workshop stdio server, end to end, against the live API
make test-all     # all of the above plus the run family — SPENDS INFERENCE CREDIT
```

`make test` fakes every API client, so it proves the projections and never touches the network; `make all` and CI run only that. The live targets are the drift detector: the faked seams mean a wire-shape change on the API side fails nothing at all in the hermetic suite, so `make test-e2e` calls each capability with the real `PipelexApiClient` and `make smoke` drives the whole shell over stdio. Both need `PIPELEX_API_KEY` (a gitignored `.env` at the repo root is enough), and neither spends inference credit — the run family that does only fires under `make test-e2e-run`. `make smoke` is entirely read-only; `make test-e2e` has one write, the workshop arm of `mthds_prepare_inputs`, which uploads a 1x1 PNG to your organization's Pipelex storage to prove the upload path still rewrites values to `pipelex-storage://`. The SDK exposes no delete, so that object persists.

`make test-all` chains all three in cost order and adds the run family, so a single command covers every test in the repo; it spends inference credit, which is why `make all` does not reach it. `make agent-test` is the same hermetic suite as `make test` with its output captured and replayed only on failure, plus a heartbeat while it runs — meant for coding agents, whose context a few hundred lines of green vitest output would otherwise fill.

The by-id paths need one durable fixture method in the API key's organization; `make seed-e2e-fixture` creates or refreshes it, idempotently. See `CLAUDE.md` → "Detecting API drift".

## Versioning

`pipelex-mcp` follows [Semantic Versioning](https://semver.org); `version` in
`package.json` is tagged (`vX.Y.Z`) on release, and npm publish and the Alpic
deploy ship together at one version. See [`CHANGELOG.md`](CHANGELOG.md) for what
has shipped. `0.1.0` is the first tagged release.
