# wip/ — the dual-deployment MCP design series (cold-start guide)

Written 2026-07-17. This directory holds the working design for the **future of `pipelex-mcp` and its distribution** — a series of discussion docs produced in one design session, meant to be resumed cold. Read this file first; it tells you what was decided, what was verified, what's open, and in which order to read the rest. (`pr-5-review-notes.md` is unrelated to this series.)

**Ground rule for resuming**: `SPEC.md` and `CLAUDE.md` describe the *implemented present* of this repo; the docs in this series describe the *agreed future*. Nothing from the series is implemented yet except the Skybridge 1.2.7 upgrade (recorded in `CHANGELOG.md` → Unreleased). Docs 1 and 2 carry dated revision notes; where any doc conflicts with doc 4, doc 4 wins.

## What we're designing, in one paragraph

`pipelex-mcp` will ship as **two servers from one repo and one capability core**: the existing hosted Skybridge server (the **console** — ChatGPT, claude.ai, Cowork consumers) and a new npm-distributed local server (the **workshop** — Claude Code, Codex, Cursor). The split exists because MCP tool arguments are LLM-generated, so submitting `.mthds` file contents through the hosted server means the model hand-copies them token by token (slow — a single method build was observed taking over ten minutes — and not byte-accurate); a local server reads `{ path }` from disk instead. The platform's method catalog bridges the two: build in the workshop, publish to the catalog (`mt_<id>`), then the console runs methods **by reference** (the server fetches the stored bundle and forwards it to the runner — content never crosses the LLM), with the endgame that a user's registered methods surface as **first-class MCP tools** their assistant already knows. Views (`run-graph`, `run-follow`) are a shared asset of both servers now that MCP Apps rendering spans Cursor, Cowork, and ChatGPT's Codex mode — Claude Code is the one text-only host. The `pipelex-plugins` plugin does **not** fork: one plugin, per-target server registration.

## Reading order

1. **`dual-deployment-assessment.md`** — the founding decision: the latency diagnosis, why transport (not rules) decides filesystem access, the two-shell architecture, distribution (URL vs npm), the one-host-one-server rule. Carries superseded-view revision notes.
2. **`build-vs-run-dimension.md`** — the lifecycle axis: workshop vs console, the catalog as the bridge, fetch-and-forward, the phase-by-phase map, auth as the console's critical path. Carries revision notes.
3. **`methods-as-tools-discoverability.md`** — dynamic per-session tool projection on the hosted console (each registered method becomes an MCP tool), the awareness gradient (nudges → instructions summary → projection → curation), constraints, and what's parked (per-user deployed MCPs → a future publishing product).
4. **`mcp-apps-landscape-and-local-ui.md`** — the researched July-2026 landscape (MCP Apps official; who renders what), the Skybridge verification (HTTP-coupled at transport *and* view-asset level; single canonical MCP Apps resource since 1.2.0; first-class auth incl. WorkOS since 1.2.0), the local-transport options (localhost HTTP / **stdio launcher + embedded HTTP, recommended** / plain stdio fallback), and the **V1/V2 empirical verification plan with checkpoints**. This doc supersedes stale view claims elsewhere.
5. **`plugin-reconciliation.md`** — why `pipelex-plugins` stays one plugin: per-target server declaration ("one install, one server"), the Claude-target two-persona tension (hosted-by-default + builder opt-in recommended), Codex target goes local, open packaging questions. §7 addendum: the plugin's build targets and the host→server matrix are different tables (artifact default ≠ host intent; the Desktop/Cowork = console classification is a persona assumption), plus the drafted host→server matrix.
6. **`auth-design.md`** — auth for both shells. Console: Skybridge 1.2 first-class auth + WorkOS AuthKit-for-MCP; the MCP-side OAuth handshake is now ~config (workosProvider + DCR toggle + resource indicator); the remaining work is a bounded authorizer change on the **platform team's** side (second issuer, `aud` allowlist, route scoping, `X-Org-Id` validation) — §4 of the doc is a self-contained handover ask. Workshop (§6): `plx_sk_` API keys, org-bound so no org handshake; key acquisition reuses the **existing** `pipelex login` loopback-browser flow (`app.pipelex.com/auth/cli`), adapted to mint the platform key instead of the gateway key (W1–W3). Decisions D1–D7 pending (pass-through vs ID-JAG, `aud` policy, route scope, console org UX, entitlement slug, `ff_api_keys` plan gate, mint-time org selection); verification items V-A1–V-A5.

Cross-repo input: `../../pipelex-platform/wip/methods-endpoints-recap.md` — the `/methods` CRUD facts the catalog design relies on (org-scoped, server-minted `mt_<uuid4>`, update-only PUT, **no DELETE by design, no versioning**, derived `description`, stored `input_data`).

## Decisions taken (terse)

- Dual deployment; one capability core; both shells register identical tool names (and keep server key `pipelex`) so skills and prefixes never fork.
- One host, one server — never both; the claude.ai-connector-syncs-into-Claude-Code trap must be documented.
- Hosted `{ path }` submissions are rejected with an instructive `input_domain` error.
- Catalog run-by-reference (and inputs-by-reference) via server-side fetch-and-forward; no new platform routes required; "registered-method runs by catalog id" moves out of SPEC Non-Goals.
- Methods-as-tools via dynamic `tools/list` after per-user auth; curation flag when catalogs grow; skills stay the stable manual (any local catalog snapshot is generated, never authored).
- Views ship on both servers; local shell is the same Skybridge server run locally (needs an HTTP listener for view assets); Claude Code degrades to text.
- Plugin: one logical plugin, per-target server blocks; Claude marketplace target stays hosted-by-default with a builder opt-in to local; Codex target bakes the local launcher. The hosted default on the Claude artifact is a packaging fallback, not Claude Code's operating mode — Claude Code's intended mode is the local workshop (doc 5 §7).
- Skybridge upgraded 1.1.1 → 1.2.7 (only code change so far; check + tests green).

## Next steps (the queue for a new session)

1. **Run verification V1** (doc 4 §4) — the current server over local HTTP per host (Cursor, Claude Desktop/Cowork, ChatGPT Codex/Work, Claude Code); no new code needed. Then decide V2 (stdio-launcher prototype) at the checkpoint.
2. **Ask Alpic** whether a blessed local/stdio mode is on Skybridge's roadmap before hand-rolling the V2 bridge (also relevant: their v1.2.0 first-class auth with the WorkOS provider for the console's per-user OAuth). **Draft ready to send: `alpic-ask-fred.md`** — covers the local-mode ask plus dynamic `tools/list` (V-A3) and stable-URL/env-config logistics (V-A5); record answers into doc 4 §4.
3. **Measure the latency split** (direct `curl POST /v1/validate` vs through-host wall-clock) — the diagnosis is confident but still unmeasured.
4. **SPEC.md increment**: Deployments section, `{ path }` arm, Non-Goals rewording (scope no-filesystem to hosted; move registered-method runs out), verdict/classification additions for the catalog routes (unknown `method_id` 404 → `input_domain`, org-context 400, paywall 402), view claims per verification results.
5. **Packaging decisions**: npm package name, `bin` wiring, publish machinery, version lockstep with the Alpic deploy; plugin server-declaration block + builder opt-in flow in `pipelex-plugins`; switch the plugin's baked Alpic dev-tunnel URL to the stable hosted URL when this repo deploys.
6. **Console auth** — design drafted (doc 6). Next: rule on decisions D1–D5, run verifications V-A1/V-A2 (decode a live AuthKit-for-MCP token; JWKS key material), and hand doc 6 §4 to the platform team (WorkOS dashboard config, dual-issuer `verify_workos_token`, authorizer `aud`/route/`X-Org-Id` policy). Methods-as-tools follows behind it (needs V-A3: auth-dependent `tools/list` in Skybridge).

## Related material

- **Team artifact** (executive brief, kept in sync with the series): https://claude.ai/code/artifact/2c46ec3c-fa0b-4924-bba1-5e4e2a8d547a — private until shared; a future session updates it by passing this URL as `url` to the Artifact tool.
- Skybridge v1.2.0 "Season Pass" release notes (first-class auth, WorkOS; single MCP Apps resource): https://github.com/alpic-ai/skybridge/releases/tag/v1.2.0
- MCP Apps extension overview: https://modelcontextprotocol.io/extensions/apps/overview
