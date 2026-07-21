# TODOS — Catalog run-by-reference (`method_id` on `mthds_run` + `mthds_inputs_template`)

Build plan recorded 2026-07-21. This is the "catalog run-by-reference" item from the design series (`wip/README.md` decision list + queue item 4's remaining catalog portion; design rationale in `wip/build-vs-run-dimension.md` §2–§4). Goal: the tool contracts accept a registered method's catalog id (`mt_<id>`) so the model never carries the bundle — a run of a registered method becomes a tens-of-tokens call from any host.

**Cold-start for a new session**: read `CLAUDE.md`, `SPEC.md` (Run Scope + Inputs Template Scope + Non-Goals), then this file top to bottom. Invoke the `skybridge` skill per `AGENTS.md` before touching code. The premise-verification facts below were checked against live code on 2026-07-21 — trust them unless the referenced files changed.

## Premise — VERIFIED end to end (do not re-litigate; pointers if re-verification is needed)

- **Platform**: `POST /v1/start` is served by `pipelex-platform` (`../pipelex-platform/src/pipelex_platform/routers/v1/execution.py`). `HostedStartRequest` relaxes the protocol's `anyOf(pipe_code, mthds_contents)` to include `method_id` (and a `bundle` arm we don't use). A `method_id`-only request resolves the stored method's source via `_resolve_method_contents(org_id, method_id)` and runs it. **Precedence rule (platform-authored, user-ruled 2026-06-11)**: inline `mthds_contents` are what RUNS; `method_id` then rides as the run-history linkage on the Run row. Unknown/foreign-org `method_id` → **404** with the platform's structured envelope (carries a `code` field). Stored method with no MTHDS source → **422** `UnprocessableEntityError`.
- **SDK** (`../pipelex-sdk-js/src/client.ts`): `start(options)` merges `options.extra` extension args top-level into the wire body (`buildExtensions`); its input guard accepts an extension-only request. So `start({ extra: { method_id } })` is the by-id call and `start({ mthds_contents, extra: { method_id } })` is the linkage call. `getMethod(methodId)` → `GET /v1/methods/{id}` → `MethodData` whose `mthds: string` holds the bundle source.
- **Production reference**: `../pipelex-app/src/actions/runs.ts` `createRun` does exactly `client.start({ pipe_code, inputs, mthds_contents, extra: { method_id } })`.
- **`MethodData.mthds` is a polymorphic string**: either raw `.mthds` source OR a JSON-serialized file array `[{ name, content }, …]` (the webapp editor format). The platform parses it with `_method_source_to_contents` / `_method_source_to_contents`'s helper in `execution.py` (~line 220): parse as JSON → empty list means "no source"; a list of `{name, content}` dicts yields the non-blank contents; anything else means the string IS the single raw content. Any client-side fetch-and-forward must mirror this.
- **Platform error semantics for classification**: paywall → **402** `SubscriptionRequiredError` (`exceptions.py`; the HTTP status 402 is the branch signal — the problem `code` is `forbidden`, do NOT branch on it). Missing org context → **400** `BadRequestError` "Organization context required…" from `require_active_org` (`deps.py`) — for API-key callers (the MCP always is) the `plx_sk_` key is org-bound, so this 400 is an edge, not a mainline.
- **Views**: `src/views/run-follow.tsx` references only `run_id` — nothing assumes a file-based start. Design point 5 is closed with no code change.
- **Current classify gaps** (`src/capabilities/shared.ts` `classifyApiResponseError`): 402 falls into the generic "HTTP <status>" catch-all (`runtime`); `RUN_START_ERROR_OPTIONS` (`src/capabilities/run.ts`) has no `notFound` override, so an unknown-`method_id` 404 on `/v1/start` would today misclassify as `config`@`PIPELEX_BASE_URL`. Both are fixed by this plan. The `notFound` override on `/v1/start` is safe: a bare-runner missing-route 404 is intercepted earlier as `RunLifecycleUnavailableError` (SDK `throwIfLifecycleUnavailable` distinguishes envelope-with-`code` from Starlette's default body), so any `ApiResponseError` 404 that reaches classification really is the structured unknown-method one.

## Decisions (settled 2026-07-21 — mirror into SPEC.md in Phase 0)

1. **Transport per capability.** `mthds_run` uses the platform's **native** `method_id` resolution on `/v1/start` (`start({ extra: { method_id } })`) — no bundle ever leaves the server side, no `getMethod` round-trip. `mthds_inputs_template` uses **fetch-and-forward**: `getMethod(method_id)` → parse `MethodData.mthds` → `buildInputs` (the build routes have no by-id support). `mthds_validate` does **NOT** get `method_id` in this increment — a registered method was validated at publish, and "show me a registered method's graph" belongs to the undecided conducted-views workstream (`wip/dual-server-conducted-views.md`); it stays in Non-Goals with that rationale.
2. **Schema shape.** A separate optional top-level `method_id?: string` argument beside a now-**optional** `files` on `mthds_run` and `mthds_inputs_template` — NOT a third arm on the files union (a method id is not a file, and a mixed array would falsely suggest merging), NOT a distinct tool (the run family keeps its stem; one run tool for the model). `files` stays **required** on `mthds_validate`. Both shells register the identical schemas per the standing rule — the workshop gets `method_id` too (its env `PIPELEX_API_KEY` is org-bound, so catalog access rides along).
3. **Precedence + request shape.** One rule across both tools, mirroring the platform: **inline `files` win; `method_id` alone resolves the stored method's current source**. On `mthds_run`, both-supplied is meaningful and allowed — the inline files run and `method_id` is recorded as the run-history linkage (the webapp's own semantics). On `mthds_inputs_template`, both-supplied means files win and `method_id` is ignored (no linkage concept on build routes) — documented, not an error. Request-shape checks: at least one of (non-empty `files`, `method_id`) or `input_domain`; a supplied-but-blank `method_id` is `input_domain`@`method_id`; id format beyond non-blank stays server-owned (same stance as `run_id`).
4. **Classification** (all in `classifyError` where the concrete status is known, per the standing rule):
   - Unknown `method_id` (404) → `input_domain`@`method_id`, `retryable: false`, hint: check the id as returned by the catalog; the catalog is org-scoped to the API key's org, so a method from another org reads exactly like a miss.
   - Paywall (402) → **new generic arm** in `classifyApiResponseError` (any route): `config`, no location, `retryable: false`, hint pointing at the org's plan/billing on app.pipelex.com. Branch on status 402, never on the problem `code`.
   - Org-context 400 → stays `input_domain` via the existing 400/422 arm (no message-sniffing to split it out); the by-id `badRequest` hint covers both causes ("the stored method may have no MTHDS source yet; if the error mentions organization context, the API key's org binding is the issue — mint a key in the right org").
   - Keyless BYOK → no change needed: the platform 401s, the existing `config` auth texture (BYOK wording on the console, env-var wording on the workshop) already applies. Tool descriptions state a key is required for by-id calls.
   - **Per-request-shape options**: when the request carried `method_id` (with or without files), the capability passes by-id `ClassifyErrorOptions` variants (`notFound`@`method_id`, the combined `badRequest` hint); a files-only request keeps today's options so nothing regresses.
5. **No stored-`input_data` defaulting, no version pinning.** Omitted `inputs` pass through as-is (platform behavior governs). Methods have no versioning — a by-id run always executes the method's **current** content; the `mthds_run` description says so explicitly so agents don't assume a run pins what they validated (doc 2 §6).
6. **Method-source parsing helper** mirrors the platform's `_method_source_to_contents` exactly (raw source / JSON file-array / empty → no source), lives in the capability core, unit-tested against the platform's edge cases, with a comment naming `execution.py` as the canonical implementation to keep in sync.

## Phase 0 — SPEC.md increment (record the decisions)

- [x] Non-Goals: move "registered-method runs by catalog id" OUT; add explicit still-out items with rationale: `mthds_validate` by id (conducted-views workstream), catalog discovery tools (list/get methods), publish/save tool, stored-`input_data` defaulting.
- [x] Run Scope: add `method_id?` to the `mthds_run` input contract; state the precedence rule (files run + linkage; id-only resolves current stored source); state no-versioning; add the classification additions (unknown id 404 → `input_domain`@`method_id`, paywall 402 → `config`, org-context 400 → `input_domain` with combined hint, key required — keyless BYOK gets the existing instructive `config` texture).
- [x] Inputs Template Scope: add `method_id?` + the fetch-and-forward mechanics (`getMethod` → mirror-parse `mthds` → `buildInputs`), the files-win/ignored rule, the no-source no-verdict, and the classification for the fetch leg (route `/v1/methods/{id}`).
- [x] UX Flows: add the console run-by-reference flow (discover id out-of-band for now → `mthds_inputs_template` by id → fill → `mthds_run` by id → run-follow unchanged).
- [x] Tools and Views: update the two tools' Input lines; note `run-follow` is untouched (follows by `run_id`). (Also aligned the server `instructions` sentence in Tools and Views with the by-id start, ahead of the Phase 2 code change.)

**CHECKPOINT A — DONE (2026-07-21)** — SPEC increment committed as the first commit on `feature/method-id-catalog-runs`. Natural handoff: the design is fully recorded; implementation can start cold from SPEC.md + this file.

## Phase 1 — shared plumbing (`src/capabilities/shared.ts` + new helper)

- [x] `classifyApiResponseError`: add the 402 arm (`config`, retryable false, billing hint) ahead of the generic catch-all. Unit tests in `shared.test.ts` (402 with/without serverMessage).
- [x] Add `validateMethodIdRequest`-style check (blank `method_id` → `input_domain`@`method_id`) and a shared "provide files or method_id" emptiness check usable by both capabilities (replaces the unconditional `files.length === 0` error path for the two tools; `mthds_validate` keeps the current behavior). → Shipped as one combined `validateFilesOrMethodIdRequest(files, methodId)` in `shared.ts` (blank-id check + at-least-one-of + the per-file checks, extracted as `validateFileItems`).
- [x] New method-source parsing helper (suggest `src/capabilities/method-source.ts`): `methodSourceToContents(mthds: string): string[]` mirroring the platform (`execution.py`) — JSON `[]` → `[]`; JSON array of `{name, content}` → non-blank contents; otherwise `[mthds]`. Comment names the canonical platform implementation. Unit tests: raw TOML string, file-array, file-array with blank contents, `"[]"`, empty string, non-array JSON. → Also folds in `_resolve_method_contents`' blank-source guard: a blank raw arm yields `[]` (documented in the helper).
- [x] Keep `resolveSubmittedFiles` untouched — callers pass `input.files ?? []`.

**Phase 1 note (2026-07-21):** the platform's `_start_failure` in `execution.py` has been reworked since the premise was recorded — runner 4xx rejections now translate to 422 instead of the blanket opaque 503. The existing 503 `serverError` hint is kept per plan (harmless, still points at validation first), and the 422 arm now carries the real rejection reason.

## Phase 2 — `mthds_run` by id (`src/capabilities/run.ts`, `src/tools.ts`)

- [x] Input schema: `files` → optional; add `method_id` (describe: "Catalog id (mt_…) of a registered method. Runs the method's CURRENT stored content. With files also present, the files run and method_id is recorded as run-history linkage."). `MthdsRunInput` type updated.
- [x] `validateRunRequest`: at-least-one-of check, blank-`method_id` check, per-file checks only when files present, existing `pipe_code` check unchanged.
- [x] `toStartOptions`: emit `mthds_contents` only when files present; add `extra: { method_id }` when supplied (matches the `createRun` production call shape).
- [x] Classify options: add `RUN_START_BY_ID_ERROR_OPTIONS` (route `/v1/start`; `notFound`@`method_id` with the org-scoped-catalog hint; `badRequest`@`method_id` with the combined no-source/org-context hint; keep the existing opaque-503 `serverError` hint, extracted as a shared `START_SERVER_ERROR` const). `startMthdsRun` picks by request shape (`method_id` present → by-id options).
- [x] Tool description (`src/tools.ts`): state the by-id form, the precedence rule, current-content semantics, and that by-id needs an API key. Update the server `instructions` string (both shells: `hosted/server.ts` `HOSTED_SERVER_INSTRUCTIONS` + `local/server.ts` `LOCAL_SERVER_INSTRUCTIONS`) to mention running registered methods by catalog id.
- [x] Tests (`run.test.ts`, fake `RunClient` seam): id-only start passes `extra.method_id` and no `mthds_contents`; files+id passes both; neither → `input_domain`; blank id; 404 `ApiResponseError` → `input_domain`@`method_id` retryable false; 402 → `config`; files-only requests keep today's classification (regression guard); start ack projection unchanged. Plus: by-id 422 → the combined hint at `method_id`.

**CHECKPOINT B — DONE (2026-07-21)** — committed on `feature/method-id-catalog-runs`; `make check` + tests green. Run-by-id is live end to end; the inputs-template leg can land in a fresh session with only SPEC.md + this file as context.

## Phase 3 — `mthds_inputs_template` by id (`src/capabilities/inputs.ts`)

- [ ] Input schema: `files` → optional; add `method_id` (describe: files win / id-only resolves the stored method). `MthdsInputsInput` updated.
- [ ] `InputsContext` client seam: add `getMethod(methodId: string): Promise<MethodData>` to the client interface (test seam widens; real client already has it).
- [ ] Flow in `buildMthdsInputs`: resolve/validate as today; when no files and `method_id` present → `getMethod` (errors classified with new `METHOD_FETCH_ERROR_OPTIONS`: route `/v1/methods/{id}`, `notFound`@`method_id`, auth texture threaded) → `methodSourceToContents` → empty result is an `input_domain`@`method_id` no-verdict ("stored method has no MTHDS source yet") without calling the API → else forward as the build envelope's files (source label: the method id or `mt_<id>#<name>` per stored file — pick during implementation, record in SPEC if it deviates).
- [ ] Tests (`inputs.test.ts`, fake client): id-only happy path with raw-source `mthds`; id-only with file-array `mthds` (multiple files forwarded); unknown id 404 → `input_domain`@`method_id`; no-source method (no `buildInputs` call made); files+id → files win and `getMethod` is NOT called; 402 on the fetch leg → `config`.

## Phase 4 — docs sync + gates

- [ ] `README.md`: tool contract sections for both tools (input shapes, precedence rule, key requirement for by-id).
- [ ] `CHANGELOG.md` `## [Unreleased]`: Added — `method_id` catalog runs on `mthds_run` and inputs projection on `mthds_inputs_template`; Added — paywall (402) and unknown-method classification. (Do not mention `wip/` doc changes.)
- [ ] `CLAUDE.md` (this repo): update the tool/union description ("The files union and the resolution seam" + run/inputs sections) to reflect optional files + `method_id`.
- [ ] `make check` green; `make t` green.
- [ ] Optional manual smoke against the hosted API (needs a real `plx_sk_` key + a registered method): `listMethods` via a scratch script to grab an `mt_` id, then `mthds_run` by id through `make inspect-local` or the dev console. Record the outcome here.

**CHECKPOINT C** — commit; then run an independent no-context review on the full diff (`pr-review-toolkit:code-reviewer` agent on the branch diff vs `dev`), fix findings, re-run gates.

## Phase 5 — wrap-up

- [ ] `wip/README.md`: mark the queue's SPEC catalog portion done for run + inputs-template; note validate-by-id stays parked with the conducted-views workstream; add a dated revision note to `wip/build-vs-run-dimension.md` §4 (the sketch is now shipped for run/inputs, schema shape as decided here).
- [ ] Delete `wip/prompt-run-by-method-id.md` (its content is superseded by this executed plan) or mark it executed.
- [ ] Update auto-memory (`mcp-release-state.md` / design-series pointer) with the shipped state.
- [ ] PR `feature/… → dev` per the branch flow; release later via `/release` (not part of this plan).

## Parked / explicitly out of scope (do not scope-creep into this build)

- `mthds_validate` by id (conducted-views / doc 7 decides the "show a registered method" story).
- Catalog discovery tools (`list methods` / method detail) — the id arrives out-of-band (webapp, teammate) until those land; they are the natural next increment after this one.
- Publish/save tool from the workshop; methods-as-tools projection; console OAuth (doc 6); stored `input_data` as default inputs.
