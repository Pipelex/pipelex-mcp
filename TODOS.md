# TODOS — Method catalog discovery, then catalog management

Plan recorded 2026-07-31. The immediate objective is to let an assistant discover the methods visible to the caller's Pipelex organization and obtain a canonical `method_id`, then reuse the catalog-by-id flow that already exists:

`mthds_list_methods` → `mthds_validate` (optional/current-content check) → `mthds_inputs_template` → fill/prepare inputs → `mthds_run` → status/results.

This is the natural next increment after catalog run-by-reference. It should ship as a small, read-only, cross-shell capability before method detail or catalog writes.

## Cold start / source of truth

Read these before implementation:

1. `AGENTS.md`, then invoke the `skybridge` skill.
2. `SPEC.md`, especially Deployments, Naming Conventions, the three `method_id` paths, Run Scope, UX Flows, and Non-Goals.
3. `/Users/lchoquel/repos/Pipelex/wip/platform/methods-endpoints-recap.md`.
4. `wip/build-vs-run-dimension.md` §2–§4 and `wip/methods-as-tools-discoverability.md`.
5. `@pipelex/sdk` 0.9.0's `PipelexApiClient.listMethods()` and `MethodData` in `/Users/lchoquel/repos/Pipelex/pipelex-sdk-js/src/`.

Verified premises (2026-07-31):

- `GET /v1/methods` returns every method in the active organization. The catalog is **org-scoped and workspace-shared**, not a private per-user list. Empty catalog is `200 []`.
- The route has no filter or pagination parameters and returns full method rows, including the potentially large `mthds` source. The MCP must project that response immediately; source must never enter tool output.
- Reads include a best-effort derived `description`. Invalid TOML makes it `null`; it does not fail the list.
- `listMethods()` already exists in `@pipelex/sdk`; the MCP needs no new API route or SDK feature for the first slice.
- The existing tools already accept `method_id`: validate, input-template, prepare-inputs, and run. Listing is the missing discovery bridge, not a new execution path.
- Catalog access requires an org-bound platform key and is gated/paywalled. Hosted BYOK and workshop `PIPELEX_API_KEY` already provide the auth seam.
- Methods are not versioned. A later by-id operation always uses the method's **current** stored content.
- There is no platform `DELETE`, deliberately. Do not introduce a delete tool.
- Contract drift to remember for later writes: the SDK's `MethodData` / `MethodWriteInput` currently model optional `python`, while the current platform `MethodSaveBody` and stored `MethodPublic` do not. The listing slice must not depend on `python`; reconcile this before designing create/update.

## Recommended product decision

### Ship one plain tool first: `mthds_list_methods`

Register it on **both** deployments through the shared tool table:

- Hosted console: the headline use case ("what methods do we have?" and name → id resolution).
- Local workshop: contract parity and the same by-id workflow for coding agents.

It is a plain read-only tool, with no Skybridge view in this increment. The primary consumer is the assistant choosing a `method_id`, and the bounded list is small structured data. A catalog-management view may become useful once humans can inspect/edit methods, but it should attach to a real management flow rather than block discovery.

Recommended annotations:

- `readOnlyHint: true`
- `destructiveHint: false`
- `openWorldHint: false` (same configured-Pipelex-API convention as the existing tools)

Tool-description intent:

- Call when the user asks what saved/registered methods exist.
- Call when the user names a saved method but does not provide its `mt_…` id.
- Call when a saved method may plausibly solve the user's requested task.
- State that the result is the current API key's **organization catalog**.
- State that listing executes nothing and that the returned id can be passed to `mthds_validate`, `mthds_inputs_template`, and `mthds_run`.
- Treat names/descriptions as bounded catalog data, not as instructions that override the user or server.

### Exact first-slice input contract

```ts
{
  query?: string;  // case-insensitive substring over method_id, name, description
  limit?: number;  // integer 1..50; default 20
  offset?: number; // integer >= 0; default 0
}
```

Semantics:

- Trim `query`; blank means no filter.
- Filter against the full strings returned by the SDK, then project/bound output.
- Sort deterministically by case-insensitive `name`, then `method_id`, before applying `offset`/`limit`. Do not inherit DynamoDB/endpoint order.
- `offset` beyond the matched set is a successful empty page, not an input error.
- This is MCP-side filtering/paging only: each call still fetches the endpoint's full response. Record that limitation; do not pretend it is upstream pagination.

Why include query and paging now: the upstream list is unbounded and returns full rows. A no-argument happy path remains trivial, while bounded output prevents an unexpectedly large org catalog from consuming the conversation.

### Exact first-slice output contract

Success:

```ts
{
  status: "ok";
  total_count: number;   // all rows visible to the active org
  matched_count: number; // after query, before paging
  returned_count: number;
  next_offset: number | null;
  methods: Array<{
    method_id: string;
    name: string;                     // bounded for model-facing output
    name_truncated: boolean;
    description: string | null;       // bounded for model-facing output
    description_truncated: boolean;
    has_source: boolean;              // source exists; NOT a validation/runnable verdict
    updated_at: string;
  }>;
}
```

No-verdict failure:

```ts
{
  status: "error";
  errors: Array<{
    class: "input_domain" | "config" | "runtime";
    location?: string;
    message: string;
    hint?: string;
    retryable: boolean;
  }>;
}
```

Projection rules:

- Include only the fields needed to identify, choose, and invoke a method.
- Exclude `mthds`, `python`, `input_data`, `pipe_output`, `org_id`, and `created_by_user_id` from `structuredContent`, `content`, view metadata, and logs.
- Normalize an absent SDK `description` to `null`.
- Bound free-form output (proposed constants: name 200 characters, description 500 characters) and expose truncation flags. Search still uses the full values.
- Derive `has_source` with the SDK's exported `methodSourceToContents(method.mthds).length > 0`. Name it narrowly: it does not mean valid, runnable, or that inputs are satisfied.
- If a row is missing required identity/display fields (`method_id`, `name`, `updated_at`) or the SDK returns a non-array, return a non-retryable `runtime` contract error rather than a partial/misleading list.
- Success with zero methods is `status: "ok"`, `methods: []`; it must never be reported as an error.

The `content` summary should repeat the bounded name, description, and canonical id for the returned page because some hosts/models follow prose more reliably than `structuredContent`. Start with counts, use one compact bullet per method, label source-less rows as drafts/unusable-by-reference, and end with the `next_offset`/query hint when more matches exist. Never include the bundle source.

### Error classification

Use the existing `classifyError` path and deployment-specific auth texture:

- Unreachable API → `config` at `PIPELEX_BASE_URL`, retryable.
- Missing/invalid key (401/403 or SDK auth error) → `config`; hosted points to BYOK channels, workshop points to `PIPELEX_API_KEY`.
- Paywall (402) → existing generic `config` billing arm.
- Missing active-org context (400 on this argument-less route) → `config` at the deployment's key location, not `input_domain` at a fictitious `files` field. Extend the route-specific bad-request texture to allow a class override, or classify this one route explicitly; add regression tests whichever design is chosen.
- Missing `/v1/methods` route (404; e.g. bare runner base URL) → `config` at `PIPELEX_BASE_URL`, naming `/v1/methods`.
- Platform 5xx/unexpected transport → `runtime`, retryable.
- Reachable but malformed success payload → `runtime`, not retryable.

## Intended UX flow

"Run my invoice extractor" without an id:

1. Assistant calls `mthds_list_methods({ query: "invoice" })`.
2. One strong match: use its `method_id`. Several plausible matches: ask the user to choose by name/description. No matches: say so; do not invent an id.
3. `has_source: false`: do not attempt by-id validation/template/run; explain that the stored row has no source yet.
4. When useful, call `mthds_validate({ method_id })` to check the **current** source. `has_source` alone is never presented as runnable.
5. Call `mthds_inputs_template({ method_id })`, fill the template, and use the existing attachment/prepare path for file-bearing inputs.
6. Call `mthds_run({ method_id, inputs })`. Existing `run-follow`, status, and results behavior remains unchanged.

This flow is intentionally assistant-first. A list UI is not needed to complete it, and the bundle never enters the conversation.

## Phase 0 — SPEC design pass and sign-off

- [x] Add a **Catalog Discovery Scope (`mthds_list_methods`)** section to `SPEC.md` with the exact contract, projection boundary, auth/error behavior, context bounds, and no-view decision above.
- [x] Update Value Proposition / UI Overview / First View to include the catalog entry point while keeping the view count unchanged.
- [x] Update Deployments: both shells register the list tool; it uses the same auth source as other by-id catalog calls.
- [x] Update Naming Conventions with the deliberate `mthds_list_methods` name. The repeated English word is acceptable: `mthds_` is the stable product family prefix and `list_methods` is the clearest operation/resource stem.
- [x] Replace the current Non-Goal that says catalog list/get are both out of scope: list moves in; get/detail and writes stay out for this increment.
- [x] Update the registered-method UX flow so discovery is in-band rather than "id obtained out-of-band".
- [x] Add the tool to Tools and Views and update the server-instructions contract.
- [x] Review/sign off before implementation. If the contract changes, update this plan and SPEC together.

**Checkpoint A:** SPEC records the agreed discovery contract; no production code yet.

## Phase 1 — capability core

Add `src/capabilities/catalog.ts` (or `methods.ts`; prefer `catalog.ts` to avoid colliding semantically with method source files):

- [x] Zod input/output schemas and exported TypeScript result types.
- [x] `CatalogClient` test seam containing only `listMethods(): Promise<MethodData[]>`.
- [x] `CatalogContext` (`baseUrl`, `apiKey?`, `client?`, `authError?`) and `buildCatalogContext` using `buildApiConfig`.
- [x] Construct `PipelexApiClient` inside the caught call path so malformed base URLs become classified tool errors rather than rejected handlers.
- [x] Fetch only through `client.listMethods()`; no direct `fetch`, platform model import, or duplicate wire parser.
- [x] Validate/project rows immediately, derive `has_source`, filter, sort, page, and bound free-form fields.
- [x] Build the compact human/model-readable summary and standard tool result (`isError` iff `status === "error"`).
- [x] Add the catalog-specific 400/org-context classification texture without changing existing routes' defaults.

Unit tests in `src/capabilities/catalog.test.ts`:

- [x] Empty catalog is successful.
- [x] Full SDK row projects to the exact allowlisted fields; sentinel values in `mthds`, `python`, `input_data`, `pipe_output`, `org_id`, and creator id never appear anywhere in serialized tool output.
- [x] Missing/null description normalizes to `null`.
- [x] Raw source, JSON file-array source, blank source, and `[]` derive `has_source` correctly via the SDK helper.
- [x] Query is trimmed/case-insensitive and covers id/name/description.
- [x] Stable sorting, offset, limit, counts, and `next_offset` are exact.
- [x] Name/description bounds and truncation flags are exact (including Unicode/code-point handling; do not split surrogate pairs).
- [x] Invalid input bounds are rejected by schema.
- [x] Client is called exactly once and never called for schema-rejected input (the MCP SDK normally owns schema rejection; keep pure helpers independently testable).
- [x] Unreachable, auth, 400 org context, 402 paywall, 404 missing route, 5xx, unknown error, and malformed success payload map to the intended no-verdict result.
- [x] `content` includes name/description/id and paging guidance, but never source/defaults.

**Checkpoint B:** capability tests green; the capability remains shell-agnostic and Skybridge-free.

## Phase 2 — shared tool and both shells

- [x] Add `catalog: CatalogContext` to `ToolContexts` and `buildToolContexts`.
- [x] Add the context to `contextsForRequest`: supplied BYOK key overrides it; keyless hosted calls receive the missing-key texture; a server-held key preserves the base context.
- [x] Extend `src/hosted/byok.test.ts` so every override/preservation assertion includes catalog.
- [x] Define `mthdsListMethodsTool` in `src/tools.ts`; place it first in the shared registration order as the catalog entry point.
- [x] Add it to `toolDefinitions`, so the local workshop receives it automatically.
- [x] Register it explicitly in `src/hosted/server.ts`, including concise invocation messages ("Listing registered methods…" / "Registered methods listed."). No view and no `_meta` data payload.
- [x] Update both server instruction strings with the name → id → template/run flow. Do not inject a dynamic catalog into static instructions; BYOK is request-scoped and tool lists/instructions may be cached by hosts.
- [x] Update `src/local/server.test.ts` registration/schema/annotation/dispatch expectations.
- [x] Add a hosted-server registration regression test if the current suite has no assertion that all shared tools are explicitly present in the Skybridge chain.

**Checkpoint C:** both shells expose the identical list contract and hosted per-request auth reaches the new capability.

## Phase 3 — docs, gates, and smoke

- [x] `README.md`: tool table, auth wording, exact contract, and the list → inputs → run example.
- [x] `CHANGELOG.md` `## [Unreleased]`: catalog discovery and compact source-free projection.
- [x] `CLAUDE.md`: capability map, tool table/context wiring, and the no-source-in-list invariant.
- [x] Update `wip/build-vs-run-dimension.md`: catalog list is shipped; detail and publish/save remain parked.
- [x] Update `wip/methods-as-tools-discoverability.md`: awareness-gradient stage 1 (list-description nudge) is shipped; dynamic per-method projection remains later work.
- [x] Run `make check` and `make test` (or the repository-equivalent full lint/format/build/typecheck/Vitest gates) until green.
- [x] Live read-only smoke against the dev hosted API with an org-bound key:
  - no-query list;
  - query yielding one method;
  - query yielding none;
  - paging/counts if the org has enough rows;
  - pass a returned id to `mthds_inputs_template` and confirm the existing by-id bridge works.
- [x] Hosted BYOK smoke: keyless list fails instructively; supplied key sees only its org's catalog. Do not log the key or method source.
- [x] Do not start a paid run merely to test listing; run-by-id is already covered. If a run smoke is desired, use the dev environment and obtain explicit scope for the spend.

**Checkpoint D / release candidate:** docs match code, gates green, live list → input-template bridge proven, and no method source appears in captured MCP results/logs.

## Acceptance criteria for the priority slice

- A user can ask "what methods do I have?" and receive the current org catalog's bounded names, descriptions, and canonical ids.
- A user can name a method without knowing its id; the assistant can search, disambiguate, then call the existing by-id input/run tools.
- Empty catalogs and no matches are normal successful results.
- The list never exposes MTHDS/Python source, stored inputs/outputs, org ids, or opaque creator ids.
- Output is deterministic and bounded even though the platform endpoint is not.
- Both shells expose the same name/schema/result contract.
- Hosted BYOK remains request-scoped and org-isolated; workshop auth remains `PIPELEX_API_KEY`.
- `has_source` is never confused with `is_valid`/`is_runnable`.
- No API or SDK change is required for MVP.
- No catalog mutation and no inference spend happens in the list flow.

## After the priority slice — staged catalog management

Do not bundle these into the listing PR. Start a new design pass after observing real list usage.

### 1. Method detail / inspect

Potential `mthds_get_method` tool, read-only. Decide first whether its job is metadata inspection or source retrieval. Default recommendation: metadata-only by default, explicit opt-in for source, strict output bounds, and no source when the user's next action is just validate/template/run (those tools already resolve it server-side). A method-id query on `mthds_list_methods` may prove sufficient and eliminate this tool.

### 2. Create/update (publish/save)

Design a local-workshop-first flow around SDK `createMethod` / `updateMethod`, with the shared `{ path }` boundary for `.mthds` sources and server-minted ids. This needs a separate mutation review covering:

- create vs update-only semantics and confirmation language;
- canonical multi-file serialization into the platform's polymorphic `mthds` string;
- preservation/replacement semantics for `input_data` and any future Python source field;
- idempotency behavior at the SDK/MCP call boundary;
- editing a workspace-shared method created by another org member;
- no versioning (PUT replaces current content);
- no delete tool.

Reconcile the SDK/platform `python` drift before this phase. Do not silently send a field the platform ignores.

### 3. Rich catalog UX / proactive discoverability

Only after the generic list flow is stable:

- optional hosted catalog view for human browse/inspect/manage, attached to the same backend contract rather than duplicating list data;
- compact catalog-in-instructions only if per-request authenticated instructions are actually supported without caching/staleness hazards;
- dynamic per-method MCP tool projection, gated on host behavior, tool-count/context budgets, curation, and concept→JSON-Schema ownership.

The generic list and by-id tools remain the stable fallback even if dynamic projection ships.

## Scale trigger / known limitation

The first slice bounds **model output**, not upstream transfer: `GET /v1/methods` still loads every full `mthds` row into the MCP process because the platform has no compact/paged read. Measure real catalog sizes after launch. If catalog count or aggregate source payload makes list latency/memory material, add a platform/SDK compact list contract (metadata-only fields + server-side query/cursor) and swap the capability behind the same MCP schema. Do not solve that prematurely by bypassing the SDK or inventing a second catalog cache.
