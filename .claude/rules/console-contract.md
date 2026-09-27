---
paths:
  - "packages/console/src/server.ts"
  - "packages/console/src/hosted/**"
  - "packages/core/src/capabilities/attachments.ts"
  - "packages/core/src/capabilities/tool-names.ts"
---

# The console's contract

The console is what chat hosts connect to as the Pipelex connector, and ChatGPT **caches a connector's tool list and each view's CSP when the connector is added, and never refreshes them**. A defect in what the console shows a host before a tool call therefore stays in every existing install until each user removes the connector and adds it again. Treat everything below with the rigour of a schema change. SPEC.md's part "The console's contract" is the contract; `docs/architecture.md` has the module accounts.

- **`hosted/console.contract.json` pins, byte for byte, everything the console shows a host before a tool call**: the `initialize` result, `tools/list`, and `resources/list`, where the views' CSP lives. A diff to it is a contract change that strands every ChatGPT install until the connector is re-added. Update it with `npx vitest run -u` only for a change you meant, and say "re-add the connector" in the console's changelog entry.
- **The `pipelex_upload_attachments` description is mechanism, not documentation, and cannot be hot-fixed.** ChatGPT gates the attachment substitution on the description as well as on the schema — a defensive wording measurably yields empty calls that look like a host failure. The emitted four-field JSON Schema and the `openai/fileParams` key are the substitution mechanism itself, and `hosted/server.test.ts` asserts on both; keep the local mirror of the attachment schema byte-identical to Skybridge's `FileRef`.
- **A tool is a definition in `hosted/tools.ts` and a link in the `.registerTool` chain in `hosted/server.ts`.** The chain is what types `AppType`, which the views' `useToolInfo` / `useCallTool` read, so the console's table is not registered in a loop. `hosted/server.test.ts` fails when an exported definition has no link, since the snapshot would not move and no linter flags an unused export.
- **No tool name is shared with the workshop**, and every tool name the core writes into a console text comes from `CONSOLE_TOOL_NAMES` in `capabilities/tool-names.ts`. `hosted/server.test.ts` fails on a workshop tool name in any console text or schema.
- **`RETIRED_TOOL_NAMES` answers the pre-rename `mthds_*` names**, which a cached ChatGPT tool list still calls, with an error telling the user to remove the Pipelex connector and add it again. Keep it.
- **Auth is per-user OAuth and nothing else.** `hosted/contexts.ts` lifts the caller's verified token into `apiKey` on every capability context, unconditionally, so a server-held `PIPELEX_API_KEY` never funds a signed-in caller's work. The tokenless branch exists only to fail closed and sets `apiKey` to the **empty string, never `undefined`**: `PipelexApiClient` reads `options.apiKey ?? process.env.PIPELEX_API_KEY`, so an absent key would borrow the deployment's. `contexts.test.ts` pins this on the wire. The token rides the transport only, never a tool argument.
- **Never log request `_meta`.** ChatGPT attaches `openai/userLocation` (city, region, country, timezone, latitude and longitude) and stable `openai/subject`, `openai/session` and `openai/organization` identifiers to every `tools/call`.
- **Every bucket source in `hosted/app-buckets.ts` is one bucket's own host, a plain origin.** A path-style source (`s3.<region>.amazonaws.com/<bucket>/…`) must never come back: its origin alone would admit every bucket in the region. Adding a source changes the views' CSP, which ChatGPT has cached.
- **Every model-facing text is budgeted.** `check:tool-texts` holds the server instructions and each tool description to 1,800 code points; field descriptions and result summaries are not measured, so keep each to what its layer owns. The instructions are the map, a tool description says when to call it, a field description carries parameter detail, and a result summary carries what matters after a call — the one layer that reaches an install whose tool list is cached.
