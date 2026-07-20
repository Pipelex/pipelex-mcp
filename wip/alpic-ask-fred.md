# Message to Fred (Alpic CTO) — the local/stdio Skybridge ask

Status: **sent 2026-07-19** — awaiting reply. Written 2026-07-18 as part of the dual-deployment series (README next-step 2); technical claims verified against skybridge 1.2.7 (`mcp-apps-landscape-and-local-ui.md` §2). Record Fred's answers back into that doc's §4 checkpoints before deciding V2; the two smaller asks map to verification items V-A3 and V-A5 in `auth-design.md`. Post-send note: the V1 results (doc 4 §4, same day) sharpened ask #3 — hosts penalize localhost origins (Desktop refuses `http://` connectors; Codex strips views over local HTTP), so **self-contained view bundles now look like the critical path for local views**; worth mentioning in the follow-up conversation.

---

Hey Fred,

Quick one, with some substance behind it. The Pipelex MCP on Skybridge is going great — we upgraded 1.1.1 → 1.2.7 without a scratch, and congrats on 1.2.0: first-class auth with the WorkOS provider landed exactly when we needed it (we're on AuthKit platform-side, so per-user OAuth for our hosted server is shaping up to be config rather than code — chapeau).

Here's what we're designing now, and where you might save us from hand-rolling something you already have on the roadmap.

**The context.** Our MCP serves two different audiences: chat hosts (ChatGPT, claude.ai), where inline file contents are the only channel, and coding agents (Claude Code, Cursor, ChatGPT desktop in Codex mode), where MCP tool arguments are generated token-by-token by the host LLM — so submitting `.mthds` file contents means the model re-types entire files by hand. Slow (we've observed a single method-build session lose 10+ minutes to this) and not byte-accurate. The structural fix is a local deployment of the same server that accepts file *paths* and reads from disk. So: the same Skybridge server, hosted on Alpic for chat hosts, and npm-distributed for coding agents to spawn locally.

**What we found digging into the package.** Skybridge is HTTP-coupled at two levels: `server.run()` wires only `StreamableHTTPServerTransport`, and — more fundamentally — views load their JS/CSS bundles from the server's HTTP origin at render time (`window.skybridge.serverUrl`, CSP computed per request from headers). So pure stdio can't deliver views today. And since MCP Apps rendering now spans Cursor, Cowork, and ChatGPT desktop's Codex mode, we really want the local server to ship the same views as the hosted one, not a text-only downgrade.

**Our current plan, unless you have a better one.** An npm `bin` that hosts spawn as a stdio server: it boots the same Skybridge HTTP server on an ephemeral localhost port and bridges MCP between stdio and it, forwarding the `initialize` capability negotiation verbatim both ways (we're wary of the known `mcp-remote`-proxy failure mode where Claude Desktop negotiates the UI capability, fetches the resource, and still doesn't render).

**The ask:** before we build that bridge — is a blessed local mode on Skybridge's roadmap? Any of these shapes would make us drop our prototype:

1. a stdio transport in `server.run()` (with some story for view assets),
2. an official launcher pattern — the stdio ↔ localhost-HTTP bridge, but yours,
3. self-contained view bundles — assets inlined into the `ui://` resource so views don't need a live HTTP origin. This one would be the killer feature: it fixes rendering through any proxy or bridge generally, not just our case.

Two smaller ones while I have you:

- **Auth-dependent dynamic `tools/list`.** We want per-user tool projection after OAuth sign-in — each method the signed-in user has published becomes its own MCP tool, with `listChanged` firing on auth. `securitySchemes` covers per-tool gating; can the tool *list itself* vary per authenticated session today, or is that roadmap?
- **Deploy logistics.** What's the story for a stable production URL (we're still on the dev-tunnel URL, and it's baked into a plugin we distribute), and the right way to feed per-env config — AuthKit domain, OAuth resource indicator — to the deployed server? The resource indicator has to match the served URL, so the stable-URL question sits on our auth critical path.

Happy to share the full design docs or jump on a call — some of this (especially the self-contained view bundles) might be useful well beyond us.

Cheers,
Louis
