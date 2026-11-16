# Changelog

This is the changelog of the workshop, `@pipelex/mcp` on npm: the MCP server the Pipelex plugin runs.

## [0.29.0] - 2026-11-16

### Added

- **Stored texts in `mthds_run_results`**: a large `Text`, `Markdown`, `Html` or `JSON` value the run kept in storage, which the output carries as its reference (`url`, `size`, `mime_type`, `preview`), is shown as that reference and never loaded into the result; the new `stored_texts` member lists each one by the path of its `url` (`field`, absent should no path be recorded), with its size and MIME type, the summary names them, and they are no longer counted as stored files.
- **Stored texts in `mthds_download_artifacts`**: each stored text of the output is saved beside `main_stuff.json`, in the same download as the files, as a text file named after its field with the extension of its MIME type (`.txt`, `.md`, `.html` or `.json`), and listed in the new `texts` member, apart from the files in `artifacts`.

### Changed

- **Results reads ask for the concept facts when the output may hold a stored text**: `mthds_run_results` and `mthds_download_artifacts` read the run's `working_memory`, `output_form` and `input_form` by a second read when `main_stuff` holds something shaped like a stored text's reference, to tell a stored text from a stored file by the concept the output names at each position; an output that holds none costs one read, as before. That second read never fails the call: when it fails, or the results name no concept, a reference shaped like a stored text's (a `url` with a `size` or a `preview` and no value) is taken for a stored text, every other one for a file, and the summary says so.
- **A stored text is never an image candidate**, whatever its storage key: `mthds_run_results` and `mthds_show_images` read the candidates from the output alone, leaving out every reference shaped like a stored text's, so an index names the same picture in both tools whatever a concept read did, and `mthds_show_images` makes no concept read.
- **`@pipelex/sdk` 0.69.0 and `mthds` 0.34.0**: the workshop moves from `@pipelex/sdk` 0.53.0 and `mthds` 0.33.0, so a stored text is told from a stored file by the SDK's own walk, and the problems built for the codes a run can raise carry the standard's new titles and next steps, such as "A step's result does not have the structure the method declares" for `pipe.output_invalid`; the results, image and download tools read a run with its stored texts left as references, never loaded.
- **`mthds_publish_method` relays every refusal reason (Breaking)**: `reason` on a `refused` verdict is any string the platform names, no longer only `invalid` or `not_runnable`, so a public method's thumbnail or storage-reference refusal arrives as a verdict whose `message` says what to change; the summary of a reason the workshop does not know relays that message alone, prescribing no draft save.
- **`mthds_get_method` refuses another organization's public method**: such a method has no draft, and only its owner can write it, so the pull answers `client.argument_invalid` at `method_id`, writing nothing, and says to run it by its id instead. A method read counts as the caller's own only when it carries a string draft token (`updated_at`).

## [0.28.0] - 2026-11-01

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
