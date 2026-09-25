# Changelog

This is the changelog of the hosted console: the Pipelex MCP that chat hosts reach at `https://mcp.pipelex.com/mcp`, deployed to Alpic. Up to and including 0.20.0 the console was released together with the workshop, `@pipelex/mcp`, under one version, and those releases are recorded in [the workshop's changelog](../workshop/CHANGELOG.md). After 0.20.0 the console has its own version, this changelog, and `console-vX.Y.Z` tags.

## [Unreleased]

### Added

- **A run's output in the method form's view**: A run started from the `run-graph` view's form now shows its results in the form's place once it completes, with the executed graph replacing the dry-run one and the form folded behind "Edit inputs and run again". The user no longer has to ask the assistant to fetch the results. The view keeps the run in host-persisted view state, so reopening the conversation shows the run's results again, with the form on the pipe that ran; each press of Run clears that state first, so a failed start never brings an older run back. Run stays disabled until the results are read, or until their fetch gives up after a little over two minutes of reads and says so.

### Changed

- **The console is released on its own track**: Its version, this changelog and the `console-vX.Y.Z` tags now describe the console alone. A console release deploys to Alpic without publishing to npm, and a workshop release no longer deploys the console.
- **Both run views render the output with the form kernel's result viewer**: `run-graph` and `run-follow` share one results panel, which shows the run's duration and cost on its header line and the full output through `StuffViewer` (a structure as a grid, a list as a table, images and document previews in place, with its Rendered / JSON switch), in place of the JSON dump or single image `run-follow` used to show. The executed graph moved to fullscreen in `run-follow`. An output over 256 KiB serialized shows its bounded copy as JSON instead, and the kernel's Download control is hidden, since a host's sandboxed frame blocks it.
- **The form's run sends the assistant no completion message**: A run started from the form no longer hands the conversation to the model when it ends, since the user reads the output in the view; "Summarize in chat" sends the same request on demand. A run the assistant started still hands the conversation back.
- **Both views' content security policy names the storage buckets for images and frames**: `run-graph` gains the app buckets as `resourceDomains`, and both views gain them as `frameDomains` for a document's preview. This changes the view resources, not the tool list; if an existing ChatGPT connector keeps the old policy, remove and re-add it.

### Fixed

- **A run's output images were refused by the views' content security policy**: The runtime signs output links path-style on the regional S3 endpoint (`s3.us-west-2.amazonaws.com/<bucket>/…`), while the policy named only each bucket's virtual-hosted host, so no output image could load in `run-follow`. The policy now names each app bucket as a path on the regional endpoint, beside the virtual-hosted hosts, and never the shared endpoint alone.

## [0.20.0] - 2026-09-25

Released together with the workshop as `@pipelex/mcp` 0.20.0, the release that made the console the Pipelex connector, with its own `pipelex_*` tools. Its entry in [the workshop's changelog](../workshop/CHANGELOG.md#0200---2026-09-25) records this release and every earlier one.
