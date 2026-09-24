# Pipelex MCP

<!-- onboarding: mcp-route -->
<!-- Generated from the Pipelex onboarding source; this region is replaced from https://raw.githubusercontent.com/Pipelex/.github/main/onboarding/rendered/mcp-route.md — do not edit it here. -->
## Get started

Pipelex lets you build AI methods with your coding agent and run them anywhere — from your agent or your chatbot via MCP, as a webapp, or via API in any software. This repository is the Pipelex MCP: it connects your chatbot to your Pipelex account and the methods saved there.

**Chatbots** — ChatGPT, Claude. Add the Pipelex MCP in your chatbot's settings by the address below — in Claude, that is **Add custom connector** — then sign in with your Pipelex account when asked. Nothing to install and no key: the Pipelex MCP runs on your signed-in session.

```
https://mcp.pipelex.com/mcp
```

**Coding agents** — Claude Code, Codex. Install the [Pipelex plugin](https://github.com/Pipelex/pipelex-plugins) instead: it brings the same tools, and the skills that build methods beside them. Claude Code also loads what you have added to your Claude account, so if the Pipelex MCP is there, turn it off in Claude Code with `/mcp`: an agent with the plugin never takes both, since they register the same tool names.

**Then ask your chatbot:**

> What methods do I have?
>
> Run the invoice method on https://example.com/invoice.pdf

You get a run id straight away, and you can ask for its status, its results or the files it produced at any time.

Give the file as a URL the Pipelex MCP can reach. In ChatGPT you can attach it to the conversation instead and ask for a run on it; Claude has no way yet to hand the Pipelex MCP a file you attached.

Other hosts, and the reference for developers, start at [Which server, for which host](#which-server-for-which-host).

**Next:** [what Pipelex is](https://go.pipelex.com/product) · [documentation](https://go.pipelex.com/docs) · [your console](https://app.pipelex.com) · [Discord](https://go.pipelex.com/discord)
<!-- /onboarding -->

## Which server, for which host

A host takes one of two things, never both: the Pipelex plugin on a coding agent, the Pipelex MCP on a chatbot. The table applies that rule host by host. A host wired to both is the one configuration to avoid — [One host, one server](#one-host-one-server) says why, and how the Pipelex MCP added in Claude reaches Claude Code without anyone choosing it.

| Host | Tool | How to connect |
|---|---|---|
| Claude Code | Pipelex plugin | [Install the plugin](https://github.com/Pipelex/pipelex-plugins#quick-start) |
| Codex | Pipelex plugin | [Install the plugin](https://github.com/Pipelex/pipelex-plugins#quick-start) |
| ChatGPT (web) | Pipelex MCP | A developer-mode app, created by the address above ([OpenAI's conditions](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)) |
| claude.ai (web + mobile) | Pipelex MCP | **Add custom connector**, by the address above |
| Claude Desktop | Pipelex MCP | **Add custom connector**, by the address above |

A host that spawns MCP servers but takes no plugin, such as Cursor, can run the plugin's MCP server by hand: [Registering the workshop in a host](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/hosts.md) gives its configuration.

**On views:** the Pipelex MCP ships the `run-graph` and `run-follow` views, which render on the hosts that display views (ChatGPT, Claude) and degrade to text elsewhere. The plugin's MCP server is **tools-first — it ships no views on any host**, so it reports structured results and text summaries directly.

## What this repository is

Pipelex MCP exposes registered-method discovery, MTHDS validation, inputs projection and preparation, and durable method runs to MCP hosts, wrapping the Pipelex API through the `@pipelex/sdk` `PipelexApiClient`. It ships as **two servers from one repo and one capability core**:

- **Hosted console** — a [Skybridge](https://docs.skybridge.tech) HTTP server, deployed on Alpic, for remote-connector hosts. Registers the Skybridge views.
- **Local workshop** — an npm-distributed stdio server (`@pipelex/mcp`, bin `pipelex-mcp`) that coding-agent hosts spawn via `npx`. Its headline feature is the `{ path }` file arm: it reads `.mthds` files from disk instead of having the model hand-copy their contents.

The console is the Pipelex MCP of the get-started above, at `mcp.pipelex.com`, and the workshop is the MCP server the Pipelex plugin runs. The rest of this page calls them by the names the code uses.

## Tools

Both servers register the same tools, under the same names and contracts, apart from the few that only one of them can serve. [The tools reference](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md) gives each tool's input, result and behavior, and why those exceptions exist.

| Tool | Registered on | What it does |
|---|---|---|
| [`mthds_list_methods`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_list_methods) | both servers | List the methods saved in your organization's catalog by name, description and id, never their source. |
| [`mthds_validate`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_validate) | both servers | Validate a method given as files, a published address or a catalog id; on the console, a valid verdict shows the method graph in the `run-graph` view. |
| [`mthds_inputs_template`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_inputs_template) | both servers | Return a fill-in template of a pipe's declared inputs. |
| [`mthds_codegen`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_codegen) | both servers | Generate typed TypeScript or Python for a method's concepts, stamped and locked; the workshop can write the tree straight to disk. |
| [`mthds_prepare_inputs`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_prepare_inputs) | both servers | Make filled inputs run-ready: the workshop uploads local files to Pipelex storage, and the console passes URLs and storage references through. |
| [`mthds_upload_attachments`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_upload_attachments--hosted-console-only) | console | Turn a file attached in a ChatGPT conversation into a run-ready `pipelex-storage://` reference. |
| [`pipelex_request_upload`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_request_upload--hosted-console-only-called-by-the-view) | console | Issue the one-time upload grant the `run-graph` view's run form uses for a file the user picks; hidden from the model on hosts that honour the MCP Apps `ui.visibility` key. |
| [`mthds_run`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_run--mthds_run_status--mthds_run_results) | both servers | Start a durable run on the hosted Pipelex API and return its `run_id` at once. |
| [`mthds_run_status`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_run--mthds_run_status--mthds_run_results) | both servers | Read a run's lifecycle state by its `run_id`. |
| [`mthds_run_results`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_run--mthds_run_status--mthds_run_results) | both servers | Fetch a run's outcome, and list for free which of its stored files look like images. |
| [`mthds_show_images`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_show_images) | both servers | Show the pictures a completed run produced, as image content that stays in the conversation. |
| [`mthds_download_artifacts`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#saving-a-run-to-disk-local-workshop-only) | workshop | Save a completed run to disk: its output as `main_stuff.json`, and the files it produced. |
| [`mthds_save_method`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_save_method--mthds_get_method--local-workshop-only) | workshop | Validate a bundle and save it to your organization's catalog, linking the directory to the saved method when the bundle was given by path. |
| [`mthds_get_method`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_save_method--mthds_get_method--local-workshop-only) | workshop | Bring a saved method's files back, to disk or inline. |

## The two deployments, and the `{ path }` arm

MCP tool arguments are generated token-by-token by the host LLM — there is no other channel from the conversation to the server. So submitting a bundle's `.mthds` contents to the **hosted** server means the model re-emits every file as output tokens (slow on large bundles, re-paid every repair-loop iteration and every tool in the chain, and not guaranteed byte-identical to what's on disk). The **local** server sidesteps this: the host spawns it in your workspace, so it can read files from disk given only a path.

The shared submitted-files shape accepts two item forms — inline content or a file path:

```ts
type SubmittedFileInput = { content: string; uri?: string | null } | { path: string };
```

Both servers register this same union, so the tool contract never forks; what differs is behavior:

- The **workshop resolves `{ path }` from disk** before invoking the capability — near-constant token cost regardless of bundle size, byte-accurate reads, and real provenance (the resolved item carries `uri` = the submitted path, so diagnostics locate to files you can open and edit). Inline `{ content, uri? }` items stay accepted for parity.
- The **console rejects `{ path }` items** with an instructive `input_domain` error located at `files[i].path`: this deployment cannot read files; resubmit as `{ content, uri? }`, or use the local workshop (`npx @pipelex/mcp`).

An item is one arm or the other; on a malformed item carrying both keys, `content` wins (first-match union semantics) and `path` is ignored.

**Path trust boundary (workshop).** `{ path }` values resolve relative to the server's working directory. Each `{ path }` argument is contracted to one extension, `.mthds` for every bundle argument and `.py` for `mthds_save_method`'s `python`, so any other extension is rejected **before any filesystem access** (a prompt-injected `.env` or key-file path is never opened), and the resolved target (symlinks followed) must live inside the working-directory subtree. `mthds_save_method` adds one more bound: every `{ path }` item must sit at or under the directory of its first `files` item, which must itself be a `{ path }`. A wrong extension, an escape, a missing file and a non-regular file come back as `input_domain` errors located at the item (`files[i].path`, or `python[i].path`).

## Local workshop: start it

The workshop is published on npm as [`@pipelex/mcp`](https://www.npmjs.com/package/@pipelex/mcp). You do not install it: a host spawns it on demand in your project with the command below, and on Claude Code and Codex the [Pipelex plugin](https://github.com/Pipelex/pipelex-plugins) does that for you. Run by hand, it prints nothing and waits for a host on its standard input.

```bash
npx -y @pipelex/mcp
```

It needs Node.js 24.14.1 or later, and a `PIPELEX_API_KEY` in its environment, since every tool calls the hosted Pipelex API: a `plx_sk_` key, which you create in your console at [app.pipelex.com](https://app.pipelex.com). The directory the host starts it in is the boundary for everything it reads and writes on disk. [Registering the workshop in a host](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/hosts.md) gives the configuration for each host, every environment variable the workshop reads, and the rules of that boundary.

## Hosted console: sign in with your Pipelex account

The hosted console holds **no server-side API key** and there is nothing to paste. Add the console in your host by its address, and the host walks you through signing in with your Pipelex account:

```
https://mcp.pipelex.com/mcp
```

That is the address to register, in every host.

Sign-in is OAuth through WorkOS AuthKit, which the console's MCP host drives for you — ChatGPT, claude.ai and Claude Desktop handle the handshake themselves, including picking the organization you want to work in. Your verified session is what authorizes every call the console makes on your behalf, so the catalog you see and the runs you spend are your own. The token never travels through tool arguments, so it never enters the model's context.

There is **no keyless mode**: every tool call requires a signed-in session. If one expires or is revoked, calls come back as a `config` no-verdict at `authorization` telling you to reconnect and sign in again.

On a coding agent, prefer the **local workshop**, which the Pipelex plugin brings — see [Which server, for which host](#which-server-for-which-host).

## Chat attachments (ChatGPT only)

The workshop reads a user's file from disk: a local path given as an input value is uploaded to Pipelex storage by `mthds_prepare_inputs`. The console has no filesystem, so it gets it a different way: **ChatGPT's Apps runtime rewrites the model's reference to an attached file into a signed-URL object** before the call reaches the server. `mthds_upload_attachments` takes that channel — it fetches the bytes server-side and uploads them to Pipelex storage under your signed-in account, returning only small URI strings. **The bytes never enter the model's context**, which is the whole reason console-side upload is allowed here at all.

The flow, on the console:

```
user attaches a PDF in the chat
  → mthds_upload_attachments   → pipelex-storage://… uris
  → fill the uris into the mthds_inputs_template output
  → mthds_run
```

`mthds_prepare_inputs` can be **skipped** — a `pipelex-storage://` value is already run-ready. Nothing else in the flow changes.

What to know before you rely on it:

- **Re-add the console in ChatGPT to get it.** ChatGPT caches a server's tool list when you add it and never refreshes it, so a newly shipped tool (or a changed tool description) stays invisible to an existing installation until you remove the console and add it again.
- **7 MiB per attachment.** This is a transport ceiling, not a product choice: `POST /v1/upload` takes a base64 body behind an AWS API Gateway HTTP API, whose 10 MiB request quota divides by base64's 4/3 inflation to ~7.5 MiB decoded. (The app-level 50 MiB `MAX_UPLOAD_MIB` is unreachable through the public gateway — don't quote it for an attachment. A file picked in the method view's run form never crosses the gateway, and up to 50 MiB it is accepted.) ChatGPT hands over much larger files happily, so expect to meet this; the refusal fires before any bytes are fetched and names the limit.
- **ChatGPT only.** claude.ai injects no file reference into a connector call, and MCP has nothing in-spec. On any other host the model can only fabricate a URL, which [the fetch boundary](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_upload_attachments--hosted-console-only) refuses — that refusal is also the "this host cannot attach files, ask for an `http(s)` URL" diagnostic.

## One host, one server

A host should be connected to **one** Pipelex server, never both. Same tool names on both means a both-installed host has ambiguous routing (nothing guarantees the model picks the local one), contradictory schemas under identical names (the workshop accepts `{ path }`, the console rejects it), and doubled tool registrations for no added capability.

The trap that gets you there without choosing it: **the console added in claude.ai syncs into Claude Code automatically.** A user signed into claude.ai with the console enabled gets the hosted tools in coding sessions alongside the workshop, whether the Pipelex plugin brought it or you registered it by hand. When you run the workshop, turn the console off for those sessions:

- In Claude Code, `/mcp` is the entry point. A connector you haven't signed into is collapsed behind a **"Show unused connectors"** row (Claude Code v2.1.161+) — expand it to find Pipelex.
- Config alternatives: per-project `deniedMcpServers` in `.claude/settings.json`, or global `disableClaudeAiConnectors: true` in user settings.

## Documentation

- [Tools reference](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md): every tool's input, structured result and behavior, and which server registers it.
- [Registering the workshop in a host](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/hosts.md): the configuration for Claude Code, Codex, Cursor, Claude Desktop and Mistral Vibe, the environment variables the workshop reads, and the working directory it is bound to.
- [Developing pipelex-mcp](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/development.md): running the console locally, the build, the test suites and versioning.
- [Client identification](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/client-identification.md): the `User-Agent` every request to the Pipelex API carries, naming this server, its shell and the host behind it.
- [The specification](https://github.com/Pipelex/pipelex-mcp/blob/main/SPEC.md): the source of truth for the full tool contracts, verdict discipline and view behavior.
- [An illustrated overview](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/readme.html) of the two servers, the tool surface, the flow a method takes and the sharp edges, as an HTML page to download and open in a browser.
- [The changelog](https://github.com/Pipelex/pipelex-mcp/blob/main/CHANGELOG.md): what each release shipped.
- [The Pipelex documentation](https://docs.pipelex.com/) and [the MTHDS standard](https://mthds.ai/).

## Develop

To work on this repository, clone it, then:

```bash
make install   # install the dependencies
make check     # lint, formatting, both builds, typecheck, and the text and stylesheet checks
make test      # the hermetic test suite, which never touches the network
```

A coding agent runs `make agent-test` instead of `make test`: the same suite, with its output shown only when a test fails. `make dev-local` runs the workshop from source. [Developing pipelex-mcp](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/development.md) covers running the console locally, the live test suites against the Pipelex API, and versioning, and [the changelog](https://github.com/Pipelex/pipelex-mcp/blob/main/CHANGELOG.md) records what each release shipped.

## License

`@pipelex/mcp` is licensed under the Elastic License 2.0 (ELv2), a source-available license. You may run its servers for your own team or company, on your own infrastructure or in your own cloud account. What the Elastic License 2.0 rules out is offering others a remote MCP server through which they run the methods of their choice, their own or a catalog's. See [LICENSE](https://github.com/Pipelex/pipelex-mcp/blob/main/LICENSE) for the full terms, including notices and redistribution, and the [license page](https://docs.pipelex.com/latest/license/) for how Pipelex reads them.
