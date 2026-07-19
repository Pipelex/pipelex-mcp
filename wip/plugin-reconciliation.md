# Plugin reconciliation: one plugin, per-target server shapes

Status: fifth doc in the dual-deployment series (after `dual-deployment-assessment.md`, `build-vs-run-dimension.md`, `methods-as-tools-discoverability.md`, `mcp-apps-landscape-and-local-ui.md`). Answers "we have two MCP shapes — do we need two plugins?" for `../pipelex-plugins`. Direction agreed in discussion; the implementation lands in `pipelex-plugins` (and gets documented there when it does).

## 1. The question, and the short answer

The Pipelex MCP is distributed to coding agents as part of the `pipelex` plugin (`../pipelex-plugins`): skills + hooks + an MCP server registration in one install. With the dual-deployment decision (hosted console + local workshop), does the plugin fork too?

**No. The two MCP shapes don't map to two plugins — they map to two distribution channels, and the plugin repo's per-target build system is already a per-channel packaging mechanism.** One logical plugin, one marketplace, one skill set; each build target bakes exactly one server registration appropriate to its channel. It is the plugin-layer mirror of the one-host-one-server rule: **one install, one server.**

## 2. What the plugin is today (verified in the repo)

- `pipelex/.claude-plugin/plugin.json` declares `mcpServers.pipelex` as `type: http` pointing at the hosted URL (currently the Alpic dev tunnel; to be switched to the stable URL on deploy).
- That URL is already a template variable: `mcp_server_url` in `targets/defaults.toml`, overridable per target (`codex.toml`, `mistral-vibe.toml`, `prod.toml`). The scaffolding was built from day one to bake different values per platform into one logical plugin — the server *shape* is just the next variable to promote (URL vs launch command).
- The `defaults.toml` comment records a load-bearing fact: the URL is baked as a literal because marketplace installs include **the Claude desktop app, where no env var expansion happens**. The Claude marketplace artifact therefore serves two personas at once: Claude Code (builders) and Claude Desktop/Cowork (consumers).
- The repo is deliberately CLI-free — no install/upgrade/env-check machinery survived from `mthds-plugins`. Any design that bakes `npx` into the default artifact quietly reintroduces an environment requirement that repo philosophy explicitly shed.

## 3. Why the plugin doesn't fork

- **Skills reference tool names verbatim, and both server shapes expose identical tool names.** That was a deliberate design property of the tool-naming convention (SPEC.md → Naming Conventions; `pipelex-plugins/docs/decisions.md`), and this is the moment it pays off: the manual is shared across shapes with zero edits. Hooks likewise.
- **Tool prefixes stay stable per host.** Keep the `mcpServers` key `pipelex` in both shapes and the flattened names (`mcp__plugin_pipelex_pipelex__mthds_validate` on Claude Code) are identical regardless of which shape the target baked — skills and docs never need per-target tool references.
- **The hosted server's main distribution never touches a plugin.** ChatGPT and claude.ai get it via app directory / connector. The plugin question only exists where plugins exist, which is predominantly the local server's territory.

## 4. The one genuine tension: the Claude target serves two personas

The Claude marketplace artifact is installed by builders (Claude Code — node available, want the local workshop) and consumers (Claude Desktop/Cowork — node not guaranteed, want the zero-dependency hosted console). One artifact, two wants. Three resolutions, in order of preference:

1. **Hosted-by-default, local as explicit builder opt-in (recommended).** The marketplace plugin keeps declaring the hosted URL — zero-dependency, Desktop/Cowork consumers untouched. Builders flip to local via a documented `claude mcp add` of the launcher (or a small setup skill that does it and reminds them to disable the plugin's hosted entry). Cost: one manual step for builders; the opt-in flow is also the natural place to warn about the both-installed state.
2. **A second thin plugin variant in the same marketplace** (`pipelex` hosted + `pipelex-local` for builders — identical skills, different server block). The honest version of "two plugins": not two products, two registration flavors, scoped to the one marketplace where the channel ambiguity exists. Doubles the artifact count for one line of difference and invites the duplicate-tools mistake; hold in reserve if option 1's friction proves real.
3. **Flip the Claude target to the local command.** Only if verification shows Claude Desktop reliably spawns `npx` servers and the node dependency is acceptable for consumers. Not the lead option.

No such ambiguity elsewhere: the **Codex target bakes the local launcher outright** (the revamped ChatGPT desktop app supports stdio MCP servers via executor plugins, and the Codex plugin channel serves builders). **Mistral Vibe** follows the same logic pending its MCP support details.

## 5. What changes in `pipelex-plugins` when this lands

- Promote `mcp_server_url` to a per-target **server declaration block**: shape (`http` URL vs launch command + args), keeping the server key `pipelex` in every shape.
- Codex target: local launcher command. Claude targets (`defaults`/`prod`): hosted URL unchanged. Vibe: pending.
- Add the builder opt-in path for Claude Code (docs or setup skill): register the local launcher, disable the plugin's hosted entry, with the duplicate-tools warning inline.
- The host→server matrix and the one-install-one-server rule go in the plugin README (the user-facing home of the guidance drafted in `dual-deployment-assessment.md` §6).
- Version note: the plugin pins nothing — the local launcher command is `npx`-resolved from the npm package, so the plugin's own version stays decoupled from the server's (the same skew reality as any npm distribution; the hosted API remains the compatibility anchor).

## 6. Open questions

- Can the Claude desktop app spawn command-type plugin MCP servers at all, and is node presence acceptable there? (Feeds the option 1 vs 3 decision; test alongside the V1/V2 render verification in `mcp-apps-landscape-and-local-ui.md`.)
- Does a **Cursor** target join the plugin matrix, or does Cursor stay a docs-only channel (`.cursor/mcp.json` snippet with the launcher command)? Cursor renders MCP Apps since 2.6, so it's a first-class workshop host either way.
- Mistral Vibe's MCP registration mechanics — URL, command, or none.
- Where the builder opt-in lives: plain README instructions, or a setup skill in the plugin (a skill that edits host config crosses into machinery the CLI-free philosophy avoided — decide deliberately).
- Timing: the Claude target's baked URL must switch from the Alpic dev tunnel to the stable hosted URL when `pipelex-mcp` deploys — independent of everything above, and worth doing first.

## 7. Addendum (2026-07-18): build targets are not the host→server matrix

A recap discussion surfaced a confusion worth pinning: **the plugin's per-target build system and the host→server matrix answer different questions, and their rows don't map 1:1.** Targets answer "what artifact does each distribution channel get?"; the matrix answers "which server should each host run?". They diverge in both directions — one artifact serves multiple hosts (the Claude marketplace artifact installs into Claude Code, Claude Desktop, and Cowork alike), and the console's main hosts get no artifact at all (ChatGPT web via apps directory, claude.ai via connector — §3). Reading the target table as the deployment map produces wrong conclusions; keep the two tables separate wherever this gets documented.

Two clarifications that follow:

- **Artifact default ≠ host intent.** The Claude marketplace artifact bakes the hosted URL, but that is a packaging fallback forced by the weakest installer in its audience (Claude Desktop: no node guarantee, no env-var expansion) — not a statement that Claude Code should use the hosted server. The rule from `dual-deployment-assessment.md` §6 stands: Claude Code's intended operating mode is the **local workshop**; the baked hosted default is only what a Claude Code install falls back to before the builder opt-in (§4 option 1).
- **The Desktop/Cowork = console classification is a persona assumption, not a host property.** They sit in the console column because the *consumer* flow runs published methods by reference (`mt_<id>` — content never crosses the LLM, so hosted costs a consumer nothing in latency) and node isn't guaranteed on a consumer's machine. But Cowork is the "full combo" host (`mcp-apps-landscape-and-local-ui.md` §1): filesystem access, stdio support via `claude_desktop_config.json`, view rendering — a Cowork user doing builder-shaped work (authoring `.mthds` files locally) would want the workshop. If Cowork usage proves builder-shaped, the classification flips toward §4 option 3; that test rides with the V1/V2 render verification (§6 first open question).

The host→server matrix as currently agreed (drafted here; final homes per `dual-deployment-assessment.md` §6 are the repo README and this plugin's README when implemented):

| Host | Server | How it gets it |
|---|---|---|
| ChatGPT (web) | Hosted console | Apps directory — no plugin |
| claude.ai (web + mobile) | Hosted console | Connector — no plugin |
| Claude Desktop / Cowork | Hosted console (consumer-persona assumption, see above) | Claude marketplace plugin, hosted URL baked |
| Claude Code | **Local workshop** (text-only host — no views) | Same plugin installs the hosted default → builder opts in to the local launcher |
| ChatGPT desktop (Codex mode) | Local workshop | Codex plugin channel, launcher baked |
| Cursor | Local workshop | Docs-only `.cursor/mcp.json` snippet or a future target (open, §6) |
| Mistral Vibe | Pending — expected local | `pipelex-vibe` plugin, pending Vibe's MCP mechanics (§6) |
