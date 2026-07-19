# Local shell (workshop) — implementation plan

Status: **plan written 2026-07-19, not started**. Branch: `feature/Local-server`. This is the execution plan for `wip/README.md` next-step 3 (green-lit 2026-07-19): the npm-distributed local server for coding agents — **tools-first over stdio, the `{ path }` arm as the headline feature, no views at launch** (V1 verdict: hosts penalize localhost origins; local views wait on Fred's reply about self-contained bundles, which gates nothing here).

## Cold-start protocol (read before working any phase)

1. Read this file top to bottom, then `SPEC.md`, then `CLAUDE.md`.
2. Read the design series per `wip/README.md`: at minimum doc 1 §3 (two shells + consequences), doc 4 §3–§4 (transport options, V1 matrix + checkpoint outcome), doc 6 §6 (workshop auth, W1–W3).
3. Invoke the `skybridge` skill (mandated by `AGENTS.md`) before planning or writing code.
4. Resume at the first unchecked box. The Progress log at the bottom records decisions taken, current state, and open questions from prior sessions.

## Scope

**In scope**: the local stdio shell over the existing capability core; the `{ path }` arm on the shared files schema with per-deployment behavior (local resolves, hosted rejects instructively); the path trust boundary; npm packaging + publish machinery + version lockstep; the SPEC.md increment for the above; E2E verification in Claude Code; the latency baseline measurement.

**Out of scope** (other workstreams, do not drift into them): local views / the stdio↔HTTP bridge (V2 — gated on Fred's reply, see `wip/alpic-ask-fred.md`); catalog run-by-reference and its verdict additions (console workstream, doc 2); methods-as-tools (doc 3); console OAuth (doc 6 §1–§5); the `pipelex-plugins` per-target registration follow-through (queue item 6 — starts after this ships); W1 (webapp `/auth/cli` key-type parameter — `pipelex-app` team) and W3 (plugin skill text). Phase 6 below (the `login` subcommand, W2) is planned but **gated on W1**.

**Auth posture for this build**: the workshop authenticates with a per-user `plx_sk_` platform key in `PIPELEX_API_KEY` via the host's MCP config env. No new auth code; local dev runs with a hand-minted key. The existing `config`-class errors already point at the env vars.

## Checkpoint protocol (mandatory — applies at every CHECKPOINT box)

A checkpoint is a **hard stop**. Do not roll into the next phase in the same breath. At each one:

1. **Verify**: run `make check` and `make t` (plus the phase's own verification items) — all green before anything else. Remember `check` runs `build` before `typecheck` on purpose (view-name registry).
2. **Commit the phase** on `feature/Local-server` and record the SHA in the Progress log below.
3. **Cold-start update**: update this TODOS.md — tick boxes, record decisions taken with their rationale, open questions, and the current state of the code, so a fresh session can resume from this file alone. Update `SPEC.md` / wip docs if the phase changed a documented surface.
4. **Fan out review**: spawn a **fresh Sonnet-5 sub-agent with no inherited context** (a new general-purpose agent, never a fork) to run the `/code-review` skill. Hand it **only a pointer to the changes** — the phase's commit SHA or `git diff <phase-base-SHA>..HEAD` — never this plan, the design docs, or your own conclusions. The review target is clean, solid software without over-engineering. Triage its findings: fix what's real (then re-run step 1), record what's rejected and why in the Progress log.

---

## Phase 0 — Design lock-in + SPEC.md increment

Settle the decisions `wip/README.md` item 3 names, record them, and write the spec before the code.

- [x] **D-L1 — stdio entrypoint.** Leading option: a plain `@modelcontextprotocol/sdk` `McpServer` + `StdioServerTransport` over the shared capability core; the Skybridge stdio bridge (option B) stays parked until Fred answers. Verify the installed MCP SDK version accepts our zod v4 schemas for `registerTool` (the Skybridge shell wraps the same SDK — confirm the raw-shape/JSON-schema path the plain SDK expects, and what JSON Schema hosts will see for a zod union).
- [x] **D-L2 — schema mechanics.** The series already decided the direction: both shells register **identical tool names and one shared files schema** with a `{ path: string }` arm alongside `{ content, uri? }`; the hosted shell rejects `{ path }` items at request validation with an instructive `input_domain` error ("this deployment cannot read files; submit content" + a hint naming the local workshop server). Settle the exact union encoding and the rejection wording.
- [x] **D-L3 — path trust boundary.** Baseline: resolve `{ path }` relative to the server's cwd (the host spawns the server in the workspace); containment check via `realpath` against the cwd subtree; escapes and non-files are `input_domain` errors with `files[i].path` locators. Decide whether to also honor MCP client roots when the host declares them, or defer roots to a later increment (lean: defer — cwd containment is the solid simple core).
- [x] **D-L4 — npm identity + publish machinery.** Package name **decided 2026-07-19 with Louis: `@pipelex/mcp`** — matches the existing `@pipelex/*` scope family on npm (`sdk`, `mthds-ui`, `lsp`, `tools-wasm`, `pipelex`). Still to settle: bin name (lean: `pipelex-mcp`, matching the repo and the server key), publish vehicle (`/release` skill step vs CI on tag — note repo convention keeps deployment out of CI), and confirm the version-lockstep policy (one version number, npm publish and Alpic deploy together — the series' default recommendation).
- [x] **D-L5 — bin build tooling.** Leading option: `tsup` (or esbuild) bundling `src/local/main.ts` to `dist/local/` with a shebang, kept entirely separate from `skybridge build`; wire both into `npm run check` preserving the build-before-typecheck order. Decide and note why.
- [x] **SPEC.md increment**: add a **Deployments** section defining the two shells (hosted console / local workshop, same tool names, same contracts, same verdict discipline); add the `{ path }` arm to the files schema with the per-deployment rejection; reword Non-Goals so "no MCP-side filesystem reads" scopes to the hosted deployment only; state the workshop's tools-first posture (no views at launch) per the V1 matrix. Leave the catalog-related Non-Goals moves to the console workstream.
- [x] Record all decisions in the Progress log below (and any that change the series' standing decisions into `wip/README.md`).

**CHECKPOINT 0** — full protocol above. Verification here is doc coherence: SPEC.md increment consistent with the series and with this plan; the review sub-agent gets the docs diff only.

## Phase 1 — Shared core: files union + resolution seam

The capability core learns about `{ path }` submissions without knowing any filesystem — resolution is a seam the shells fill.

- [ ] Extend `filesInputSchema` in `src/capabilities/shared.ts` to the union per D-L2; export the input type (`{ content, uri? } | { path }`) alongside the existing resolved `SubmittedFile`.
- [ ] Add `resolveSubmittedFiles(files, resolver?)` to `shared.ts`: maps `{ path }` items through a `FileResolver` when one is provided (local shell), and produces the instructive `input_domain` rejection when none is (hosted shell). Resolved items carry `uri` = the submitted path — that's the real-provenance win (diagnostics locate to files the agent can open).
- [ ] Thread resolution through each capability (`validate`, `inputs`, `run` start) via their contexts, ahead of the existing `validateRequest` — one seam, no per-capability forks.
- [ ] Implement the local resolver in `src/local/files.ts`: `fs.readFile`, the D-L3 containment check, and error mapping (missing file, not a regular file, outside the boundary, read failure) to `input_domain` `ToolError`s with `files[i].path` locators. No behavior change for hosted content submissions.
- [ ] Tests: union schema acceptance in each capability's input schema; hosted rejection shape and wording; resolver error cases against a temp directory; capability pass-through with an injected fake resolver (same seam style as the fake `client`).

**CHECKPOINT 1** — full protocol. Extra verification: existing hosted-path tests all green untouched (proof the hosted contract didn't move except the new instructive rejection).

## Phase 2 — Local stdio shell

- [ ] Extract a shared tool-definition table (e.g. `src/tools.ts`): name, description, input/output schemas, annotations, handler wiring for every tool. A plain data module both shells map over — the hosted shell keeps its Skybridge extras (views, CSP, `openai/*` `_meta`) on its side; no abstraction layers beyond the table.
- [ ] Refactor `src/server.ts` (hosted) to consume the table; confirm zero contract drift (`make check` + tests + a DevTools smoke).
- [ ] `src/local/server.ts`: construct the plain MCP SDK `McpServer`, register the same tools from the table with the local resolver in their contexts, and a workshop-adapted `instructions` string (paths are the headline; inline contents stay accepted for parity).
- [ ] `src/local/main.ts` (the bin entry): stdio transport connect, env-derived config (`buildApiConfig` unchanged), graceful shutdown.
- [ ] **stdout discipline**: the transport owns stdout; every diagnostic goes to stderr via one tiny helper (respect the `no-console` ESLint error — helper uses `process.stderr`, or a scoped ESLint override with a comment saying why).
- [ ] Dev loop: document (in `CLAUDE.md` later, Makefile now) how to poke the stdio shell — `npx @modelcontextprotocol/inspector` against the tsx entry, plus a `make dev-local` if it earns its keep.
- [ ] Tests for what's unit-testable: table-driven registration (both shells register the same names/schemas), local context construction wiring the resolver, instructions content.

**CHECKPOINT 2** — full protocol. Extra verification: a live stdio handshake — `initialize` + `tools/list` + one `mthds_validate` by path against a local `pipelex-api` — transcript or output pasted into the Progress log.

## Phase 3 — Packaging + publish machinery

- [ ] `package.json` per D-L4: name, `bin`, `files` allowlist (the local dist + README + license), drop `private: true`; verify `alpic deploy` and `skybridge build` are unaffected.
- [ ] Build target per D-L5: `npm run build:local` producing the executable bundle; wire into `npm run check` (keep the Skybridge build → typecheck order intact).
- [ ] Pack smoke test: `npm pack`, install the tarball in a scratch dir, run the bin via `npx`/`node`, confirm the stdio handshake and `tools/list` work from the packed artifact (catches `files`-allowlist and shebang mistakes).
- [ ] Publish machinery per D-L4: extend the `/release` skill with the npm publish step in lockstep with the Alpic deploy; document the one-version policy in the skill and `CLAUDE.md`.
- [ ] CI: `quality-checks.yml` picks up the new build via `make all`; no publish in CI unless D-L4 decided otherwise.

**CHECKPOINT 3** — full protocol. Extra verification: the pack smoke test output recorded in the Progress log.

## Phase 4 — E2E verification + latency baseline

- [ ] Register the local shell in Claude Code (`claude mcp add` on the packed bin or dist entry) and exercise the full flow on a real method (from `../test-bed/` or `../pipelex-cookbook/`): `mthds_validate` by path, `mthds_inputs_template`, then the run family against the hosted API with a hand-minted key.
- [ ] Verify provenance: force a validation error and confirm diagnostics locate to the real on-disk paths.
- [ ] Verify the trust boundary live: a path outside cwd is rejected with the instructive error.
- [ ] Verify the hosted rejection: submit `{ path }` to the hosted/dev Skybridge server and confirm the instructive `input_domain` error reads well in-host.
- [ ] One-host-one-server: with the claude.ai Pipelex connector synced into Claude Code, confirm what the both-installed state looks like and that the documented guidance (disable the connector via `/mcp`) is accurate.
- [ ] **Latency baseline** (`wip/README.md` queue item 5): on a representative bundle, measure validate-by-content through a host vs validate-by-path through the local shell vs direct `curl POST /v1/validate`. Record the numbers in `wip/dual-deployment-assessment.md` §1 (the open caveat) and in the Progress log — this is the before/after for the local shell's win.
- [ ] Opportunistic: register the stdio bin in one more workshop host (Codex desktop STDIO tab, or Cursor stdio entry) and record a row in doc 4's matrix.

**CHECKPOINT 4** — full protocol. This phase is mostly verification, but any fixes it forced are code — review them like any other phase.

## Phase 5 — Docs sync + release readiness

- [ ] `README.md`: local shell section — what it is, host registration snippets (Claude Code, Codex `config.toml`, Cursor `mcp.json`, Cowork via `claude_desktop_config.json`), the host→server matrix (from `wip/plugin-reconciliation.md` §7), the one-host-one-server rule and the connector-sync warning.
- [ ] `CLAUDE.md`: two-shell architecture, new commands, packaging/publish notes, testing notes for the resolver seam.
- [ ] `SPEC.md`: final pass — declared shapes match the shipped Zod schemas (the standing SPEC/schemas/README sync rule).
- [ ] `CHANGELOG.md`: entries under `## [Unreleased]` (breaking: files schema union; added: local shell, packaging).
- [ ] `wip/README.md`: mark queue item 3 done, note item 6 (plugin follow-through) unblocked; add revision notes in any series doc whose claims this build changed.
- [ ] Update the team artifact (URL in `wip/README.md` → Related material) with the shipped state.
- [ ] Ask Louis whether to cut the release now (`/release`, presumably 0.4.0) or hold for the plugin follow-through.

**CHECKPOINT 5** — full protocol. The review sub-agent gets the docs diff; verification is the SPEC/schema/README coherence check.

## Phase 6 — `login` subcommand (W2) — **GATED: do not start until W1 ships in `pipelex-app`**

- [ ] Confirm W1 is live: `app.pipelex.com/auth/cli` accepts the key-type parameter and mints a `plx_sk_` platform key.
- [ ] Port the loopback login flow to a `login` subcommand of the bin per doc 6 §6: ephemeral localhost listener, open the browser to `/auth/cli?key_type=platform&callback_port=N`, save the key as `PIPELEX_API_KEY` in `~/.pipelex/.env`. Pure Node — no shelling out to `mthds login`.
- [ ] Env fallback: the local shell's config reads `~/.pipelex/.env` when the process env carries no key.
- [ ] The unconfigured/401 `config`-class hint points at the login command.
- [ ] Tests + docs (README onboarding, CLAUDE.md), CHANGELOG entry.

**CHECKPOINT 6** — full protocol.

---

## Progress log

Cold-start state lives here. Each checkpoint appends: date, phase, commit SHA, decisions taken (with why), review findings triaged (fixed / rejected+why), open questions, and anything a fresh session needs that the boxes above don't say.

- **2026-07-19 — plan written.** No implementation started. Working tree carries one staged file unrelated to this build (`wip/alpic-ask-fred.md`, sent to Fred, awaiting reply). Phase-diff base for Phase 0 is the commit that lands this plan.
- **2026-07-19 — D-L4 partially decided.** npm package name is **`@pipelex/mcp`** (Louis; matches the existing `@pipelex/*` scope family). Bin name, publish vehicle, and lockstep confirmation remain open in Phase 0.
- **2026-07-19 — Phase 0 complete (CHECKPOINT 0).** Commit SHA recorded below after commit. Decisions:
  - **D-L1 DECIDED: plain MCP SDK stdio server** (`McpServer` + `StdioServerTransport` from `@modelcontextprotocol/sdk`, already a direct dep at 1.29.0). Verified facts: the SDK peer-accepts `zod ^3.25 || ^4.0` (our zod is 4.4.3) and `registerTool` takes `ZodRawShapeCompat | AnySchema` — the same raw shapes the Skybridge shell registers work unchanged on the plain SDK. Empirically checked (zod v4 `z.toJSONSchema`, `io: "input"`): the files union serializes to a clean `anyOf` of two object schemas with per-field descriptions — host-legible, no weird encoding. The Skybridge stdio bridge (option B) stays parked until Fred answers on self-contained view bundles.
  - **D-L2 DECIDED: one shared `z.union([contentArm, pathArm])` per files item**, registered identically by both shells. Arms stay non-strict objects with first-match semantics — a pathological `{ content, path }` item parses as the content arm and `path` is ignored (documented in SPEC.md); strict arms were rejected because an unknown-key failure would surface as a noisy zod union error from the SDK layer instead of our instructive `ToolError`. Hosted rejection happens at request validation (per item): `input_domain` at `files[i].path`, message "This deployment cannot read files from disk; submit the file contents instead.", hint pointing at resubmitting `{ content, uri? }` and at the local workshop (`npx @pipelex/mcp`). Exact strings finalized in Phase 1 code review, but this is the wording baseline.
  - **D-L3 DECIDED: cwd containment, roots deferred.** Resolve `{ path }` relative to `process.cwd()`; containment via `realpath` (symlinks followed) against the cwd subtree; escapes, missing files, and non-regular files → `input_domain` at `files[i].path`. MCP client roots are deferred to a later increment: host roots support is inconsistent, hosts spawn the stdio server in the workspace anyway, and widening from cwd to roots later is non-breaking, whereas starting from roots risks over-granting on hosts that declare broad roots.
  - **D-L4 COMPLETED: bin `pipelex-mcp`** (matches repo + server key); **publish vehicle = `/release` skill step** (repo convention keeps deployment out of CI; the skill's current "no npm publish" claim gets updated in Phase 3); **lockstep confirmed**: one version number, npm publish and Alpic deploy together at release, so "what's live" stays a one-number question.
  - **D-L5 DECIDED: tsup**, bundling `src/local/main.ts` → `dist/local/` with a shebang banner, runtime deps kept external (they're regular `dependencies`, installed by npm). Why not the siblings' bare-`tsc` approach (mthds-js): this repo's `src/` mixes `.tsx` views and Skybridge imports, so a subset `tsc` build needs a second tsconfig with fragile include-slicing, while an entry-point bundle pulls exactly the local shell + capability core and keeps the published artifact tight. Wired into `npm run check` after `skybridge build` (preserving the build-before-typecheck order) in Phase 3; tsup enters `devDependencies` then.
  - **SPEC.md increment landed**: Deployments section (two shells, `{ path }` arm + per-deployment behavior, path trust boundary, one-host-one-server rule), the three input-shape blocks now reference the shared `SubmittedFileInput` union, flow steps updated, Non-Goals reworded (filesystem reads scoped per deployment; workshop tools-first stated). "package publishing" kept in Non-Goals — traced to the v0.1 spec where it sits next to linting/formatting, i.e. MTHDS package publishing (catalog-adjacent, console workstream's move to make).
  - **No standing series decisions changed** — nothing to write back into `wip/README.md` (the plan itself is queue item 3 in progress).
  - Open questions: none new. Fred's reply still gates V2 local views only.
