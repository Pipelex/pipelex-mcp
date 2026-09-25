# Pipelex MCP

<!-- onboarding: mcp-route -->
<!-- Generated from the Pipelex onboarding source; this region is replaced from https://raw.githubusercontent.com/Pipelex/.github/main/onboarding/rendered/mcp-route.md — do not edit it here. -->
## Get started

Pipelex lets you build AI methods with your coding agent and run them anywhere: as an MCP for chatbots, as a webapp for people, or via API for your software. This repository is the Pipelex MCP: it connects your chatbot to your Pipelex account and the methods saved there.

**Chatbots** — ChatGPT, Claude. Add the Pipelex MCP in your chatbot's settings by the address below — in Claude, that is **Add custom connector** — then sign in with your Pipelex account when asked. Nothing to install and no key: the Pipelex MCP runs on your signed-in session.

```
https://mcp.pipelex.com/mcp
```

**Coding agents** — Claude Code, Codex. Install the [Pipelex plugin](https://github.com/Pipelex/pipelex-plugins) instead: it brings the skills that build methods, and its own Pipelex tools, which run your methods and also work with the method files in your project. Claude Code also loads what you have added to your Claude account, so if you added the Pipelex MCP to Claude, Claude Code has it too. An agent with the plugin does not need the Pipelex MCP, and there is nothing to turn off: when both are present, the Pipelex MCP defers to the plugin's tools.

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

A host needs one of two things, not both: the Pipelex plugin on a coding agent, the Pipelex MCP on a chatbot. The table applies that rule host by host. [You don't need both](#you-dont-need-both) says what happens when the Pipelex MCP added in Claude reaches Claude Code without anyone choosing it.

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

Pipelex MCP connects MCP hosts to Pipelex methods, wrapping the Pipelex API through the `@pipelex/sdk` `PipelexApiClient`. It ships as **two servers with two tool sets, over one capability core**:

- **The console**, the Pipelex connector (server name `pipelex`): a [Skybridge](https://docs.skybridge.tech) HTTP server, deployed on Alpic, for chat hosts. Its tools are `pipelex_*`, and it names a method by reference only, a saved method's catalog id or a published method's address: it finds a method, shows it, takes a file attached in the chat, and runs it. It registers the Skybridge views.
- **The workshop**, the Pipelex plugin's server (server name `pipelex-plugin`): an npm-distributed stdio server (`@pipelex/mcp`, bin `pipelex-mcp`) that coding-agent hosts spawn via `npx`. Its tools are `mthds_*`, and they also validate a method, template its inputs, generate typed code for it, prepare its files, and save it to the catalog and pull it back. Its headline feature is the `{ path }` file arm: it reads `.mthds` files from disk instead of having the model hand-copy their contents.

The console is the Pipelex MCP of the get-started above, at `mcp.pipelex.com`, and the workshop is the MCP server the Pipelex plugin runs. The rest of this page calls them by the names the code uses. The two are released separately, each with its own version and changelog.

## Tools

Each server registers its own tools, and no tool name is registered by both. [The tools reference](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md) gives each tool's input, result and behavior.

The console's tools:

| Tool | What it does |
|---|---|
| [`pipelex_list_methods`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_list_methods) | List the methods saved in your organization's catalog by name, description and id, never their source. |
| [`pipelex_show_method`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_show_method) | Show a saved or published method before running it: its signature and a fill-in inputs template for the model, and on a host that renders views, its graph and an input form with a Run button for you. |
| [`pipelex_upload_attachments`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_upload_attachments) | Turn a file attached in a ChatGPT conversation into a run-ready `pipelex-storage://` reference. |
| [`pipelex_run`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_run) | Start a durable run of a method named by its id or its address, and return its `run_id` at once; file inputs are URLs or storage references. |
| [`pipelex_run_status`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_run_status--pipelex_run_results) | Read a run's lifecycle state by its `run_id`. |
| [`pipelex_run_results`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_run_status--pipelex_run_results) | Fetch a run's outcome, and list for free which of its stored files look like images. |
| [`pipelex_show_images`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_show_images) | Show the pictures a completed run produced, as image content that stays in the conversation. |
| [`pipelex_request_upload`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_request_upload) | Issue the one-time upload grant the `run-graph` view's run form uses for a file the user picks; hidden from the model on hosts that honour the MCP Apps `ui.visibility` key. |

The workshop's tools:

| Tool | What it does |
|---|---|
| [`mthds_list_methods`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_list_methods) | List the methods saved in your organization's catalog by name, description and id, never their source. |
| [`mthds_validate`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_validate) | Validate a method given as files, a published address or a catalog id, and return its main pipe's typed signature. |
| [`mthds_inputs_template`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_inputs_template) | Return a fill-in template of a pipe's declared inputs. |
| [`mthds_codegen`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_codegen) | Generate typed TypeScript or Python for a method's concepts, stamped and locked, returned or written straight to disk. |
| [`mthds_prepare_inputs`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_prepare_inputs) | Make filled inputs run-ready, uploading local files to Pipelex storage. |
| [`mthds_run`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_run--mthds_run_status--mthds_run_results) | Start a durable run on the hosted Pipelex API from files, an address or an id, and return its `run_id` at once. |
| [`mthds_run_status`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_run--mthds_run_status--mthds_run_results) | Read a run's lifecycle state by its `run_id`. |
| [`mthds_run_results`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_run--mthds_run_status--mthds_run_results) | Fetch a run's outcome, and list for free which of its stored files look like images. |
| [`mthds_show_images`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_show_images) | Show the pictures a completed run produced, as image content that stays in the conversation. |
| [`mthds_download_artifacts`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_download_artifacts) | Save a completed run to disk: its output as `main_stuff.json`, and the files it produced. |
| [`mthds_save_method`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_save_method--mthds_get_method) | Validate a bundle and save it to your organization's catalog, linking the directory to the saved method when the bundle was given by path. |
| [`mthds_get_method`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_save_method--mthds_get_method) | Bring a saved method's files back, to disk or inline. |

## Files on the workshop, by path

MCP tool arguments are generated token-by-token by the host LLM — there is no other channel from the conversation to the server. So submitting a bundle's `.mthds` contents inline means the model re-emits every file as output tokens (slow on large bundles, re-paid every repair-loop iteration and every tool in the chain, and not guaranteed byte-identical to what's on disk). The workshop sidesteps this: the host spawns it in your workspace, so it can read files from disk given only a path. The console takes no files at all, since a chatbot runs a saved or published method by reference.

The workshop's files-taking tools accept two item forms — inline content or a file path:

```ts
type SubmittedFileInput = { content: string; uri?: string | null } | { path: string };
```

The workshop resolves `{ path }` items from disk before invoking the capability — near-constant token cost regardless of bundle size, byte-accurate reads, and real provenance (the resolved item carries `uri` = the submitted path, so diagnostics locate to files you can open and edit). Inline `{ content, uri? }` items stay accepted, for a bundle the agent holds only in the conversation. An item is one arm or the other; on a malformed item carrying both keys, `content` wins (first-match union semantics) and `path` is ignored.

**Path trust boundary.** `{ path }` values resolve relative to the server's working directory. Each `{ path }` argument is contracted to one extension, `.mthds` for every bundle argument and `.py` for `mthds_save_method`'s `python`, so any other extension is rejected **before any filesystem access** (a prompt-injected `.env` or key-file path is never opened), and the resolved target (symlinks followed) must live inside the working-directory subtree. `mthds_save_method` adds one more bound: every `{ path }` item must sit at or under the directory of its first `files` item, which must itself be a `{ path }`. A wrong extension, an escape, a missing file and a non-regular file come back as `input_domain` errors located at the item (`files[i].path`, or `python[i].path`).

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

The workshop reads a user's file from disk: a local path given as an input value is uploaded to Pipelex storage by `mthds_prepare_inputs`. The console has no filesystem, so it gets it a different way: **ChatGPT's Apps runtime rewrites the model's reference to an attached file into a signed-URL object** before the call reaches the server. `pipelex_upload_attachments` takes that channel — it fetches the bytes server-side and uploads them to Pipelex storage under your signed-in account, returning only small URI strings. **The bytes never enter the model's context**, which is the whole reason console-side upload is allowed here at all.

The flow, on the console:

```
user attaches a PDF in the chat
  → pipelex_upload_attachments   → pipelex-storage://… uris
  → fill the uris into pipelex_show_method's inputs template
  → pipelex_run
```

A `pipelex-storage://` value is already run-ready, so `pipelex_run` takes it as it is. Nothing else in the flow changes.

What to know before you rely on it:

- **Re-add the console in ChatGPT to get it.** ChatGPT caches a server's tool list when you add it and never refreshes it, so a newly shipped tool (or a changed tool description) stays invisible to an existing installation until you remove the console and add it again. An installation older than the console's `pipelex_*` tools calls names that no longer exist, and each answers with that same instruction.
- **7 MiB per attachment.** This is a transport ceiling, not a product choice: `POST /v1/upload` takes a base64 body behind an AWS API Gateway HTTP API, whose 10 MiB request quota divides by base64's 4/3 inflation to ~7.5 MiB decoded. (The app-level 50 MiB `MAX_UPLOAD_MIB` is unreachable through the public gateway — don't quote it for an attachment. A file picked in the method view's run form never crosses the gateway, and up to 50 MiB it is accepted.) ChatGPT hands over much larger files happily, so expect to meet this; the refusal fires before any bytes are fetched and names the limit.
- **ChatGPT only.** claude.ai injects no file reference into a connector call, and MCP has nothing in-spec. On any other host the model can only fabricate a URL, which [the fetch boundary](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#pipelex_upload_attachments) refuses — that refusal is also the "this host cannot attach files, ask for an `http(s)` URL" diagnostic.

## You don't need both

A chat host takes the console, and a coding agent takes the workshop through the Pipelex plugin; no host needs both. The two share no tool name, so a host that has both can tell them apart, and both servers' instructions tell the model to use the plugin's `mthds_*` tools for all method work whenever they are present, and never to mix the two. The console runs on your sign-in and the workshop on an API key, and the two can select different organizations: a method saved from the workshop is visible from the console only when both select the same one.

The way to end up with both without choosing it: **the console added in claude.ai syncs into Claude Code automatically.** A user signed into claude.ai with the console enabled gets the connector's tools in coding sessions beside the workshop's. That is harmless, but it doubles the tool list for no added capability, so you can turn the console off for those sessions:

- In Claude Code, `/mcp` is the entry point. A connector you haven't signed into is collapsed behind a **"Show unused connectors"** row (Claude Code v2.1.161+) — expand it to find Pipelex.
- Config alternatives: per-project `deniedMcpServers` in `.claude/settings.json`, or global `disableClaudeAiConnectors: true` in user settings.

## Documentation

- [Tools reference](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md): every tool's input, structured result and behavior, and which server registers it.
- [Registering the workshop in a host](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/hosts.md): the configuration for Claude Code, Codex, Cursor, Claude Desktop and Mistral Vibe, the environment variables the workshop reads, and the working directory it is bound to.
- [Developing pipelex-mcp](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/development.md): running the console locally, the build, the test suites and versioning.
- [Client identification](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/client-identification.md): the `User-Agent` every request to the Pipelex API carries, naming this server, its shell and the host behind it.
- [The specification](https://github.com/Pipelex/pipelex-mcp/blob/main/SPEC.md): the source of truth for the full tool contracts, verdict discipline and view behavior.
- [An illustrated overview](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/readme.html) of the two servers, the tool surface, the flow a method takes and the sharp edges, as an HTML page to download and open in a browser.
- The changelogs, one per server, since each is released on its own: [the workshop's](https://github.com/Pipelex/pipelex-mcp/blob/main/packages/workshop/CHANGELOG.md), whose versions are the ones on npm and which also records every release made before the two were split, and [the console's](https://github.com/Pipelex/pipelex-mcp/blob/main/packages/console/CHANGELOG.md).
- [The Pipelex documentation](https://docs.pipelex.com/) and [the MTHDS standard](https://mthds.ai/).

## Develop

The repository is an npm workspace of three packages: the capability core both servers are built from, the workshop and the console, under `packages/`. To work on it, clone it, then, from the root:

```bash
make install   # install the dependencies
make check     # lint, formatting, both builds, typecheck, and the text and stylesheet checks
make test      # the hermetic test suite, which never touches the network
```

A coding agent runs `make agent-test` instead of `make test`: the same suite, with its output shown only when a test fails. `make dev-local` runs the workshop from source. [Developing pipelex-mcp](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/development.md) covers the layout, running the console locally, the live test suites against the Pipelex API, and how each server is versioned and released.

## License

`@pipelex/mcp` is licensed under the Elastic License 2.0 (ELv2), a source-available license. You may run its servers for your own team or company, on your own infrastructure or in your own cloud account. What the Elastic License 2.0 rules out is offering others a remote MCP server through which they run the methods of their choice, their own or a catalog's. See [LICENSE](https://github.com/Pipelex/pipelex-mcp/blob/main/LICENSE) for the full terms, including notices and redistribution, and the [license page](https://docs.pipelex.com/latest/license/) for how Pipelex reads them.
