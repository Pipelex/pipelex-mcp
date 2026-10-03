# Pipelex MCP

<!-- onboarding: mcp-route -->
<!-- Generated from the Pipelex onboarding source; this region is replaced from https://raw.githubusercontent.com/Pipelex/.github/main/onboarding/rendered/mcp-route.md — do not edit it here. -->
## Get started

Pipelex lets you build AI methods with your coding agent and run them anywhere: as an MCP for chatbots, as a webapp for people, or via API for your software. This repository is the Pipelex MCP: it connects your chatbot to your Pipelex account and the methods saved there.

**Chatbots** — ChatGPT, Claude. Sign up at [app.pipelex.com](https://app.pipelex.com). Add the Pipelex MCP in your chatbot's settings by the address below — in Claude, that is **Add custom connector** — then sign in with your Pipelex account when asked. Nothing to install and no key: the Pipelex MCP runs on your signed-in session.

```
https://mcp.pipelex.com/mcp
```

**Coding agents** — Claude Code, Codex. Install the [Pipelex plugin](https://github.com/Pipelex/pipelex-plugins) instead: it brings the skills that build methods, and its own Pipelex tools, which run your methods and also work with the method files in your project. Claude Code also loads what you have added to your Claude account, so if you added the Pipelex MCP to Claude, Claude Code has it too. An agent with the plugin does not need the Pipelex MCP, and there is nothing to turn off: when both are present, the Pipelex MCP defers to the plugin's tools.

**Then ask your chatbot:**

> What methods do I have?
>
> Run github.com/Pipelex/methods/invoice_extraction@v0.1.1 on https://raw.githubusercontent.com/Pipelex/pipelex-cookbook/main/assets/extract_proof_of_purchase/restaurant_invoice.pdf

You get a run id straight away, and you can ask for its status, its results or the files it produced at any time.

Your new account comes with one method to try. A published method, such as those in the [Pipelex methods repository](https://github.com/Pipelex/methods), runs from its address with nothing to save. Your own methods come from the Pipelex plugin: build one in a coding agent and save it to your account, and your chatbot lists it and runs it by name.

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

## What this repository is

This repository is **the workshop**, the MCP server inside the Pipelex plugin (server name `pipelex-plugin`): an npm-distributed stdio server (`@pipelex/mcp`, bin `pipelex-mcp`) that coding-agent hosts spawn via `npx`. It wraps the Pipelex API through the `@pipelex/sdk` `PipelexApiClient`. Its tools are `mthds_*`: they find a saved method, validate a method, template its inputs, generate typed code for it, prepare its files, run it, look up the model references it can name, and save it to the catalog and pull it back. Its headline feature is the `{ path }` file arm: it reads `.mthds` files from disk instead of having the model hand-copy their contents. It is **tools-first and ships no views on any host**, so it reports structured results and text summaries directly.

The Pipelex MCP for chatbots, at `mcp.pipelex.com`, is the hosted Pipelex connector, a separate product with tools of its own, named `pipelex_*`: see [Chat hosts use the Pipelex connector](#chat-hosts-use-the-pipelex-connector).

## Tools

[The tools reference](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md) gives each tool's input, result and behavior.

| Tool | What it does |
|---|---|
| [`mthds_list_methods`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_list_methods) | List the methods saved in your organization's catalog by name, description and id, never their source. |
| [`mthds_models`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_models) | List the model references a pipe can name, or check one before writing it into a method. |
| [`mthds_validate`](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md#mthds_validate) | Validate a method given as files, a published address or a catalog id, return its main pipe's typed signature, and write its flowchart as an HTML page beside files given by path. |
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

MCP tool arguments are generated token-by-token by the host LLM — there is no other channel from the conversation to the server. So submitting a bundle's `.mthds` contents inline means the model re-emits every file as output tokens (slow on large bundles, re-paid every repair-loop iteration and every tool in the chain, and not guaranteed byte-identical to what's on disk). The workshop sidesteps this: the host spawns it in your workspace, so it can read files from disk given only a path.

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

## Chat hosts use the Pipelex connector

ChatGPT, claude.ai and Claude Desktop do not run this server. They add the Pipelex connector, the hosted Pipelex MCP, by its address:

```
https://mcp.pipelex.com/mcp
```

There is nothing to install and no key to paste: the host walks you through signing in with your Pipelex account, and your signed-in session authorizes every call the connector makes. If you have no Pipelex account yet, create one at [app.pipelex.com](https://app.pipelex.com) before you add the connector, since signing up there also sets up the organization every call works in. The connector is a separate product with its own tools, and this repository does not hold it.

On a coding agent, prefer the workshop, which the Pipelex plugin brings — see [Which server, for which host](#which-server-for-which-host).

## You don't need both

A chat host takes the connector, and a coding agent takes the workshop through the Pipelex plugin; no host needs both. The two share no tool name, so a host that has both can tell them apart, and the workshop's instructions tell the model to use its `mthds_*` tools for all method work whenever the connector's `pipelex_*` tools are also present, and never to mix the two. The connector runs on your sign-in and the workshop on an API key, and the two can select different organizations: a method saved from the workshop is visible from the connector only when both select the same one.

The way to end up with both without choosing it: **the connector added in claude.ai syncs into Claude Code automatically.** A user signed into claude.ai with the connector enabled gets its tools in coding sessions beside the workshop's. That is harmless, but it doubles the tool list for no added capability, so you can turn the connector off for those sessions:

- In Claude Code, `/mcp` is the entry point. A connector you haven't signed into is collapsed behind a **"Show unused connectors"** row (Claude Code v2.1.161+) — expand it to find Pipelex.
- For one project, list it under `deniedMcpServers` in `.claude/settings.json`.

Avoid `disableClaudeAiConnectors: true` for this. It turns off the Pipelex connector, but also every other connector on your Claude account, such as Gmail, Google Drive and Calendar, and those are what an agent uses to fetch a method's inputs from your mail or files and to deliver its results.

## Documentation

- [Tools reference](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/tools.md): every tool's input, structured result and behavior.
- [Registering the workshop in a host](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/hosts.md): the configuration for Claude Code, Codex, Cursor, Claude Desktop and Mistral Vibe, the environment variables the workshop reads, and the working directory it is bound to.
- [Developing pipelex-mcp](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/development.md): the layout, the build, the test suites and versioning.
- [Architecture](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/architecture.md) and [Testing](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/testing.md): how the workshop and its capability core are built, module by module, and how they are tested, the live drift detectors included.
- [Client identification](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/client-identification.md): the `User-Agent` every request to the Pipelex API carries, naming this server and the host behind it.
- [The specification](https://github.com/Pipelex/pipelex-mcp/blob/main/SPEC.md): the source of truth for the full tool contracts and the verdict discipline.
- [The changelog](https://github.com/Pipelex/pipelex-mcp/blob/main/CHANGELOG.md), whose versions are the ones on npm, and which also records every release made before the console and the workshop were split.
- [The Pipelex documentation](https://docs.pipelex.com/) and [the MTHDS standard](https://mthds.ai/).

## Develop

The repository is one package at its root, `@pipelex/mcp`, whose sources are under `src/`: the server and, under `src/capabilities/`, the capability core it is built on. To work on it, clone it, then, from the root:

```bash
make install   # install the dependencies
make check     # lint, formatting, the text budgets, the build and typecheck
make test      # the hermetic test suite, which never touches the network
```

A coding agent runs `make agent-test` instead of `make test`: the same suite, with its output shown only when a test fails. `make dev-local` runs the workshop from source. [Developing pipelex-mcp](https://github.com/Pipelex/pipelex-mcp/blob/main/docs/development.md) covers the layout, the live test suites against the Pipelex API, and how the workshop is versioned and released.

## License

`@pipelex/mcp` is licensed under the Elastic License 2.0 (ELv2), a source-available license. You may run it for your own team or company, on your own infrastructure or in your own cloud account. What the Elastic License 2.0 rules out is offering others a remote MCP server through which they run the methods of their choice, their own or a catalog's. See [LICENSE](https://github.com/Pipelex/pipelex-mcp/blob/main/LICENSE) for the full terms, including notices and redistribution, and the [license page](https://docs.pipelex.com/latest/license/) for how Pipelex reads them.
