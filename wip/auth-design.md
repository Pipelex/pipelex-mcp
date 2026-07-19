# Auth design — console (WorkOS via Skybridge) and workshop (API keys) (doc 6)

Written 2026-07-18. Part of the dual-deployment design series — read `wip/README.md` first. This doc expands next-step 6 of the README ("Auth/org design for the console") into a concrete design with a team-boundary split, and covers the workshop's key-based auth for contrast (§6) — one doc, both shells. Status: **proposed, not implemented**; decisions marked ⚖️ are pending a ruling.

**The question this doc answers:** Skybridge 1.2 ships first-class auth with a branded WorkOS provider. Does that make console auth easy? **Answer: yes for the MCP-side OAuth handshake — genuinely a config object plus a WorkOS dashboard toggle. But that only authenticates the client to the MCP server. Turning the verified identity into authorized calls to `api.pipelex.com` requires bounded changes on the platform side of the fence, which the MCP team does not own.** Section "Ask to the platform team" below is written to be handed over as-is. Workshop auth (§6) needs **no** platform work: it rides the existing API-key path, and key acquisition adapts the already-shipped `pipelex login` loopback flow.

## 1. Verified ground truth

Three sources, all checked on 2026-07-17/18 — none of this is speculation.

### What Skybridge 1.2.7 provides (read from the installed package, `node_modules/skybridge/dist/server/auth/`)

- `workosProvider({ domain, audience })` — takes the AuthKit domain (e.g. `<tenant>.authkit.app`) and the MCP server's **Resource Indicator**; fetches AuthKit's OAuth discovery document and builds a complete resource-server `OAuthConfig`. Requires Dynamic Client Registration enabled in the WorkOS dashboard (Connect → Configuration). WorkOS supports DCR natively, so the Alpic DCR proxy (which exists for IdPs without DCR) is not needed.
- One `oauth:` field on `McpServer` mounts everything: protected-resource metadata, `/.well-known/oauth-authorization-server`, and bearer verification (remote JWKS, `iss`, `aud`) on `/mcp`. The per-host OAuth quirks (ChatGPT, claude.ai, Cursor DCR flows) are Skybridge's problem, not ours.
- **Mixed auth is first-class**: `optionalBearerAuth` passes unauthenticated requests through, and each tool declares `securitySchemes` (`noauth` / `oauth2`). Anonymous callers keep the open tools; authenticated callers unlock the gated ones.
- The verified `AuthInfo` — **including the raw bearer token** — reaches tool handlers via the MCP SDK's `extra.authInfo`. Forwarding identity downstream is mechanically possible.

### What the platform does today (from `../../wip/auth/auth-architecture-handoff.md` + source)

- Single choke point: the API Gateway custom authorizer Lambda (`pipelex-api-infra/src/pipelex_lambdas/authorizer/handler.py`). Two auth paths — WorkOS JWT and Pipelex API keys (`plx_sk_...`). Backends never re-verify tokens; they trust forwarded headers.
- JWT verification lives in `infra-python-tools/src/pipelex_shared/adapters/security.py` → `verify_workos_token(token, *, client_id, issuer=None, jwks_url=None)`. It expects `iss = https://api.workos.com/user_management/{client_id}` (observed empirically in production; the public WorkOS docs are misleading on this), verifies against `https://api.workos.com/sso/jwks/{client_id}`, and **disables `aud` validation entirely** because webapp access tokens carry no `aud` claim.
- The authorizer validates an optional `org_id` claim against actual membership (`OrgMembershipAdapter.get(user_id, org_id)`) — anti-smuggling. Gating feature flags (`ff_playground`, `ff_api_keys`) are derived at read time from `org.plan` via `resolve_entitlements`.
- Route-based access control already exists: `is_api_key_allowed_route` / `is_route_allowed_for_flags` in `authorizer/utils.py`.

### What WorkOS AuthKit-for-MCP mints (from workos.com/docs/authkit/mcp)

- AuthKit acts as the OAuth **authorization server** for the MCP server: DCR supported, Resource Indicators (RFC 8707) supported — the MCP endpoint URL is registered as a valid Resource Indicator in the dashboard.
- The access token's `iss` is **the AuthKit domain** (not `api.workos.com/user_management/...`), and its `aud` is **the requested resource indicator** (the MCP server URL). `sub` is the WorkOS user id. Whether `org_id` is present is **unconfirmed** (verification item V-A1).
- WorkOS also offers ID-JAG token exchange ("Cross App Access") — early access, noted as a future upgrade path, not a dependency.

## 2. The shape of the flow

```
ChatGPT / claude.ai / Cursor (console host)
  → OAuth via AuthKit (DCR; user signs in with their Pipelex account)
  → MCP server (Skybridge verifies: iss = AuthKit domain, aud = MCP resource indicator)
  → tool handler forwards the same bearer token to api.pipelex.com
  → API Gateway authorizer verifies it (NEEDS CHANGES — see §4)
  → pipelex-platform (catalog CRUD) / pipelex-api-hosted runner (validate, runs)
```

The MCP server stays a thin front-end: it holds no credentials of its own (beyond what Alpic env config carries), mints nothing, stores nothing. Identity flows through.

## 3. The three gaps Skybridge cannot close

1. **Token mismatch at the gateway.** The authorizer expects `iss = https://api.workos.com/user_management/{client_id}` and tolerates a missing `aud`. AuthKit-for-MCP tokens have `iss` = AuthKit domain and `aud` = the MCP resource indicator. A pass-through fails the issuer check today. The signing keys are very likely the same environment key material (V-A2), so this is an *acceptance-policy* change, not new crypto.
2. **Token pass-through is an anti-pattern unless adopted deliberately.** MCP security best practices warn against a resource server replaying its inbound token upstream (audience binding breaks). We own both ends, so accepting MCP-audience tokens at the gateway is defensible — but it must be **route-scoped** (only the routes the console needs) and **documented as a decision**, with ID-JAG token exchange named as the clean future replacement.
3. **Org context.** Platform routes are org-scoped; the MCP token likely carries no `org_id`. The `X-Org-Id` handshake (README next-step 6) fills this: the MCP server sends the header, the **authorizer** validates membership before honoring it — exact precedent exists in the `org_id`-claim anti-smuggling check.

## 4. Ask to the platform team (self-contained — hand this section over)

> Context for the platform team: the hosted Pipelex MCP server (repo `pipelex-mcp`, deployed on Alpic — i.e. **outside** API Gateway) is adding per-user sign-in for ChatGPT/claude.ai consumers. Users authenticate via **AuthKit acting as an OAuth authorization server for MCP** (WorkOS's supported flow: workos.com/docs/authkit/mcp). The MCP server verifies the token, then calls `api.pipelex.com` **with that same token** on the user's behalf. Those calls traverse your API Gateway authorizer like any other JWT-path request. Today the authorizer rejects these tokens; the changes below make it accept them, deliberately and narrowly. The MCP server itself needs no AWS access and no new platform routes.

**P1 — WorkOS dashboard, per environment (dev/staging/prod):**
- Enable Dynamic Client Registration (Connect → Configuration).
- Register the MCP server URL(s) as valid **Resource Indicators** (per env; the dev Alpic tunnel URL differs from the stable hosted URL).
- Communicate to the MCP team: the AuthKit domain and client id per environment.

**P2 — Empirically pin the MCP token's claims (before any code change):** sign in through the MCP DCR flow once and `jwt.decode` a live token — the same method that established the real `iss` of webapp tokens when the WorkOS docs were misleading. Confirm: `iss` (AuthKit domain?), `aud` (resource indicator?), `sub`, and whether `org_id` / `role` / `email` are present. This decides how much of P4 is needed.

**P3 — `verify_workos_token` accepts a second issuer** (`infra-python-tools/src/pipelex_shared/adapters/security.py`): the function already has `issuer=` / `jwks_url=` parameters (currently documented as test hooks). Extend it (or the authorizer's call) to accept **either** the existing client-scoped `api.workos.com` issuer **or** the AuthKit-domain issuer, with the AuthKit domain's JWKS URL (`https://<authkit-domain>/oauth2/jwks`) as a second key source if the key material differs (P2 will tell).

**P4 — Authorizer acceptance policy for MCP-audience tokens** (`pipelex-api-infra/src/pipelex_lambdas/authorizer/`):
- `aud` policy: keep accepting no-`aud` webapp tokens; **additionally** accept tokens whose `aud` is in a per-env allowlist of registered MCP resource indicators. Never accept an arbitrary `aud`.
- **Route-scope** the MCP-audience acceptance, following the existing `is_api_key_allowed_route` pattern in `utils.py`: MCP-audience tokens should reach only what the console needs — `/v1/validate`, `/v1/build/*`, run lifecycle (`start`/`runs`), and the methods catalog (`GET /v1/methods*`). Explicitly **not** key-minting routes (unchanged invariant: minting stays webapp-JWT-only).
- **`X-Org-Id` header handshake**: if the verified token carries no `org_id` claim, accept an optional client-supplied `X-Org-Id` request header, validate membership via the same `OrgMembershipAdapter.get(user_id, org_id)` check you already run for the claim, deny on mismatch, and forward the resolved `org_id` in the context payload exactly as today. Backends (`pipelex-platform/deps.py` etc.) should need **zero changes** — they keep trusting the same forwarded headers.
- Feature gating: MCP calls ride the existing JWT path, so `ff_playground` (derived from `org.plan`) and the paywall apply automatically. Decide whether MCP console access deserves its own capability slug in the plan catalog (`pipelex_shared/domain/entitlements/`) or rides `ff_playground` — your call; the pattern per `pipelex-api-infra/docs/feature-flags.md`.

**P5 — Tests + security review** of the widened acceptance surface (second issuer, `aud` allowlist, header-sourced org). The lazy-create-or-link path should be exercised too: an MCP sign-in can be a user's first-ever token hitting the authorizer.

**What does NOT change for the platform team:** backends and their header contract; the API-key path (the local "workshop" MCP server keeps using `plx_sk_` keys minted in the webapp — consuming, never minting); the webapp; admin surfaces.

## 5. Work in `pipelex-mcp` (this repo — the easy half)

- `oauth: await workosProvider({ domain: <authkit-domain>, audience: <resource-indicator> })` on the `McpServer`, from env config (per-env values via Alpic).
- `securitySchemes` per tool: `mthds_validate` / `mthds_inputs_template` stay `noauth` (+ `oauth2` for enhanced behavior later); catalog tools (run-by-reference, methods-as-tools) `oauth2`-only.
- Thread `extra.authInfo.token` into the `PipelexApiClient` call (per-request bearer instead of the static `PIPELEX_API_KEY`), plus the `X-Org-Id` header once org selection exists.
- New `ToolError` classifications: 401/403 from the platform on the JWT path (token expired mid-session → re-auth guidance), 402 paywall (already queued in README next-step 4).
- Rough effort: ~1 day once the platform side is agreed, plus org-selection UX (D4).

## 6. Workshop auth — API keys, and the login flow we already have

The workshop (local npm server) never touches the OAuth machinery above. It authenticates to `api.pipelex.com` with a **Pipelex platform API key** (`plx_sk_...`) in env config — the authorizer's programmatic path. Three properties come free: the key is **org-bound at mint time** (so no `X-Org-Id` handshake — the binding *is* the org context; multi-org users use one key per org), the API-key **route allowlist already covers** the workshop surface (`me`, `methods` incl. catalog publish, `runs`, run/build/validate) while excluding key-minting, and gating is the single `ff_api_keys` flag derived from the org's plan. Host→workshop auth does not exist and shouldn't: the server is spawned on localhost by the coding agent for one user.

**Key acquisition is NOT new machinery — the loopback login flow already exists end to end**, shipped for the inference-gateway key:

- `mthds login` (`mthds-js/src/cli/commands/login.ts`) spawns `pipelex login` (`pipelex/pipelex/cli/commands/login/command.py`), which starts a loopback HTTP listener on `127.0.0.1:<ephemeral port>`, opens `https://app.pipelex.com/auth/cli?callback_port=<port>`, and waits (120s timeout).
- The webapp page (`pipelex-app/src/app/[locale]/auth/cli/page.tsx`) routes through hosted AuthKit sign-in if needed (port preserved via `return_to`), then mints a key server-side and redirects the browser to `http://localhost:<port>/callback?api_key=...`; the CLI writes it to `~/.pipelex/.env`.
- The catch: that page calls `generateGatewayApiKey()` — it mints the **gateway** key (`PIPELEX_GATEWAY_API_KEY`, the JWT-only inference-gateway surface that never traverses the authorizer), not the platform `plx_sk_` key the workshop needs. Same UX skeleton, different mint. (Two-keys note: the workshop itself never needs a gateway key — inference happens server-side behind the hosted API.)

Adaptation (small, three parties):

- **W1 — webapp (`pipelex-app` team):** extend `/auth/cli` with a key-type parameter (e.g. `?key_type=platform&callback_port=N`); when set, the server action mints a `plx_sk_` key via the existing `POST /v1/pipelex-api-keys` route using the browser's WorkOS session — the "minting is JWT-only" invariant holds untouched. Give the key a legible label (e.g. `pipelex-mcp workshop`). Org choice at mint time is D7.
- **W2 — workshop npm package (this repo):** port the loopback listener to TypeScript as a `login` subcommand of the workshop launcher bin (~100 lines, mirroring `command.py`). Deliberately do **not** shell out to `mthds login` — it installs the whole Python runtime just to spawn `pipelex login`, and the workshop server is pure Node. Save as `PIPELEX_API_KEY` in `~/.pipelex/.env`; the server's env config falls back to the global env file. On an unconfigured/401 workshop call, the existing `config`-class `ToolError` hint points at the login command.
- **W3 — plugin (`pipelex-plugins`):** the builder opt-in flow instructs `! pipelex-mcp login` exactly as `mthds-plugins`' `mthds-runner-setup` skill instructs `! mthds login` ("opens your browser… automatically saves the API key").
- **Platform team: nothing** — the mint route exists; no authorizer change is involved on this path.

Security posture: this is the RFC 8252 loopback pattern with the key delivered as a query param on the localhost redirect — the same tradeoff the gateway-key flow already accepted (key transits browser history on the user's own machine). Optional hardening (one-time code exchanged for the key server-side) can come later; parity with the existing flow is the bar for now.

## 7. Decisions pending ⚖️

- **D1 — pass-through vs token exchange:** recommend **route-scoped pass-through now** (we own both ends; documented in §4-P4), with WorkOS ID-JAG token exchange named as the upgrade path when it exits early access. The alternative — blocking on ID-JAG — delays the console for a purity gain no attacker model currently demands.
- **D2 — `aud` acceptance policy:** recommend the allowlist model in P4 (no-`aud` webapp tokens + enumerated MCP resource indicators), never blanket `verify_aud: False` for AuthKit-domain-issued tokens.
- **D3 — route scope for MCP-audience tokens:** proposed list in P4; to be confirmed against the final console tool set.
- **D4 — org selection UX:** how does the console pick the org? Options: (a) default to the personal org, override via a tool argument the server passes as `X-Org-Id`; (b) resolve memberships via `GET /me`-style call at session start and let the assistant ask the user. Recommend (a) to ship, (b) as the follow-up. Depends on P2 (does the token carry `org_id` at all?).
- **D5 — MCP-specific entitlement slug vs `ff_playground`:** platform team's call (§4-P4).
- **D6 — which plans grant `ff_api_keys`:** the workshop is the builder on-ramp; if `ff_api_keys` sits on a paid tier only, a new user can't validate or build from Claude Code without paying. Product call (plan catalog), not engineering — but it gates the whole workshop story.
- **D7 — org selection at key mint (`/auth/cli`, W1):** recommend defaulting to the personal org to ship, with an org picker on the page as the follow-up for multi-org users. The mint-time binding replaces any runtime org handshake in the workshop, so this decision fully settles workshop org context.

## 8. Verification items (empirical, before implementation)

- **V-A1** — decode a live AuthKit-for-MCP token: `iss`, `aud`, `sub`, `org_id`/`role`/`email` presence. (= platform P2; blocks P3/P4 detail.)
- **V-A2** — is the AuthKit domain's JWKS (`/oauth2/jwks`) the same key material as `api.workos.com/sso/jwks/{client_id}`? Decides whether P3 needs a second JWKS source or just a second issuer string.
- **V-A3** — does Skybridge support **auth-dependent dynamic `tools/list`**? `securitySchemes` declares gating, but methods-as-tools (doc 3) needs per-user tool projection after sign-in. Fold into the V1/V2 verification plan of doc 4.
- **V-A4** — per-host OAuth reality check during verification V1: ChatGPT, claude.ai, Cursor each complete the DCR flow against AuthKit through Skybridge. (Claude Code consumes the *local* server with API keys — not affected.)
- **V-A5** — Alpic env config: how per-env AuthKit domain / resource indicator values reach the deployed server (Alpic env vars), and what the stable hosted URL is (interacts with README next-step 5's dev-tunnel-URL switch — the registered resource indicator must match the served URL).

## 9. Bottom line

Skybridge collapsed the traditionally-painful half (the MCP OAuth protocol dance) into configuration. The remaining work is ours-as-an-organization but not ours-as-this-repo: a deliberate, narrow widening of the authorizer's acceptance policy at the single choke point the platform already maintains — second issuer, `aud` allowlist, route scoping, `X-Org-Id` validation. A few focused days on their side including review; about a day here. The handoff doc's warning ("if the MCP server runs elsewhere, it cannot reuse this for free — flag that early") is exactly what §4 does. Workshop auth (§6) is even cheaper: the loopback login flow already ships for the gateway key; adapting it to mint the platform key is a webapp page parameter, a ~100-line TS port of the listener, and a plugin instruction line.
