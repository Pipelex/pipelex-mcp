# Prompt: console run-by-method-id (copy into a fresh session)

Recorded 2026-07-21. Premise pre-verified that day: the hosted `/v1/start` accepts `method_id` as an extension arg (platform resolves the stored method's source when no `mthds_contents`; inline contents take precedence, `method_id` then = run-history linkage), and `@pipelex/sdk` carries it via `start({ extra: { method_id } })` — production reference `../pipelex-app/src/actions/runs.ts:91`. `getMethod(methodId)` returns the stored `.mthds` source (`MethodData.mthds`).

---

I want to integrate **run-by-method-id** into the pipelex-mcp console: `mthds_run` (and the tool contracts generally) should accept a registered method's catalog id (`mt_<id>`) instead of file contents, so the model never carries the bundle. This is the "catalog run-by-reference" item from the design series.

**Hard guardrail — read first.** My premise is that this is already supported end to end: the hosted Pipelex API's `POST /v1/start` accepts a `method_id` extension arg (resolving the stored method's source when no `mthds_contents` is sent), and `@pipelex/sdk` passes it via `start({ extra: { method_id } })`. Verify this yourself before writing any code (the production usage is `../pipelex-app/src/actions/runs.ts` `createRun`; the SDK is `../pipelex-sdk-js/src/client.ts` `start()` + `getMethod()`). **If the premise does not hold — the API or the SDK does not actually support starting a run by method id — this is a HIGH ALERT: stop immediately, do not implement it yourself, do not build a workaround, and report the problem to me.**

Cold-start reading (in order): `CLAUDE.md`, `SPEC.md`, then `wip/README.md` and the design series it indexes — especially doc 2 (`build-vs-run-dimension.md`, the catalog-as-bridge design and fetch-and-forward), the standing decision "Catalog run-by-reference … via server-side fetch-and-forward; no new platform routes required; 'registered-method runs by catalog id' moves out of SPEC Non-Goals", and queue item on the SPEC catalog portion (unknown `method_id` 404 → `input_domain`, org-context 400, paywall 402). Invoke the `skybridge` skill per `AGENTS.md` before planning.

Design points to settle (decide, record in SPEC.md, then implement):

1. **Transport choice per capability.** For *starting a run*, prefer the platform's native `method_id` resolution on `/v1/start` (simpler than the series' fetch-and-forward — no bundle ever leaves the server side). Fetch-and-forward via `getMethod()` remains the mechanism for any capability the runner has no by-id support for (e.g. validating or inputs-templating a registered method), if we choose to support those by id now.
2. **Input schema shape.** How the method reference enters `mthds_run`: a third arm on the files union, a separate `method_id` argument mutually exclusive with `files`, or a distinct tool. Respect the standing rule: both shells register identical tool names and schemas — whatever shape lands, the workshop gets it too (a workshop user can also run a registered method by id).
3. **Precedence + validation.** Mirror the API's precedence rule explicitly in the contract (inline contents win; `method_id` alone resolves stored source). Classify the new no-verdict failures in `classifyError` with the right `ErrorClass` and `retryable` verdicts: unknown `method_id` (404 → `input_domain`), org-context (400), paywall (402), and keyless BYOK (the catalog is per-user/org, so a key is required — the existing instructive `config` texture applies).
4. **SPEC.md moves.** Move "registered-method runs by catalog id" out of Non-Goals; add the catalog-route verdict/classification additions; keep `SPEC.md`, the Zod schemas, `README.md`, and `CHANGELOG.md` in sync per repo convention.
5. **Views.** `run-follow` should work unchanged (it follows by `run_id`); confirm nothing in the view assumes file-based starts.

Quality gates: `make check` + `make t` green; follow the repo's checkpoint discipline (commit, docs sync, independent no-context review on the diff pointer) for a change of this size.
