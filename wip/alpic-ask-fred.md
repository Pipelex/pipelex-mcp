# Message to Fred (Alpic CTO) — the local/stdio Skybridge ask

Status: **drafted, NOT sent.** Originally written 2026-07-18 as part of the dual-deployment series (README next-step 2); **rewritten 2026-07-30** against current reality — the first draft was written before the workshop shipped and before Skybridge 1.3, and had gone stale in three ways: it proposed building a stdio↔localhost-HTTP bridge we ended up not building, it framed the dynamic-`tools/list` ask in terms of `securitySchemes` (which 1.3.0 replaced), and it said we were on a dev-tunnel URL (the console has had a stable Alpic URL since 0.5.0).

Technical claims verified against skybridge **1.3.2** (`node_modules/skybridge/`, 2026-07-30) and the V1 host matrix in `mcp-apps-landscape-and-local-ui.md` §4. When Fred replies, record the answers into that doc's §4 checkpoints before deciding V2; the two smaller asks map to verification items **V-A3** and **V-A5** in `auth-design.md`.

Ask priority has inverted since the first draft: **self-contained view bundles (#1 below) is now the critical path**, because V1 showed hosts penalize localhost origins — so a localhost-HTTP bridge would not have bought us views anyway, which is why we shipped the workshop tools-first instead of waiting.

---

Hey Fred,

Quick one, with some substance behind it. The Pipelex MCP on Skybridge keeps going well — we just took 1.2.7 → 1.3.2 without a scratch. The per-tool `auth` field in 1.3.0 is a genuinely nice piece of design: it deleted a guard we had already sketched into our console auth plan. Amusing footnote — we end up using only half of it. Every one of our tools ends in an authenticated call to our own API, so there's no anonymous tool to mix; what we actually adopt is your closed-by-default, which also gives un-signed-in hosts a clean 401 + `WWW-Authenticate` to start the OAuth flow from. Good default to have picked.

Here's what we're designing now, and where you might save us from maintaining something you'd rather own.

**The context.** Our MCP serves two audiences: chat hosts (ChatGPT, claude.ai, Cowork), where inline file contents are the only channel, and coding agents (Claude Code, Codex, Cursor), where MCP tool arguments are generated token-by-token by the host LLM — so submitting `.mthds` file contents means the model re-types entire files by hand. We measured it: the whole penalty is client-side argument emission, and it scales roughly 100× with bundle size (a single method-build session lost 10+ minutes to it). The structural fix is a local deployment that accepts file *paths* and reads from disk.

**What we found digging into the package.** Skybridge is HTTP-coupled at two levels: `server.run()` wires only `StreamableHTTPServerTransport`, and — more fundamentally — views load their JS/CSS from the server's HTTP origin at render time (`window.skybridge.serverUrl`, CSP computed per request from headers). So pure stdio can't deliver views today.

**What we did, having not waited.** We shipped the local server on 2026-07-20 as a **plain MCP-SDK stdio server** over the same capability core as the hosted one — tools-first, no views. So today we run **two shells over one core**: your Skybridge server on Alpic for chat hosts, and a hand-rolled `@pipelex/mcp` stdio bin on npm for coding agents. It works, and the tool surface is identical by construction, but it is a fork we'd rather not maintain: every view we build is console-only, and the coding agents are exactly the audience that would benefit most from seeing a method graph.

We deliberately did *not* build the stdio↔localhost-HTTP bridge the earlier version of this note proposed — our host testing killed it. Claude Desktop refuses `http://` connector URLs outright, and Codex strips views served over local HTTP. So localhost is penalized by the very hosts that would render the views; bridging to a local HTTP origin buys nothing.

**The ask**, in the order that would actually help us now:

1. **Self-contained view bundles** — assets inlined into the `ui://` resource so a view doesn't need a live HTTP origin. This is the one that changes our architecture: it's what would let a local server ship views at all, and it fixes rendering through any proxy or bridge generally, not just our case. If it's on the roadmap I'd like to know roughly when; if it isn't, I'd like to understand what blocks it.
2. **A blessed stdio mode** — a stdio transport in `server.run()`, or an official launcher pattern. On its own this doesn't get us views (see #1), but combined with #1 it would let us delete our hand-rolled shell and go back to one Skybridge server for both targets. That's the outcome I'd most like.

Two smaller ones while I have you:

- **Auth-dependent dynamic `tools/list`.** To be precise, since 1.3.0 lands nearby but doesn't cover this: we want the tool *list itself* to vary per authenticated session, with `listChanged` firing on sign-in — each method a signed-in user has published in our catalog becoming its own MCP tool. Per-tool `auth` gates *invocation* of a static list, which is orthogonal (and we're adopting it happily). I read 1.3.2 to check before asking: the tool table is static and the `tools/list` interceptor only hoists `securitySchemes` onto the descriptor for SEP-1488. Is per-session projection possible today by some route I've missed, or is it roadmap?
- **Stable production URL / custom domain.** We're serving the console from `pipelex-mcp-a3c6a115.alpic.live`. Our OAuth Resource Indicator has to match the served URL and be pre-registered with WorkOS, so I need to know whether that hostname is stable for the life of the project, and what the custom-domain story is. (Related: I noticed `oauth.baseUrl` is optional and the well-known metadata origin resolves per request from `x-forwarded-host`/`origin`/`host` — that solved half the problem for us already. Nice touch.) Also: the DevTools deploy button in 1.3.0 is a real ergonomics win, thank you.

Last thing, pure curiosity rather than an ask: Agent Skills over MCP (SEP-2640) lands right next to something we're building — we ship a Claude Code plugin with skills that drive this server, and serving them from the server instead is an interesting inversion. Happy to be a guinea pig if you want feedback while it's experimental.

Happy to share the full design docs or jump on a call — some of this (especially the self-contained view bundles) might be useful well beyond us.

Cheers,
Louis
