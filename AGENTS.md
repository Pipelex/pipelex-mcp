This is the Pipelex workshop, the local stdio MCP server published to npm as `@pipelex/mcp`. `CLAUDE.md` is the map of the repository, and `SPEC.md` is the contract.

After touching code, run `make agent-test` rather than `make test`: it is the same hermetic suite, but it shows output only on failure and prints a heartbeat while it runs, so a green suite costs two lines of your context instead of a few hundred. `make check` is still the pre-flight gate before declaring work done, and `make test-all` is every test including the live ones — it spends inference credit, so run it only when asked.
