# Changelog

## [v0.1.6] - 2025-11-26

- Bump `pipelex` to `v0.17.1`: See `Pipelex` changelog [here](https://docs.pipelex.com/changelog/)

## [v0.1.5] - 2025-11-18

### Feature

- Added a tool to list available pipes.

## [v0.1.4] - 2025-11-18

### Changed

- Output of pipe builder can now be changed from the pipelex config: `builder_config`. Defaults to `pipeline_{number}/` based on the number of use of the pipe builder tool.
- Bumped pipelex to `v0.15.7`

### Added

- Properly handle logs to stderr to avoid conflicting with MCP transport on stdout.
- Added a pipeline to handle inputs of pipes.

## [v0.1.3] - 2025-11-14

### Changed

- Bumped pipelex to v0.15.4
- Changed the `.cursor/mcp.json` file to use relative path to the pipelex-mcp project.

## [v0.1.2] - 2025-11-04

### Added

- Added documentation for the MCP server.

## [v0.1.1] - 2025-10-27

### Added

- Added the pipe builder in the MCP server.
- Added a tool to run a pipelex pipeline.
- Added GHA for CLA, and other.

### Changed

- Bumped pipelex to v0.14.0


## [v0.0.5] - 2025-07-09

- Bumped pipelex to v0.5.1

## [v0.0.4] - 2025-07-09

- Bumped pipelex to v0.5.0

## [v0.0.3] - 2025-06-06

- Bumped pipelex to v0.2.14: generalized the new `execute_pipeline` method, enabling to track pipelines from beginning to end with inference cost reporting

## [v0.0.2] - 2025-05-30

- Added tests folder and GHA and fixed makefile (runtests -> gha-tests)
- bumped pipelex version from 0.2.8 to 0.2.9
- Added GHA for changelog: a changelog must be present before merging to main

## [v0.0.1] - 2025-05-30

- Initial release 🎉
