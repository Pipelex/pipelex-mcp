# TODOS — Adopt `@pipelex/sdk` 0.6.0: retire the parser mirror, build `prepare_inputs`, surface run cost

Build plan recorded 2026-07-23. Three sequential phases, smallest/safest first: **(1) retire `method-source.ts`** onto the SDK's canonical closure helper → **(2) spec + build `mthds_prepare_inputs`** (the upload feature) → **(3) surface token usage + cost in `mthds_run_results`**. Rationale and the leverage-point analysis live in the SDK-side and platform-side handoffs (`../pipelex-sdk-js/wip/method-id-closure-resolution.md`, `../wip/method-id-native-tooling-routes/`); the superseded origin memo is archived at `wip/archive/sdk-0.5-leverage-plan-2026-07-23.md`.

**Cold-start for a new session**: read `CLAUDE.md`, `SPEC.md` (Inputs Template Scope + Run Scope + Non-Goals), `wip/sdk-0.5-leverage-plan.md`, then this file top to bottom. Invoke the `skybridge` skill per `AGENTS.md` before touching code. The premise below was verified against live code on 2026-07-23.

## Cross-cutting constraints — read before any phase

- **SDK 0.6.0 is not published yet.** We develop against a local `file:` link (`make use-local-sdk`, currently active — `package.json`/`package-lock.json` point `@pipelex/sdk` at `../pipelex-sdk-js`, whose built `dist/` carries the 0.6.0 code even though its `package.json` still reads `0.5.1`). **`make check` refuses under the link** (the `check-no-local-deps` guard) — validate with the individual targets instead: `npm run build` (regenerates the Skybridge view registry), then `npm run typecheck`, then `npm test`. Rebuild the SDK (`cd ../pipelex-sdk-js && npm run build`) after pulling SDK changes, or the link serves stale `dist/`.
- **Nothing merges until the SDK publishes v0.6.0.** The merge sequence for every phase's work: SDK cuts + publishes `@pipelex/sdk@0.6.0` → here run `make use-npm-sdk` and pin `"@pipelex/sdk": "^0.6.0"` → `make check` green → commit. Do **not** commit the `file:` link.
- **The bump rides with the fixture fix.** `MethodData` gained required `org_id` / `created_by_user_id` in 0.6.0; the three test fixtures were updated this session (`shared.test.ts`, `inputs.test.ts`, `validate.test.ts`). That edit only type-checks on 0.6.0, so it lands together with the `^0.6.0` pin — not before.
- **Branch hygiene.** This work is currently uncommitted on `dev`. Move it to a feature branch (suggest `feature/sdk-0.6-adoption`) before committing; `dev` is an integration target, not a work branch (`guard-branches.yml`).

## Premise — VERIFIED this session (2026-07-23)

- **The 0.4→0.6 bump is clean.** Against the local 0.6.0 link: `npm run build` + `npm run typecheck` + `npm test` all green after the three `MethodData` fixtures gained `org_id`/`created_by_user_id`. That is the *entire* blast radius — zero production-code breakage. `deleteMethod` was removed in 0.6.0 (breaking) but the MCP never used it.
- **SDK 0.6.0 gives us, verified in the built `dist/` and source:**
  - `methodSourceToContents(mthds): string[]` — exported canonical parser, a verbatim port of the platform's `_method_source_to_contents`. **This is the function `src/capabilities/method-source.ts` currently mirrors.**
  - `client.getMethodClosure(methodId): Promise<MthdsFileItem[]>` — fetch + parse + provenance-label (each file's `source` set to the method id). Throws `EmptyMethodSourceError` when the stored source parses to nothing; surfaces the `getMethod` `404` (`ApiResponseError`, `code: "not_found"`) for an unknown/foreign-org id.
  - `EmptyMethodSourceError` (extends `InputPreparationError`, carries `methodId`).
  - `prepareInputs` / `buildInputs` now accept a `method_id` arm (discriminated union: `files` XOR `method_id`, never both) — `method_id` resolved client-side via `getMethodClosure` before the wire, never a wire field (distinct from the reserved `method_ref` registry ref, still 501).
  - `RunResults.tokens_usages: TokensUsageRecord[] | null` + `RunResults.usage_assembly_error` — per-call token counts by category, server-computed USD `cost`, model id, `pipe_code`. Already on the object `getRunResult` returns; `mthds_run_results` currently drops it.
- **What we retire (`fetchMethodFiles` leg, `shared.ts`):** `MethodFetchClient` (seam with `getMethod`), `fetchMethodFiles(getClient, methodId, options)` (calls `getMethod` then `methodSourceToContents`, hand-checks the empty result), `METHOD_FETCH_ERROR_OPTIONS`, and the `methodSourceToContents` import. Callers: `validate.ts:171`, `inputs.ts:185` (both on the `files.length === 0 && method_id` branch).

---

## Phase 1 — retire `method-source.ts` onto the SDK closure helper

Pure cleanup, no new capability. Collapse our parser mirror to one canonical SDK copy. Low risk, proves the `getMethodClosure` integration path before Phase 2 leans on the same SDK surface.

- [ ] **Rework `fetchMethodFiles` (`shared.ts`) to call `client.getMethodClosure(methodId)`** instead of `getMethod` + `methodSourceToContents`. It returns `MthdsFileItem[]` already source-labelled with the method id — the provenance the MCP hand-set before. Change the `MethodFetchClient` seam from `getMethod` to `getMethodClosure`.
- [ ] **Map `EmptyMethodSourceError` → the existing `input_domain`@`method_id` no-verdict** ("the stored method has no MTHDS source yet"), replacing the manual empty-result check. Keep the unknown-id `404` classification via `METHOD_FETCH_ERROR_OPTIONS` (route `/v1/methods/{id}`, `notFound`@`method_id`) — `getMethodClosure`'s 404 is still a `getMethod` `ApiResponseError`. Add `EmptyMethodSourceError` to `classifyError`'s known SDK error types (or catch it in the wrapper) — classify it *here*, where the concrete error is known, per the standing rule.
- [ ] **Delete `src/capabilities/method-source.ts` and `src/capabilities/method-source.test.ts`** (its edge-case coverage now lives in the SDK). Drop the now-unused `methodSourceToContents` import and any `MethodData` import in `shared.ts` no longer needed once the seam returns `MthdsFileItem[]`.
- [ ] **Keep validate and inputs symmetric.** Both stay fetch-and-forward over the reworked `fetchMethodFiles`. **Decision (settled): do NOT switch `inputs.ts` to the `buildInputs({ method_id })` passthrough** even though the SDK now allows it — that would split by-id error handling (some at our boundary, some inside `buildInputs`) and make inputs asymmetric with validate (which *must* resolve locally, since `/v1/validate` has no `method_id`). One shared resolution path, one place that maps `EmptyMethodSourceError`/404.
- [ ] **Update test seams**: the fakes in `shared.test.ts`, `validate.test.ts`, `inputs.test.ts` provide `getMethodClosure` (returning `MthdsFileItem[]` / throwing `EmptyMethodSourceError` / a 404) instead of `getMethod` + a polymorphic `mthds` string. The by-id happy/empty/unknown cases move onto the new seam.
- [ ] Validate with the individual targets (build → typecheck → test). SPEC/CLAUDE wording that describes the fetch leg as "parse `MethodData.mthds`" updates to "resolve via the SDK's `getMethodClosure`".

**CHECKPOINT 1** — `method-source.ts` gone, both by-id legs on `getMethodClosure`, gates green under the local link. Natural handoff: Phase 2 starts from a clean SDK-canonical closure path. (Commit sequencing per the cross-cutting constraint — rides the `^0.6.0` pin.)

---

## Phase 2 — spec + build `mthds_prepare_inputs`

The headline: a tool-only input-preparation operation over the SDK's `prepareInputs` (upload file-bearing inputs to storage, rewrite to `pipelex-storage://`). Its contract is deliberately unspecified in `SPEC.md` today (Non-Goals → "Planned"). **Design first, get sign-off, then build.**

### Phase 2a — SPEC.md design pass (decisions, then sign-off)

Resolve and record in `SPEC.md` (mirror into the Zod schemas afterward):

- [ ] **Tool name + shape.** Confirm `mthds_prepare_inputs`. Input: `files?` / `method_id?` (the shared submitted-files shape + the by-id arm, same as the other tools), `pipe_ref?`, and `inputs` (the caller's *filled* compact inputs — the thing `mthds_inputs_template` produced and the agent filled). No `format`/`explicit` (this returns prepared inputs, not a template).
- [ ] **Per-deployment asset boundary — the crux.** The reserved boundary (SPEC Non-Goals) says the **workshop** prepares local paths/bytes within its asset boundary using the user's key; the **hosted console** refuses path/bytes preparation instructively (HTTP(S) URLs and existing `pipelex-storage://` URIs pass through unchanged). Decide the enforcement mechanism (a per-deployment capability flag, analogous to the resolver seam — the console has no local-asset access) and **revisit whether the console should still refuse *bytes* (data-URLs)** now that BYOK per-user keys exist, or stay URL/storage-only until per-user upload authorization is settled. This is the decision most in need of your sign-off.
- [ ] **Output + verdict discipline.** `structuredContent`: the prepared `inputs` (rewritten), the `uploads` uri list, `status`/`is_valid`, echoed `pipe_ref`. `prepareInputs` calls `buildInputs` internally → an unresolvable closure is a produced `is_valid: false` verdict with `validation_errors[]` (same discipline as `mthds_inputs_template`); an upload failure is a no-verdict `status: "error"`. No view, no `_meta`.
- [ ] **Error taxonomy.** Map the `InputPreparationError` family to our `ErrorClass`: `EmptyMethodSourceError` → `input_domain`@`method_id`; `InvalidLocalSourceError` → `input_domain` (bad/absent local source); `RejectedAssetError` (413) → `input_domain` (too large); `UnsupportedUploadCapabilityError` (404 no `/v1/upload`) → `config`; `UploadAuthenticationError` (401/403) → `config` (deployment auth texture); `UploadTransportError`/5xx → `runtime`. All in `classifyError`, each with `retryable`.
- [ ] **UX flow + Non-Goals.** Add the prepare step to the "prepare inputs → run" flow (template → fill → **prepare** → run); move `mthds_prepare_inputs` out of the "Planned" Non-Goal into a real scope section.

**CHECKPOINT 2a — SIGN-OFF GATE.** Contract recorded in `SPEC.md`; do not implement until the per-deployment boundary decision is confirmed.

### Phase 2b — implement

- [ ] New `src/capabilities/prepare.ts`: Zod input/output schemas, the `prepareInputs` call (files or `method_id`; resolve to exactly one before calling the SDK's discriminated union — our public shape allows both-with-files-win, the SDK does not), projection to `structuredContent` + composed Markdown summary, per-route `ClassifyErrorOptions`.
- [ ] Enforce the per-deployment boundary (console refuses path/bytes per 2a's decision; workshop allows within its asset boundary) via the deployment context, mirroring the resolver seam.
- [ ] Register in `src/tools.ts` (ordered table) for both shells; annotations (not read-only if it uploads; non-destructive; no open-world publishing). Update both server `instructions` strings.
- [ ] Tests (fake client seam): files happy path; `method_id` happy path; URL/storage pass-through (no upload); invalid closure → produced `is_valid: false`; each error-class mapping; console path/bytes refusal; workshop local-path preparation.

### Phase 2c — docs + gates

- [ ] `SPEC.md` (done in 2a), `README.md` (new tool contract), `CHANGELOG.md` `## [Unreleased]` (Added: `mthds_prepare_inputs`), `CLAUDE.md` (architecture list + the new capability file).
- [ ] Gates green (individual targets under the link; full `make check` once on `^0.6.0`).

**CHECKPOINT 2** — `mthds_prepare_inputs` live end to end, specced and documented.

---

## Phase 3 — token usage + cost in `mthds_run_results`

Standalone, independent of Phases 1–2 (needs only the 0.6.0 surface). The SDK already hands us `RunResults.tokens_usages`; project it.

- [ ] **Design (small):** decide what to surface in `structuredContent` — total USD `cost` (sum of records; null-aware), total tokens, and/or a per-`pipe_code` breakdown — and the bounded shape (mirror the `main_stuff` bounding discipline). The full `tokens_usages` record list rides the view-only `_meta`, never model context. Branch on `usage_assembly_error` (not on the list being null) to distinguish "assembly broke" from "usage off".
- [ ] Extend the `mthds_run_results` output schema + `RunResults` projection in `capabilities/run.ts`; add a cost line to the composed `content` summary on `completed`.
- [ ] Tests: a completed run with `tokens_usages` (cost summed, per-pipe if chosen); `tokens_usages: null` + `usage_assembly_error` set; the `[]` (assembly ran, no inference) case.
- [ ] `SPEC.md` (Run Scope / `mthds_run_results` output), `README.md`, `CHANGELOG.md`, `CLAUDE.md`.

**CHECKPOINT 3** — run cost/usage surfaced; gates green; ready for the `/release` cut once `@pipelex/sdk@0.6.0` is published and pinned.

---

## Parked / explicitly out of scope

- **Native `method_id` on `/v1/validate` and `/v1/build/inputs`** — the deeper platform-side fix that would retire fetch-and-forward entirely (handoff: `../wip/method-id-native-tooling-routes/`). When it ships, `getMethodClosure` becomes a thin delegate and the MCP's by-id legs simplify further. Not blocking; endgame.
- Opt-in `http(s)` → storage ingest (the SDK passes URLs through unchanged; a later, additive SDK feature).
- Catalog discovery tools (list/get methods), publish/save from the workshop, console OAuth, methods-as-tools projection — all still parked (see the archived plan `wip/archive/TODOS-method-id-catalog-runs-2026-07-21.md`).
