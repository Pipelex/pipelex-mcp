# Build vs run: the lifecycle dimension of the dual-deployment MCP

Status: companion to `wip/dual-deployment-assessment.md` — read that first. (Revision 2026-07-17: view-rendering claims updated per `wip/mcp-apps-landscape-and-local-ui.md` — views now render in Cursor/Cowork/Codex too; Claude Code is the one text-only host.) This document adds a second axis to the two-server decision, informed by the platform's method-catalog endpoints (recap: `../pipelex-platform/wip/methods-endpoints-recap.md`). Direction discussed, not yet designed; feeds the same upcoming SPEC.md increment.

## 1. The claim

The first assessment split the two servers by **host capability**: local where there's a filesystem, hosted where there isn't. This document adds a split by **lifecycle phase**, and it turns out to be the more product-shaped one:

- **Building a method** (authoring, validate → fix → validate, inputs projection) is file-centric work. The files live on a developer's disk, change constantly, and every iteration needs byte-accurate reads and diagnostics that point at real files. This is the local server's home turf.
- **Running a method** (start, follow, report, revisit days later) is reference-centric work. Once a method is registered in the platform catalog, the bundle doesn't need to travel through the conversation at all — a run needs only a `method_id`, filled inputs, and somewhere good to watch it. This is where the hosted server stops being a compromise and becomes the best surface we have: durable runs, the `run-follow` live card, the completion handoff, the `run-graph` view.

So the two servers aren't just "the fast one and the only-possible one" — they're the **workshop** and the **console**. Build where the files live; run where the method lives.

## 2. What the platform methods catalog changes

The platform's `/methods` CRUD (`pipelex-platform`, under `/v1/*`) stores org-scoped method records whose `mthds` field holds the full bundle source, keyed by a server-minted `mt_<uuid4>`. Key properties that matter here: org-scoped and workspace-shared (every org member sees the same catalog), update-only `PUT` (no versioning — the record holds the current content), a read-time derived `description`, a stored `input_data` field, and **no `DELETE` by design**.

This is, in effect, the "bundle handle" idea from the first assessment — deferred there as a hypothetical content-hash scheme — already shipped as a product-grade object: named, org-shared, attributed, durable. We don't need to invent a handle; the catalog is the handle.

### The fetch-and-forward insight

The decisive architectural point: **the hosted MCP server can resolve a `method_id` to its bundle server-side.** `@pipelex/sdk` already carries the product surface (methods CRUD) alongside the run lifecycle, so a hosted tool call like "run method `mt_…` with these inputs" can have the MCP fetch the stored `mthds` source via the SDK and forward it to `POST /v1/start` — all inside the server process. The bundle content never crosses the LLM in either direction: not emitted as arguments (the id is tens of tokens), not returned into context (the server consumes it). No new platform or runner routes are required for this — the MCP composes two existing surfaces. A first-class run-by-reference route on the platform can come later as an optimization; it isn't a prerequisite.

The same trick works for `mthds_inputs_template`: projecting the input template of a *registered* method by id means a chat user can go from "run my invoice extractor" to filled inputs to a live `run-follow` card without the bundle ever appearing in the conversation.

### Revising "irreducible"

The first assessment said the hand-copy cost on chat hosts is irreducible — the LLM must emit content once to get it off the conversation. That stays true, but its scope narrows to **authoring ad-hoc content**: pasting or drafting a new bundle in the chat itself. For anything already in the catalog, running and inputs-templating on ChatGPT/claude.ai become near-zero-token operations. The only heavy path left on chat hosts is exactly the phase we're routing elsewhere anyway — building.

## 3. The lifecycle map

| Phase | Best server | Why | The other server's story |
|---|---|---|---|
| Author & repair (validate, inputs from files) | **Local** | Files on disk, `{ path }` submission, byte-accurate, diagnostics locate to real files, cheap repair loop | Hosted works with inline content — slow on large bundles; acceptable for small edits discussed in chat |
| Publish to catalog | **Local** (bridge step) | A save tool reading from paths pushes the built bundle to `POST`/`PUT /methods` — the seam where the workshop hands off to the console | From chat, saving means emitting content by hand — possible, not the promoted path |
| Discover (list/inspect registered methods) | **Hosted** | Org-shared catalog + conversational surface: "what methods do we have?" → list with derived descriptions | Local server can call the same routes; useful, just less of a headline |
| Run a registered method | **Hosted** | `method_id` + inputs only; fetch-and-forward keeps content out of context; `run-follow` card + completion handoff render here | Works from coding agents too — same id-based call, with the live card in Cursor/Cowork/Codex and text-only polling in Claude Code |
| Run an unregistered work-in-progress | **Local** | Paths in, run out — the natural "test what I just built" loop | Hosted requires inline content — the slow path |
| Follow & report (status, results, days-later lookup) | **Hosted** | Views render here; durable `run_id` already survives conversation gaps | Identical tools and views work locally (Claude Code excepted — text summaries carry the flow there) |

The one-host-one-server rule from the first assessment is unchanged by all this — coding agents still get everything through the local server (including id-based runs), chat hosts through the hosted one. What changes is the **emphasis**: the hosted server's center of gravity shifts from "validation for people without a filesystem" to "the conversational front-end of the method catalog."

## 4. What this implies for the tool surface (sketch, not design)

> **Revision 2026-07-21 — the first two bullets are shipped** (on `feature/method-id-catalog-runs`; SPEC.md is now the authority). Schema shape as decided: a separate optional top-level `method_id?` beside a now-optional `files` — not a third arm on the files union (a method id is not a file) and not a distinct tool. Transport as decided: `mthds_run` uses the platform's **native** `method_id` resolution on `/v1/start` (`start({ extra: { method_id } })` — no fetch round-trip, files win with the id riding as run-history linkage); `mthds_inputs_template` uses **fetch-and-forward** (`getMethod` → mirror-parse `MethodData.mthds` → `buildInputs`). The last two bullets (catalog discovery tools, the publish/save tool) remain unshipped sketch, and `mthds_validate` by id is parked with the conducted-views workstream (`dual-server-conducted-views.md`).

Following the SPEC naming conventions (noun names the artifact; lifecycle families share a stem):

- **`mthds_run` grows a `method_id` arm** as an alternative to `files` — the run family keeps its stem and the durable-id flow downstream (`mthds_run_status`, `mthds_run_results`) is untouched.
- **`mthds_inputs_template` grows the same arm**, resolving the registered method's closure server-side. (SPEC.md currently notes `method_ref` is unexposed because the registry answered 501 — the platform catalog is now the registry that answers.)
- **Catalog discovery tools** on the hosted server: list registered methods (name, derived description, id) and fetch one method's detail. Read-only, small structured payloads, no views needed initially.
- **A publish/save tool** on the local server: create or update a catalog method from paths. NOT read-only; org-scoped; idempotent upstream (`POST`/`PUT` are wrapped by org-scoped idempotency). **No delete tool** — mirroring the platform's deliberate no-`DELETE` stance; removal stays a product-owned operation.
- Registered-method runs by catalog id currently sit in SPEC.md's **Non-Goals** — this dimension pulls that item forward as the hosted server's headline increment, the way directory distribution pulls OAuth forward.

## 5. Auth becomes the critical path for the hosted story

The catalog routes are org-scoped (`X-Org-Id` from active-org context; a missing org context is a 400), surface-gated (`ff_playground` for JWT callers, `ff_api_keys` for API-key callers), and paywalled (402 when the org has no allowing subscription). Consequences:

- **Hosted server**: per-user OAuth stops being just a directory-distribution prerequisite and becomes the enabler of the whole run-console story — the MCP must act as the user *within their active org* for list/get/run-by-id to mean anything. The org-context handshake (how the MCP learns/holds `X-Org-Id`) is a design question the SPEC increment must answer.
- **Local server**: the user's own `PIPELEX_API_KEY` in host config already fits the API-key caller path (`ff_api_keys`), so the workshop story has no new auth work — publish-from-local rides the same key.

## 6. Open questions this adds

- **Stored `input_data` as default inputs?** The method record carries `input_data`; a run-by-id could default to it when the call omits `inputs`. Product question: is that a convenience or a footgun?
- **No versioning on methods.** `PUT` overwrites; a run-by-id always runs the *current* content. Fine for now (no-backward-compat culture), but worth stating in tool descriptions so agents don't assume a run pins the content it validated.
- **Failure classification for the id path**: unknown `method_id` (platform 404) should classify as `input_domain` with a discovery hint — the same per-route 404 override pattern the run routes use — and the 400 missing-org / 402 paywall / 403 surface-gate responses need their own `config`-vs-`input_domain` treatment in `classifyError`.
- **Does run-by-id change the local server's priority?** The build-phase pain (the original latency complaint) is still solved only by the local shell, but the hosted catalog integration is independently valuable and touches no transport work. The two increments can proceed in either order or in parallel; sequencing is a roadmap call, not a technical dependency.
- **Webapp loop**: methods built in the webapp's build chatbot land in the same catalog — meaning methods authored anywhere become runnable from ChatGPT/claude.ai via the hosted MCP. Worth a line in the team story: this is the piece that turns the hosted MCP from a validation utility into a distribution surface for the platform.

## 7. The revised team story (for the artifact update, later)

The two servers aren't two workarounds — they're the two halves of the method lifecycle: the **local MCP is the workshop** (build, repair, test, publish — where the files live), the **hosted MCP is the console** (discover, run, follow, report — where the methods live). The catalog is the bridge between them, and it makes the hosted server's slow path disappear for every method that crosses it.
