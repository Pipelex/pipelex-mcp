# Changelog

This is the changelog of the hosted console: the Pipelex MCP that chat hosts reach at `https://mcp.pipelex.com/mcp`, deployed to Alpic. Up to and including 0.19.0 the console was released together with the workshop, `@pipelex/mcp`, under one version, and those releases are recorded in [the workshop's changelog](../workshop/CHANGELOG.md). After 0.19.0 the console has its own version, this changelog, and `console-vX.Y.Z` tags.

## [Unreleased]

### Changed

- **The console is released on its own track**: Its version, this changelog and the `console-vX.Y.Z` tags now describe the console alone. A console release deploys to Alpic without publishing to npm, and a workshop release no longer deploys the console.

- **`@pipelex/sdk` 0.24.0 → 0.25.1**: The SDK dropped a gateway-key surface this server never called, so nothing here changes; the bump keeps the console release on the current client.

- **The console is the Pipelex connector, with its own `pipelex_*` tools (Breaking)**: The hosted console now reports the server name `pipelex` instead of `pipelex-mcp`, registers `pipelex_list_methods`, `pipelex_show_method`, `pipelex_upload_attachments`, `pipelex_run`, `pipelex_run_status`, `pipelex_run_results`, `pipelex_show_images` and the app-only `pipelex_request_upload`, and names a method by its catalog id or its published address only: `pipelex_show_method` returns the signature and a fill-in inputs template and, on a host that renders views, the graph and the run form, while `pipelex_run` checks its own file inputs, which take an `http(s)` URL or a `pipelex-storage://` reference. Its instructions now differ between a host that shows the form and one that does not. **Every existing connector installation must remove the Pipelex connector and add it again, once**: until then its cached tool list calls the old `mthds_*` names, which run nothing and answer with that same instruction.

### Fixed

- **A start that may have created a run is no longer marked retryable**: When `pipelex_run` fails with a timeout, a connection lost after the request went out, or a 502 or 504, its error now carries `retryable: false` and a hint that the run may have started, because starting it again would be a second run spending inference credit. A connection refused before anything was sent stays retryable.

### Removed

- **Validation, inputs templates, code generation, input preparation and file arguments on the console (Breaking)**: `mthds_validate`, `mthds_inputs_template`, `mthds_codegen` and `mthds_prepare_inputs` are gone from the hosted console, and no console tool takes `files` or `output_dir` any more. All of them remain on the workshop, the Pipelex plugin's server.

## [0.19.0] - 2026-09-24

Released together with the workshop as `@pipelex/mcp` 0.19.0, whose entry in [the workshop's changelog](../workshop/CHANGELOG.md#0190---2026-09-24) records this release and every earlier one.
