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
contracts — with one documented exception per shell, marked below:

| Tool | What it does |
|---|---|
| `mthds_list_methods` | List the active API key's organization catalog as bounded names, descriptions, and canonical ids — never method source or stored inputs/outputs. |
| `mthds_validate` | Validate submitted `.mthds` files, or a registered method by catalog id; on a valid verdict, ship the dry-run method graph to the `run-graph` view (hosted only). |
| `mthds_inputs_template` | Project a pipe's declared inputs as a fill-in template for a run. |
| `mthds_codegen` | Generate typed code for a method's concepts — TypeScript (`ts-zod`) or Python (`python-pydantic`, `python-structures`) — stamped and locked, to write verbatim into the project. On the local workshop, `output_dir` writes the tree straight to disk. |
| `mthds_prepare_inputs` | Turn filled inputs run-ready: upload file-bearing values to Pipelex storage and rewrite them to `pipelex-storage://` (workshop uploads; console is pass-through only). |
| `mthds_upload_attachments` | **Hosted console only.** Turn a file the user attached in the chat into a run-ready `pipelex-storage://` reference (ChatGPT only — see [Chat attachments](#chat-attachments-chatgpt-only)). |
| `mthds_run` | Start a durable run on the hosted Pipelex API; returns a durable `run_id` immediately. |
| `mthds_run_status` | Check a durable run's coarse lifecycle state by `run_id`. |
| `mthds_run_results` | Fetch a durable run's terminal outcome by `run_id`. |
| `mthds_download_artifacts` | **Local workshop only.** Save the files a completed run produced (images, PDFs, documents) under the directory the server was started in — see [Saving run artifacts](#saving-run-artifacts-local-workshop-only). |

The two exceptions mirror each other. `mthds_upload_attachments` takes a
host-substituted attachment reference, and the host gates that substitution on
the declared JSON Schema, so on the workshop the tool would be *structurally
unreachable* rather than merely unused. `mthds_download_artifacts` writes files
under the server's working directory, which the console does not have — its
users download run outputs from the app's UI. The invariant that still holds is
that **no tool name means different things on the two shells.**

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
  `mthds_inputs_template` / `mthds_codegen` calls that submit `files` against a key-less API;
  effectively required for the run family and for any `method_id` call on any
  tool, since the catalog is org-scoped (a missing/invalid key is a `config`
  no-verdict).
- `PIPELEX_BASE_URL` — defaults to the hosted Pipelex API
  (`https://api.pipelex.com`). Set it to `http://localhost:8081` to develop
  against a local OSS `pipelex-api` runner. Durable runs need the hosted API; a
  bare runner has no run lifecycle.

**The working directory matters.** The host spawns the workshop in your
project, and that directory is the boundary for everything the server touches
on disk: `files: { path }` items resolve inside it, `mthds_download_artifacts`
saves under it, and `mthds_codegen`'s `output_dir` writes under it. Nothing
outside it is ever read or written — an absolute path, a `..`, or a symlink
pointing out of the tree is refused.

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
// input — exactly ONE of files / method_ref / method_id
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
  include_graph?: boolean;
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  is_runnable: boolean;
  pending_signatures: string[];
  available_view_specs: Array<"dry_run_graph" | "input_form">;
  main_pipe?: {                    // on every valid verdict with an effective entry pipe
    pipe_ref: string;              // namespaced domain.pipe_code
    inputs: Array<{                // ordered: authored order when the runner states it
      name: string;
      concept_ref: string;         // fully-qualified, multiplicity suffix stripped
      multiplicity: "single" | "variable" | "fixed";
      item_count?: number;         // only on the fixed arm
      required: boolean;
    }>;
    output: {
      concept_ref: string;
      multiplicity: "single" | "variable" | "fixed";
      item_count?: number;
      optional: boolean;
    };
  };
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

`main_pipe` is the main pipe's typed signature — what an agent needs to write a
call site against a method whose source it never sees (a `method_ref` or
`method_id` call), instead of guessing the produced concept. It is present on
every valid verdict for which the server settled an effective entry pipe — for
a published method, the one its manifest names — pending signatures included,
on the workshop as much as the console: it does not ride the views branch. Its
absence means no entry pipe was settled, not that the method declares none. Any
malformed member omits the whole signature rather than emitting a partial one;
the verdict is unaffected. The same thing is rendered as one line
of the Markdown summary,
`demo.main(document: legal.Contract, notes?: native.Text, tags: native.Text[]) -> analysis.Report[2]`
(`?` may be omitted, `[]` a list, `[N]` exactly N).

The graph (`graph_spec`) and the form's per-pipe artifact pair — the IO
contracts (`pipe_io_contracts`) and the input-form descriptor (`input_form`,
requested from the API via the opt-in `views: ["input_form"]` token) — ride the
tool result's view-only `_meta` channel for the `run-graph` view — never
`structuredContent`, so the model never pays their tokens. On the hosted
console that view renders the method graph and, on a runnable verdict that
carries both artifacts, an input form for the main pipe (its fields derived
from the wire descriptor) whose Run button starts the method from the view.
`available_view_specs` is how the model learns which views exist to surface;
`include_graph` defaults to true. The MCP `content` text
carries the human-readable summary. The three source forms are **mutually
exclusive — supply exactly one**. `method_ref` validates a published method by
its address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`, e.g.
`github.com/Pipelex/methods/documents@v0.1.0`); `method_id` validates a
registered method by its catalog id (requires an API key, since the catalog is
org-scoped). Both are **server pass-throughs**: the selector rides the
`/v1/validate` body and the hosted API resolves it — no method source enters
the conversation. The graph view works identically whichever source form the
verdict came from.

### `mthds_inputs_template`

```ts
// input — exactly ONE of files / method_ref / method_id
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
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
`format` (default `"json"`) chooses the template encoding. The three source
forms are **mutually exclusive — supply exactly one**. `method_ref` projects a
published method by address, resolved server-side on the build envelope;
`method_id` projects a registered method's current stored content (requires an
API key, since the catalog is org-scoped). No Skybridge view — the template is
small structured data the model reads directly, and the `content` summary repeats
it in a fenced block.

### `mthds_codegen`

```ts
// input — exactly ONE of files / method_ref / method_id, plus the required target
{
  files?: SubmittedFileInput[];
  method_ref?: string;         // published method address — github.com/<owner>/<repo>[/<selector>][@<tag>]
  method_id?: string;          // catalog id (mt_…) of a registered method
  target: "ts-zod" | "python-pydantic" | "python-structures";
  output_dir?: string;         // LOCAL WORKSHOP ONLY — write the tree here instead of returning its content
}

// structuredContent
{
  status: "ok" | "error";
  is_valid: boolean;
  target?: "ts-zod" | "python-pydantic" | "python-structures";
  kind?: "types";
  crate_fingerprint?: string;
  engine_version?: string;
  artifacts?: Array<{ path: string; bytes: number; content?: string; written_to?: string }>;
  lock?: { filename: string; bytes: number; content?: string; written_to?: string };
  truncated?: boolean;
  // the written arm (output_dir):
  output_dir?: string;
  is_current?: boolean;
  orphans?: string[];
  orphans_truncated?: boolean;
  drifts?: unknown[];
  validation_errors?: unknown[];
  errors?: ToolError[];
}
```

Projects the method's concept set into typed models through the Pipelex codegen
engine (`POST /v1/codegen`). `target` is required and has no default — the tool
description carries the decision rule, so the assistant picks it from the
project (the user's explicit request wins): `ts-zod` for a TypeScript or
JavaScript project (`types.ts` with zod schemas and inferred types, plus
`binder.ts` with a parse/serialize pair per concept — keep both),
`python-pydantic` for a Python consumer with no Pipelex runtime (`models.py`),
`python-structures` for a Pipelex host or a `@pipe_func` implementation
(`structures.py`). Field keys stay snake_case in every target. The three
selectors are server pass-throughs — no bundle enters the conversation.

**On the local workshop, pass `output_dir`** — a dedicated generated directory
relative to the working directory, such as `src/generated/<method>/`. The tool
writes the artifacts and `codegen.lock` there verbatim and returns no file
content at all: `output_dir`, `written_to` per file, `is_current` and any
`orphans` instead. It overwrites files it generated (they carry a codegen
stamp) and the lock beside them, and refuses the whole write rather than touch
anything else — a symlink, a directory, or a file it did not write. Orphans, a
stamped file the new lock does not list, are reported and never deleted, so a
directory holding two generations stays non-current by design; give each
generation its own directory. The hosted console takes no `output_dir` and
refuses it instructively.

**Without `output_dir`**, write every artifact at its path and the lock as
`codegen.lock` beside them, **verbatim**, into a dedicated generated directory;
`pipelex codegen check` (or `runCodegenCheck` from `@pipelex/sdk`) then passes
on that tree. The `content` summary repeats each file in a fenced block tagged
for its language. A large set is withheld by whole file rather than cut
(`truncated: true`, `content` absent on the withheld entries; the lock's bytes
are reserved first, so the trust anchor always rides). No Skybridge view.

### `mthds_prepare_inputs`

```ts
// input — exactly ONE of files / method_id, plus the filled inputs (no method_ref — see below)
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
run — from submitted files (`files?`, plus `pipe_code?` and `inputs?`), from a
published method's address (`method_ref?` —
`github.com/<owner>/<repo>[/<selector>][@<tag>]`, resolved server-side with the
resolved commit SHA echoed back as `method_provenance`), or from a registered
method's catalog id (`method_id?`, mt_…) — and returns a durable
`run_id` immediately (never blocks); `mthds_run_status` is a cheap read of the
coarse lifecycle state; `mthds_run_results` fetches the terminal outcome (main
output on success, failure message otherwise) along with a compact run-level
`usage` object — total USD cost (null-aware), tokens, and inference-call count.
The per-pipe rollup and the full per-call record list ride the view-only `_meta`
(`_meta.usage_by_pipe` / `_meta.tokens_usages`) for a future detailed-cost
surface, and usage never appears in the prose. A by-id run executes the method's
**current** stored content (methods are not versioned) and requires an API key;
when both `files` and `method_id` are supplied, the files run and the id is
recorded as run-history linkage on the platform. `method_ref` is a complete run
source of its own and pairs with nothing — beside `files` or `method_id` the
request is refused. All run
state lives behind the durable `run_id` on the platform, so the flow survives
conversation gaps — days later, the same id still answers. On the hosted console,
`mthds_run` ships the `run-follow` live-status view; on the workshop these are
plain tools. See `SPEC.md` → "Run Scope" for the full contract.

The pipe selector is `pipe_code` here and `pipe_ref` on `mthds_inputs_template`
/ `mthds_prepare_inputs` — the same qualified `domain.pipe_code` value under the
name each underlying route uses; each description names the other, so copying
the value across the two calls is expected.

### Saving run artifacts (local workshop only)

`mthds_download_artifacts` is the download counterpart of `mthds_prepare_inputs`:
where prepare pushes local files *into* Pipelex storage, this brings a run's
produced files back *out*, onto disk.

```ts
// input
{
  run_id: string;   // the durable run id from mthds_run
  dir?: string;     // where to save, relative to the server's working directory (created if missing; must stay inside it)
}

// structuredContent (state = "completed")
{
  status: "ok";
  run_id: string;
  state: "completed";
  artifacts: Array<{ uri: string; path?: string; content_type?: string | null; size?: number; error?: ToolError }>;
  saved_paths: string[];   // relative to the working directory
  all_saved: boolean;      // every referenced file saved
}
```

A completed run's results carry a produced image, PDF or document with a
`pipelex-storage://` reference beside a presigned `public_url` that expires
within the hour. Pass the run id here instead of racing that link: every
reference in the run's full output is resolved to a *fresh* link through the
API and streamed into a file under the working directory — so the same call
still works days later. Filenames come from the storage key, sanitized; files
are **never overwritten** (a collision gets a numeric suffix); `dir` cannot
escape the working directory (no absolute paths, no `..`, no symlink out). A
`running` or `failed` run is a produced verdict with nothing to save; partial
success is a produced verdict with the failures on their items. On the
workshop, a `mthds_run_results` summary whose output references stored files
names this tool. See `SPEC.md` → "Artifact Download Scope" for the full
contract and the reasoning behind a companion tool rather than a flag on
`mthds_run_results`.

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
| `PIPELEX_MCP_RESOURCE_INDICATOR` | the server **origin with a trailing slash** — `http://localhost:6843/`, not `.../mcp` |

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
make dev                               # sources .env ahead of the shell, then `npm run dev`
```

```env
# .env at the repo root (gitignored)
WORKOS_AUTHKIT_DOMAIN=<tenant>.authkit.app
PIPELEX_MCP_RESOURCE_INDICATOR=http://localhost:6843/
PIPELEX_BASE_URL=http://localhost:8081
```

`PIPELEX_BASE_URL` defaults to the hosted Pipelex API when unset — set it to
`http://localhost:8081` to develop against a local runner. `PIPELEX_API_KEY` has
**no effect on the console**: the caller's verified OAuth token always overrides
it. `.env` is dev-only and loaded via `nodemon.json`
(`tsx --env-file-if-exists=.env`); it is not watched, so restart the dev server
after editing it.

Start it with `make dev` rather than `npm run dev` whenever your shell already exports one of these variables: Node's `--env-file` never overrides an inherited variable, so a profile-level `export PIPELEX_BASE_URL=…` would silently win over `.env`. `make dev` (and `make dev-tunnel`) sources `.env` first so the file wins, prints the API target it resolved, and still lets `make dev PIPELEX_BASE_URL=http://localhost:8080` override it for one run.

The console runs on a **pinned port, `6843`**, not Skybridge's default 3000. Skybridge would otherwise walk up to the next free port when 3000 is busy (it is, whenever a Next.js app is running), and the Resource Indicator names the port — so a console that drifted to 3001 booted fine and then failed every tool call at audience verification. `make dev` and `make dev-tunnel` pass `--port` to turn that fallback off, and refuse to start, naming the fix, when the port is held by another process or when a localhost Resource Indicator names a different port. Register `http://localhost:6843/` as the Resource Indicator in the WorkOS dashboard and put the DevTools origin `http://localhost:6843` on its CORS list; `make dev CONSOLE_PORT=<n>` overrides the port for one run if you registered another.

**A DevTools session lives as long as its WorkOS access token, and only a page reload renews it.** DevTools obtains a token when it connects and never refreshes it mid-session: once the token expires, every tool call gets the console's 401 (`"exp" claim timestamp check failed`), the MCP client throws instead of refreshing, and DevTools shows nothing — the call looks like it ran and delivered nothing. Reload the tab (F5) and it reconnects with a fresh token. Do not restart `make dev` for this: it fixes nothing, and a tab connected to the console you just killed stays on "Connecting to server…" until it is reloaded. The lifetime is the WorkOS application's "Access token duration" (dashboard → the application's Sessions tab). The default is five minutes, which makes DevTools unusable for anything longer than a short burst, so the dev tenant's is set to one hour. Skybridge prints nothing for a tool call in dev, so an empty Logs pane is not evidence either way.

The MCP endpoint is at `http://localhost:6843/mcp`, with Skybridge DevTools at
`http://localhost:6843`.

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

`make test` fakes every API client, so it proves the projections and never touches the network; `make all` and CI run only that. The live targets are the drift detector: the faked seams mean a wire-shape change on the API side fails nothing at all in the hermetic suite, so `make test-e2e` calls each capability with the real `PipelexApiClient` and `make smoke` drives the whole shell over stdio. Both need `PIPELEX_API_KEY` (a gitignored `.env` at the repo root is enough), and neither spends inference credit — the run family that does only fires under `make test-e2e-run`. Their codegen legs need one thing more against the hosted API: `/v1/codegen` sits behind the `FF_PLAYGROUND` feature flag as well as the plan, so a perfectly valid key whose organization is not enabled for it gets a 403 that reddens the whole run — ask for the flag, or point `PIPELEX_BASE_URL` at a local runner, which does not gate the route. `make smoke` is entirely read-only; `make test-e2e` has one write, the workshop arm of `mthds_prepare_inputs`, which uploads a 1x1 PNG to your organization's Pipelex storage to prove the upload path still rewrites values to `pipelex-storage://`. The SDK exposes no delete, so that object persists.

`make test-all` chains all three in cost order and adds the run family, so a single command covers every test in the repo; it spends inference credit, which is why `make all` does not reach it. `make agent-test` is the same hermetic suite as `make test` with its output captured and replayed only on failure, plus a heartbeat while it runs — meant for coding agents, whose context a few hundred lines of green vitest output would otherwise fill.

The by-id paths need one durable fixture method in the API key's organization; `make seed-e2e-fixture` creates or refreshes it, idempotently. See `CLAUDE.md` → "Detecting API drift".

## Versioning

`pipelex-mcp` follows [Semantic Versioning](https://semver.org); `version` in
`package.json` is tagged (`vX.Y.Z`) on release, and npm publish and the Alpic
deploy ship together at one version. See [`CHANGELOG.md`](CHANGELOG.md) for what
has shipped. `0.1.0` is the first tagged release.
