# MCP Apps landscape, Skybridge verification, and the local-UI test plan

Status: fourth doc in the dual-deployment series (after `dual-deployment-assessment.md`, `build-vs-run-dimension.md`, `methods-as-tools-discoverability.md`). Records the 2026-07-17 research that invalidated the "coding agents don't render views" premise, the verification of Skybridge's role, and the concrete plan to verify local UI rendering per host. The earlier docs carry revision notes pointing here.

## 1. The landscape as of July 2026 (researched, not assumed)

- **MCP Apps is an official MCP extension** (launched 2026-01-26, the first official one; spec in `modelcontextprotocol/ext-apps`). A tool declares `_meta.ui.resourceUri` → a `ui://` resource containing HTML; the host renders it in a sandboxed iframe; app↔host communication is postMessage. Crucially, the app↔host channel is independent of the server↔host transport — a stdio-connected server can declare and serve `ui://` resources; the barrier is host rendering support and asset delivery, not transport.
- **Rendering hosts now include**: claude.ai web, Claude Desktop, Claude mobile, **Claude Cowork** ("interactive connectors" — every Claude surface except Claude Code); **Cursor 2.6+** (March 2026, MCP Apps in agent chats); the merged **ChatGPT desktop app** (Chat/Work/Codex modes since 2026-07-09) — Louis verified first-hand that **Codex mode renders our Skybridge UI**, and Cowork does too; also VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, Postman. **Claude Code is now the exception** — the one target in our host set with no view rendering.
- **Cowork is the "full combo" host**: local filesystem access (connected folders), MCP support (and Claude Desktop supports local stdio servers via `claude_desktop_config.json`), and view rendering. It blurs the workshop/console persona line — the first host where the one-host-one-server rule is genuinely ambiguous (builder → local, consumer → hosted).
- **Real-world caveat**: rendering support is uneven in the wild — an open `ext-apps` issue documents Claude Desktop negotiating the UI capability, fetching the resource, and still not rendering when connected through an `mcp-remote` proxy. Any proxy/bridge in our design must forward the UI capability faithfully, and every host claim below gets verified empirically, not assumed.

**Design consequence**: views are a shared asset of both deployment shells, not a hosted exclusive. The local server should ship the same `run-graph`/`run-follow` views; "local = text-only" describes Claude Code alone. This *strengthens* the not-a-product-split message: both doors offer the full experience.

## 2. Skybridge verification (from the installed package + changelog)

Verified against the repo's dependency (upgraded 1.1.1 → 1.2.7 on 2026-07-17; `make check` + full test suite pass unchanged):

- **Skybridge speaks MCP Apps natively.** It depends on `@modelcontextprotocol/ext-apps`. At 1.1.1 it registered every view twice (`ui://views/apps-sdk/...` for the OpenAI Apps SDK dialect, `ui://views/ext-apps/...` with `text/html;profile=mcp-app` for the official profile) — which is exactly why our views rendered in both Codex and Cowork with zero extra work. Since **1.2.0, views emit a single canonical MCP Apps resource regardless of host** (legacy URIs still resolve). Skybridge is the right vehicle for views on any MCP-Apps-capable host.
- **But Skybridge is HTTP-coupled at two levels.** (1) `server.run()` wires only `StreamableHTTPServerTransport` — no stdio code path exists in the package. (2) Deeper: the `ui://` view HTML interpolates a `serverUrl` and the view's JS/CSS bundles and static assets load from that HTTP origin at render time (`window.skybridge.serverUrl`); the view CSP (`resourceDomains`, `connectDomains`) is computed per request from HTTP headers. **Views need an HTTP listener somewhere, even locally** — pure stdio cannot deliver them today.
- **Bonus finding**: since 1.2.0, OAuth is a first-class `McpServer` field with branded providers — **including WorkOS**, which the platform already uses (AuthKit). The hosted console's per-user OAuth critical path (see the build-vs-run doc) has first-class framework support waiting.

## 3. The local-server transport options (revised)

The stdio-vs-HTTP question is no longer a lifecycle-UX preference — it's constrained by view asset delivery:

- **A. Local Skybridge over localhost HTTP.** Works today with no framework changes (`make dev` is literally this; `skybridge start` is the production-mode equivalent). Full views, one server idiom, and the `{ path }` arm gets added to the same server. Cost: hosts don't spawn HTTP servers, so the user manages the process and port.
- **B. stdio launcher + embedded HTTP (recommended, pending verification).** The npm `bin` the host spawns is a thin stdio bridge that boots the same Skybridge HTTP server on an ephemeral localhost port and proxies MCP between stdio and it. Host-managed lifecycle *and* a real origin for view assets. Risk to verify: the bridge must forward the UI capability negotiation faithfully (the `mcp-remote` rendering bug is the cautionary tale).
- **C. Plain stdio, no views.** The original plan. Simplest, but now knowingly drops the live run card in hosts that would render it (Cursor, Cowork, Codex). Fallback if A/B fail verification.

Revised team framing: the local server stops being "a second, view-less shell" and becomes **the same Skybridge server run locally, plus the `{ path }` arm** — closer to one server with two run modes than two servers.

## 4. Verification plan

Goal: an empirical render matrix before the SPEC.md increment commits to per-host claims. Record per cell: host + version, server mode (hosted URL / local HTTP / stdio bridge), tool listing OK, `run-graph` renders, `run-follow` renders **and** its `useCallTool` polling round-trips through the host bridge, completion handoff (`sendFollowUpMessage`) fires, graceful degradation where rendering is absent.

### Phase V1 — local HTTP (option A), no new code

1. Run the current server locally (`make dev`, or `skybridge start` after `make check`) against a reachable Pipelex API.
2. Connect per host and exercise `mthds_validate` (valid bundle → graph) and `mthds_run` (small method → live card → handoff):
   - **Cursor**: URL entry in `.cursor/mcp.json` pointing at `http://localhost:3000/mcp`.
   - **Claude Desktop / Cowork**: custom connector pointing at the localhost URL if accepted; otherwise through `alpic tunnel` (which also isolates whether localhost origins are the blocker vs rendering itself).
   - **ChatGPT desktop (Codex + Work modes)**: app creation with the tunnel URL (the revamp's stdio "executor plugins" noted for V2).
   - **Claude Code**: `claude mcp add --transport http` — expected: tools work, no rendering; confirm the text summaries carry the flow on their own.
3. Record the matrix; any "capability negotiated but no iframe" outcome gets a minimal repro before we build anything on top.

#### V1 results matrix (fill in as tested)

| Host (version) | Registration used | Tools list | `run-graph` renders | `run-follow` renders | Polling round-trips | Handoff fires | Notes |
|---|---|---|---|---|---|---|---|
| Cursor ( ) | `.cursor/mcp.json` localhost URL | | | | | | |
| Claude Desktop ( ) | custom connector — localhost or tunnel? | | | | | | |
| Cowork ( ) | same connector | | | | | | |
| ChatGPT desktop, Codex mode ( ) | app with tunnel URL | | | | | | |
| ChatGPT desktop, Work mode ( ) | same app | | | | | | |
| Claude Code ( ) | `claude mcp add --transport http` | | n/a — text-only expected | n/a | n/a | n/a | do the text summaries carry the flow? |

**Checkpoint** — V1 results decide whether B is worth prototyping: if localhost-origin assets render fine, the remaining risk in B is only the capability forwarding; if V1 itself fails on a host, that host's cell is a rendering gap no transport choice fixes. Update this doc with the matrix, decisions, and open questions before starting V2.

### Phase V2 — stdio bridge prototype (option B)

1. Minimal `bin`: boot the Skybridge HTTP server on an ephemeral port, bridge stdio↔HTTP, forwarding `initialize` capabilities (including the UI extension) verbatim both ways.
2. Register as a stdio server where that's the native mode: Claude Desktop/Cowork (`claude_desktop_config.json`), Cursor (stdio entry), ChatGPT desktop (executor plugin stdio), Claude Code (`claude mcp add`).
3. Re-run the V1 exercise per host; diff the two matrices — any cell that renders in V1 but not V2 is a bridge bug (capability forwarding first suspect).

**Checkpoint** — V2 results pick the local distribution mode (B if clean, A with documented process management if not, C only if both fail broadly). Update this doc, then fold the outcome into SPEC.md's Deployments section.

### In parallel — ask Alpic

Skybridge stdio/local-launcher support is squarely Alpic's territory and we have the channel: ask whether a blessed local mode (stdio transport, or an official launcher pattern, or self-contained view bundles) is on the roadmap before we hand-roll the V2 bridge. Their answer can collapse V2 into "wait for the framework" or confirm we build it.

## 5. Corrections applied to the earlier docs

- `dual-deployment-assessment.md`: "views don't transfer — and that's fine" and the local shell "registers no views" are superseded — revision note added pointing here.
- `build-vs-run-dimension.md`: the lifecycle map's "minus views — polite polling" local cells are superseded — the polite-polling story now describes Claude Code only; revision note added.
- `methods-as-tools-discoverability.md`: unaffected in substance (projected tools carrying the `run-follow` view gets *stronger* — the card renders in more hosts); no correction needed.
