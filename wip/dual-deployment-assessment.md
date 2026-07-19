# Dual-deployment MCP: hosted + local — assessment and direction

Status: direction agreed, not yet designed in detail. This document recaps the assessment that led to the decision to pursue a dual-deployment `pipelex-mcp` (the hosted Skybridge server plus a new local server from the same repo). It is the input for the upcoming SPEC.md increment; nothing here is implemented yet.

**Revision 2026-07-17**: the view-asymmetry premise used below ("coding agents don't render views") is stale — MCP Apps became an official extension and rendering spread to Cursor, Cowork, and the ChatGPT desktop app (Codex mode included); separately, Skybridge turns out to be HTTP-coupled in ways that reshape the local shell's transport choice. Where this doc conflicts with `wip/mcp-apps-landscape-and-local-ui.md`, that doc wins.

## 1. The problem that started this

Validation through the MCP feels slow. The diagnosis: when a host (ChatGPT, claude.ai, Claude Code via connector) calls `mthds_validate`, the tool arguments are generated token-by-token by the host LLM — there is no other channel from the conversation to the server. The full text of every `.mthds` file in the closure is re-emitted as output tokens, JSON-escaped (newlines become `\n`, which inflates the count further). At typical decode speeds, a multi-thousand-token bundle costs tens of seconds before the MCP server even receives the request. The actual `POST /v1/validate` round trip is a small fraction of the total.

The cost compounds in exactly the flows SPEC.md promotes:

- **The repair loop** (validate → fix → validate) re-emits the entire bundle every iteration, including unchanged files.
- **The tool chain** (`mthds_validate` → `mthds_inputs_template` → `mthds_run`) takes `files` three times — the same bundle is hand-copied three times for one run.
- **Context growth**: each emitted copy stays in the transcript as tool-call arguments, so the conversation carries multiple copies of the bundle alongside the original.

Beyond latency there is a correctness risk: an LLM copying content by hand can silently truncate or "helpfully fix" it, so what gets validated is not guaranteed byte-identical to what the user has on disk.

Caveat still open: we have not measured the split. A direct `curl` of `POST /v1/validate` with a representative bundle, compared against the wall-clock of the same call through a host, would confirm that argument emission dominates (expected) versus API-side dry-run/render time or Alpic cold starts (possible contributors).

## 2. The key insight: transport decides filesystem access, not the rule

SPEC.md's Non-Goals currently forbid MCP-side filesystem reads. Lifting that rule is necessary but not sufficient — what actually decides whether the server can read files is **where the server process runs**:

- **Remote (today's deployment)**: the Skybridge HTTP server runs on Alpic. Every host — including Claude Code via the claude.ai connector — connects over the network. The server physically cannot see the user's disk, and MCP offers no client→server file channel to bridge that: tool arguments are the only data path, and they are LLM-generated. (MCP *roots* only advertise `file://` URIs the server could resolve if it were local; *resources* flow server→client, the wrong direction.)
- **Local (stdio)**: the host spawns the server as a subprocess on the user's machine. Server and files share a disk, so tools can accept **paths instead of contents**.

So the structural answer to the slowness in coding agents is a local deployment of the server — while the hosted deployment remains the only possible answer for filesystem-less chat hosts, where inline `files` is genuinely the only channel.

## 3. What this means technically

One repo, one capability core, two thin server shells. These are genuinely **two servers** in every operational sense — different transports, lifecycles, release channels, configs — sharing one logical product identity (same tool names, same structured contracts, same verdict discipline).

**Shared core (the bulk of the repo, unchanged):** `capabilities/validate.ts`, `capabilities/inputs.ts`, the run capabilities, `shared.ts` — Zod schemas, request validation, `classifyError`, the `PipelexApiClient` calls, and the projection into `structuredContent` + summaries. None of it knows what transport invoked it. The tests already inject a fake client rather than a transport, so they ride along.

**Shell 1 — hosted (exists today):** `server.ts`, Skybridge HTTP on Alpic. Content-only `files` schema, registers the `run-graph` and `run-follow` views. Serves ChatGPT, claude.ai, and any remote connector.

**Shell 2 — local (new):** an npm package with a `bin` so hosts launch it via `npx`, registering the same tool names backed by the same capabilities, with the `files` schema also accepting `{ path }` items (resolved with `fs.readFile` before handing to the shared capability). *(Superseded detail: this was originally scoped as a plain-SDK stdio entrypoint with no views. Per the landscape doc, the local shell should ship the same views, which requires an HTTP listener for view assets — the leading option is a stdio launcher that boots the same Skybridge server on an ephemeral localhost port. See `wip/mcp-apps-landscape-and-local-ui.md` §3.)*

Consequences to design for:

- **Honest schemas per deployment.** The hosted server must reject `{ path }` items with a crisp `input_domain` error ("this deployment cannot read files; submit content") so accidental misrouting diagnoses itself on the first call. The failure mode to avoid is silent divergence between two servers carrying the same tool names.
- **Build separation.** *(Superseded — the local shell keeps Skybridge and the views; see the landscape doc.)*
- **Version skew becomes real.** Today the deployed server is the only version in existence; with an npm-distributed local shell, users hold versions while the hosted API moves. The hosted API becomes the compatibility anchor — old local servers against the current API is the pairing that has to keep working, which is where the workspace's no-backward-compat rule starts costing something.
- **npm publish machinery returns.** The repo deliberately has none (stripped from the workflows ported from sibling repos). The local shell brings back: a package name, `bin` wiring, a publish step in CI or the `/release` skill, and a lockstep decision (default recommendation: one version number, published and deployed together, so "what's live" stays a one-number question).
- **Trust boundary on the local server.** It will read whatever path the model names and ship it to the hosted API. In coding agents the model already has broad read access through its own tools, so marginal exposure is small — but the local server should honor the host's declared roots (or at least the working directory) rather than resolving arbitrary absolute paths.
- **SPEC.md changes**: reword Non-Goals from "no MCP-side filesystem reads" to scope it to the hosted deployment; add the `{ path }` arm to the shared files schema for the local shell; add a "Deployments" section defining the two shells.
- **Relationship to `mthds-agent`**: a local stdio server that reads paths and forwards to the hosted API is architecturally the same object as `mthds-agent --runner api`, speaking MCP instead of argv. What the MCP packaging adds is host-native ergonomics: no Bash permission prompts, typed tool schemas, structured results, and one set of tool names identical across every host — the property the CLI-free `pipelex-plugins` skills are built around.

## 4. What this means for features

The feature set does not fork — every tool works on both servers — but *how well* each feature lands depends on the server × host pairing, and the split turns out to be natural rather than a compromise.

| Feature | Hosted server | Local server |
|---|---|---|
| `files` as inline content | Yes (the only channel) | Yes (kept for parity/fallback) |
| `files` as `{ path }` | Rejected with instructive `input_domain` error | Yes — the headline feature |
| `mthds_validate` / `mthds_inputs_template` | Works; slow on large bundles (LLM emits contents) | Works; near-constant token cost, byte-accurate reads |
| Real provenance in diagnostics | Only if the LLM fills `uri` by hand | Automatic — errors locate to actual files the agent can open and edit |
| Run family (`mthds_run` / `_status` / `_results`) | Full, including the `run-follow` view and its completion handoff | Full — live card renders in Cursor/Cowork/Codex; text-only polite-polling in Claude Code |
| Skybridge views (`run-graph`, `run-follow`) | Yes — ChatGPT, claude.ai, Cowork, mobile | Yes (same views) — pending the per-host render verification in the landscape doc |
| Auth | Server-held key today; **per-user OAuth required before directory distribution** | Per-user `PIPELEX_API_KEY` in the host's MCP config env — per-user auth for free |

*(Superseded observation: this doc originally argued the split was "natural" because view-rendering hosts and filesystem hosts didn't overlap. MCP Apps rendering now spans Cursor, Cowork, and ChatGPT's Codex mode, so views are a shared asset of both shells — which strengthens the design rather than weakening it: both doors offer the full experience, and Claude Code is the one text-only target. See `wip/mcp-apps-landscape-and-local-ui.md`.)*

## 5. Recommendation: ChatGPT and claude.ai → hosted server

Chat hosts have no filesystem, so inline `files` is the only possible channel and the hosted server is the only deployment that can serve them. This is also where the product's visual differentiators live: the `run-graph` dry-run view and the `run-follow` live card with its completion handoff.

- **Distribution**: ChatGPT via the apps directory submission (the Skybridge publish flow — OpenAI review is effectively the release gate for that channel); claude.ai via connector (custom URL now, directory listing later). Users connect; nothing installs. Redeploying updates every user instantly, with exactly one live version per environment.
- **Prerequisite pulled forward**: broad distribution through directories requires **per-user OAuth** — the single server-held `PIPELEX_API_KEY` works for us but not for strangers from a directory. This item currently sits in SPEC.md's Non-Goals; directory publication makes it real work.
- **Accepted cost**: the hand-copy latency remains on these hosts. It is irreducible there — the LLM must emit content once to get it off the conversation and onto the platform. (A separate, deferred idea — a bundle handle / content-hash scheme behind the hosted API — could eliminate the repeat copies even on chat hosts; explicitly not being pursued now.)

## 6. Recommendation: Claude Code, Codex, Cursor → local server only

The rule to publish: **one host, one Pipelex server — the local one wherever there's a filesystem, the hosted one everywhere else.** Actively warn against installing both in the same host.

Why both-at-once is strictly worse:

- **Nondeterministic tool routing.** Two near-identical tool sets under different prefixes; nothing guarantees the model picks the local one, and every remote pick silently reverts to the slow hand-copy path. Mixing servers mid-flow breaks nothing technically (state lives behind the durable API) but makes every anomaly start with "which server answered?".
- **Contradictory schemas under identical names** — the local server accepts `{ path }`, the hosted one rejects it.
- **Pure context overhead** — double the tool registrations for no added capability: both servers now carry the same tools *and* the same views.

The wrinkle that makes a doc note insufficient: users can land in the both-installed state **without choosing it**. A Claude Code user signed into claude.ai with the Pipelex connector enabled gets the hosted tools synced into coding sessions automatically. Guidance must name this: disable the Pipelex connector for Claude Code sessions (`/mcp`) when the local server is registered.

Operationalizing:

- **Distribution**: npm package invoked via `npx -y` from the host's MCP config — `claude mcp add` or project `.mcp.json` for Claude Code, `~/.codex/config.toml` for Codex, `.cursor/mcp.json` for Cursor. The most natural vehicle for Claude Code is **bundling the server registration into the `pipelex-plugins` plugin**, making the plugin the single distribution unit for skills + server; the plugin install flow is also the natural place to detect duplicate hosted tools and tell the user what to disable.
- **Docs**: a host→server matrix in the README and `pipelex-plugins` (drafted in `plugin-reconciliation.md` §7), the one-host-one-server rule, and the connector-sync warning.
- **Soft server-side nudge**: the hosted server's `instructions` string can advise preferring a local pipelex server when one is registered — advisory only, a mitigation for accidental overlap, not a substitute for the rule. Enforcement is impossible from the server side (MCP gives a server no visibility into what else a host has registered), so the posture is: make both-installed hard to reach accidentally, and make the hosted `{ path }` rejection loud and instructive so overlap self-diagnoses.

## 7. Open items before design

- Measure the latency split (direct API call vs through-host wall-clock) to confirm emission dominates and to have a baseline for the win.
- Decide the schema split mechanics: one union schema with per-deployment rejection vs genuinely different registered schemas per shell.
- Pick the npm package name and the version-lockstep policy between npm publish and Alpic deploy.
- SPEC.md increment: Non-Goals rewording, `{ path }` arm, "Deployments" section — then the usual SPEC/README/schema sync.
- Sequence the per-user OAuth work relative to directory distribution of the hosted server.
- Decide where local-server registration lives in `pipelex-plugins` and what its duplicate-detection/UX looks like.
