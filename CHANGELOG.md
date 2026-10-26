# Changelog

This is the changelog of the workshop, `@pipelex/mcp` on npm: the MCP server the Pipelex plugin runs.

## [Unreleased]

## [0.27.1] - 2026-10-26

### Highlights

- **The workshop connects coding agents to Pipelex methods.** `@pipelex/mcp` is the local stdio MCP server the Pipelex plugin runs for coding agents such as Claude Code, Codex and Cursor. Its `mthds_*` tools work on MTHDS methods through the hosted Pipelex API: they find a saved method and the files the organization holds, validate a method, template and prepare its inputs, run it and fetch its results and files, generate typed code for it, list the model references it can name, and save it to the catalog, pull it back and publish it. A method-taking tool can read the method from disk, as its folder or its files, so the model never copies their contents by hand.
- **It is licensed under the Elastic License 2.0.** The license is source-available: you may run the workshop for your own team or company, on your own infrastructure or in your own cloud account, and `LICENSE` gives the full terms.
