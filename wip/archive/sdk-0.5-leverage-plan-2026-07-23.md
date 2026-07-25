# Leveraging @pipelex/sdk 0.5.x — upload, cost, and by-id inputs prep

> **Superseded 2026-07-23.** The SDK-side work this memo proposed (§3) shipped in `@pipelex/sdk` **0.6.0** — `getMethodClosure`, exported `methodSourceToContents`, and `method_id` on `prepareInputs`/`buildInputs`. Live execution moved to `TODOS.md` (3 phases, retire-first ordering); the rationale lives on in the SDK/platform handoffs (`../pipelex-sdk-js/wip/method-id-closure-resolution.md`, `../wip/method-id-native-tooling-routes/`). Kept for origin context only — the targets below are stale (`^0.5.1`, and §3 is written as future work that is now done).

Context: `pipelex-mcp` pins `@pipelex/sdk` `^0.4.0`. `0.5.1` is live on npm and carries two things we want — signature-driven upload (`prepareInputs`) and per-call token usage + USD cost (`tokens_usages`). This is the plan to adopt them *right*, before we distribute.

**Prereq for everything:** bump `@pipelex/sdk` `^0.4.0` → `^0.5.1`, validated with `make check` + tests (the new surface is additive).

## 1. Token usage + cost — do now, standalone

- The SDK's `RunResults` already carries `tokens_usages: TokensUsageRecord[]` (token counts by category, computed `cost` in USD, model id, `pipe_code`) plus a `usage_assembly_error` companion — branch on that, not on the list being null.
- `mthds_run_results` already receives this object from `getRunResult` and **drops it**. Project it: a bounded per-pipe/total cost view into `structuredContent` + a summary line; the full record list to the view-only `_meta` channel.
- No dependency on the upload work. Ships as its own small PR (SPEC + schema + README + changelog).

## 2. Upload / `prepareInputs` — files path now, by-id after §3

- `prepareInputs({ files, pipe_ref?, inputs })` uploads file-bearing inputs to storage and rewrites them to `pipelex-storage://`; `http(s)` and existing `pipelex-storage://` pass through unchanged. This backs the reserved `mthds_prepare_inputs` tool.
- The files-based path works on the bump. The per-deployment boundary is already reserved in `SPEC.md` (workshop prepares local paths/bytes within its asset boundary; console refuses instructively, URLs/storage-URIs pass through) and matches the SDK contract exactly.

## 3. By-id closure resolution — SDK-side first (the elegant leverage point)

- `prepareInputs` needs inline `files`; the SDK explicitly **defers** resolving a closure from a catalog `method_id`.
- The parse of the polymorphic stored `MethodData.mthds` → `MthdsFileItem[]` already lives in two places: pipelex-platform's `execution.py` (canonical) and pipelex-mcp's `capabilities/method-source.ts` (a mirror, already flagged as a drift hazard). The SDK has `getMethod` but no parser.
- **Do the SDK work first:** add a canonical closure-resolution helper to `@pipelex/sdk` (the TS counterpart of `execution.py`: `getMethod` + the `MethodData.mthds` parser), and let `prepareInputs` / `buildInputs` accept `method_id`.
- Payoff: `mthds_prepare_inputs` is by-id-capable from day one with **no throwaway third fetch-and-forward leg**, and the MCP can retire `method-source.ts` across *all* its by-id tools (`mthds_validate`, `mthds_inputs_template`, `mthds_prepare_inputs`) once the helper exists.
- Ultimate direction (bigger, platform-side, not now): `/v1/build/inputs` and `/v1/validate` accept `method_id` natively like `/v1/start` already does, retiring fetch-and-forward everywhere. Design the SDK helper to be swappable for that later.

## Sequencing

1. Bump SDK to `^0.5.1`.
2. Surface token usage + cost in `mthds_run_results` (standalone).
3. SDK: canonical `MethodData.mthds` closure helper + `method_id` on `prepareInputs` / `buildInputs`.
4. MCP: build `mthds_prepare_inputs` (files + by-id), retire `method-source.ts`.
