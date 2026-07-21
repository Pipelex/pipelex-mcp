# Deferred items from the workshop build (ex-TODOS.md)

Recorded 2026-07-21. The local-workshop implementation plan (`TODOS.md`, Phases 0–5, all complete and shipped through 0.4.0/0.5.0) was deleted after the build wrapped; its full progress log — decisions, checkpoint SHAs, review triages, latency numbers — remains in **git history** (the file lived at repo root until this date). Only the still-open items survive here.

## 1. Team-artifact refresh (deferred by Louis)

Update the team artifact (URL in `wip/README.md` → Related material) with the shipped state — deferred from Phase 5 to "after the release lands." Since then **0.5.0 (BYOK console) has also shipped**, so the refresh should reflect 0.5.0, not just 0.4.0: the workshop on npm, the BYOK console posture (no server-held key, `?api_key=`/Bearer channels), and the revised plugin design (doc 5 §8 — every target bakes the local launcher). One pass via the Artifact tool with the existing URL.

## 2. Phase 6 — `login` subcommand (W2) — **GATED: do not start until W1 ships in `pipelex-app`**

Design source: `auth-design.md` (doc 6) §6, items W1–W3.

- [ ] Confirm W1 is live: `app.pipelex.com/auth/cli` accepts the key-type parameter and mints a `plx_sk_` platform key.
- [ ] Port the loopback login flow to a `login` subcommand of the bin per doc 6 §6: ephemeral localhost listener, open the browser to `/auth/cli?key_type=platform&callback_port=N`, save the key as `PIPELEX_API_KEY` in `~/.pipelex/.env`. Pure Node — no shelling out to `mthds login`.
- [ ] Env fallback: the local shell's config reads `~/.pipelex/.env` when the process env carries no key.
- [ ] The unconfigured/401 `config`-class hint points at the login command.
- [ ] Tests + docs (README onboarding, CLAUDE.md), CHANGELOG entry.

Checkpoint discipline when this runs: verify (`make check` + `make t`), commit, update docs, fan out an independent no-context code review on the diff pointer only — the same protocol the Phase 0–5 log records.

## 3. Minor code observation carried over (flagged in Phase 5, not fixed)

`src/tools.ts`'s `mthds_validate` description reads "…with the local Pipelex API" while the default base URL is the hosted API (the run-family descriptions correctly say "hosted Pipelex API"). Model-facing tool-description string — fold into the next code change with its own verify/review.
