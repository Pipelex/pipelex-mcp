# Changelog

This is the changelog of the workshop, `@pipelex/mcp` on npm: the MCP server the Pipelex plugin runs.

## [Unreleased]

### Added

- **`login --label <name>`**: `npx -y @pipelex/mcp@latest login --label <name>` passes the Pipelex app a key label, and the app then replaces your key of that label in the active organization, which stops working, or creates one with that label when you hold none, so repeated logins under one label keep one live key instead of adding one each time. The label is trimmed and must be 1 to 64 characters, with no control characters and not starting with `plx_sk_`, and the command refuses any other before it opens the browser; `--paste` takes no label. A login without a label still creates a new key each time.

### Changed

- **The login says what the page waits for**: the browser login now prints that the page creates nothing until you click "Create the key", or "Replace the key" when a labelled login replaces one, and the message for a key that never arrived says it may have been created once you confirmed it.

### Fixed

- **The pasted login's warning for a key it could not check**: when `login --paste` saves a key the API could not check, the warning now says to run `login --paste` again if a tool call refuses it, instead of the browser login, which is what a machine that needs `--paste` cannot use.

## [0.27.2] - 2026-10-26

### Changed

- **The README opens on the workshop's get-started**: the README was titled "Pipelex MCP" and opened by calling this repository the Pipelex MCP that connects your chatbot to your Pipelex account, which is the hosted Pipelex connector, a separate product. It is now titled `pipelex-mcp` and opens with a get-started for coding agents: it says the repository holds the Pipelex tools the Pipelex plugin brings, walks through signing up, installing the plugin in Claude Code or Codex and asking the agent for a first method, and sends chatbots to the connector by its address in one line.
- **A tool call without arguments**: a `tools/call` request that omits `arguments` is now validated as empty arguments, so a tool whose fields are all optional runs instead of refusing it, and a tool with a required field still refuses it.

### Security

- **Minimum `@modelcontextprotocol/sdk` and `zod` versions**: the workshop now requires `@modelcontextprotocol/sdk` 1.32.0 or later and `zod` 4.6.6 or later, the first releases that fix their published security advisories, so installing it always brings the fixed releases. The `zod` fix is the one that reaches the workshop: a tool call whose arguments carry a very large array that fails validation could exhaust the server's memory. The `@modelcontextprotocol/sdk` advisories concern its HTTP transports, its OAuth client, bearer authentication and experimental tasks, none of which the workshop's stdio server uses.

## [0.27.1] - 2026-10-26

### Highlights

- **The workshop connects coding agents to Pipelex methods.** `@pipelex/mcp` is the local stdio MCP server the Pipelex plugin runs for coding agents such as Claude Code, Codex and Cursor. Its `mthds_*` tools work on MTHDS methods through the hosted Pipelex API: they find a saved method and the files the organization holds, validate a method, template and prepare its inputs, run it and fetch its results and files, generate typed code for it, list the model references it can name, and save it to the catalog, pull it back and publish it. A method-taking tool can read the method from disk, as its folder or its files, so the model never copies their contents by hand.
- **It is licensed under the Elastic License 2.0.** The license is source-available: you may run the workshop for your own team or company, on your own infrastructure or in your own cloud account, and `LICENSE` gives the full terms.
