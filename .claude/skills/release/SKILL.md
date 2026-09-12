---
name: release
description: >
  Cut a release of pipelex-mcp, the MCP servers over the hosted Pipelex API: the
  release/vX.Y.Z worktree, the package.json bump and the package-lock.json that
  follows, the changelog entry whose heading carries no `v`, the quality gates,
  one commit, and a pull request to main, whose merge is what publishes to npm
  and deploys the hosted console. Use when the user says
  "release", "cut a release", "bump version", "prepare a release", "make a
  release", "ship it", "create release branch", "promote dev to main", "publish
  to npm", or any variation of shipping a new version of pipelex-mcp. Changelog
  content passed inline ("/release Added a codegen target") becomes the entry.
  The merge is landed by /ledger-land, never by this skill.
---

# Releasing pipelex-mcp

The procedure is the workspace release play, [`docs/releasing.md`](../../../../docs/releasing.md) at the workspace root — read it first, then run it with what follows. The repo key is `pipelex-mcp`, the base is `dev`, and the pull request targets `main`: `guard-branches.yml`'s `gate-main` job refuses any head branch into `main` but `release/vX.Y.Z`, so there is no other way in. The release worktree is `_pipelex-mcp--release`, made with `wt add pipelex-mcp release --branch release/vX.Y.Z`. The repo declares neither `.worktree.toml` nor `.worktreeinclude`, so `wt` resolves the base from `origin/dev`, copies the main checkout's `.env` by the default rule, and provisions with the Makefile's `install` target (`npm install`) — which is what puts `node_modules` in the worktree for the gates below.

## What ships

**The merge to `main` ships both surfaces.** `.github/workflows/release.yml` fires on the push to `main`, so the merge of the release pull request *is* the release: nothing is dispatched, and the run to watch is the one keyed to the merge SHA. The workflow keeps its `workflow_dispatch` trigger for one purpose only — retrying a single leg after a partial failure, at the same version:

```bash
gh workflow run release.yml -f version=X.Y.Z -f target=npm     # or alpic; version with no `v`
```

On the push the run checks out its own merge commit, and its `guard` job refuses to go on unless `CHANGELOG.md` carries a `## [X.Y.Z]` heading for the version `main`'s `package.json` names. It then re-runs `make all` on that commit rather than trusting the pull request's own run, and asks `npm view` whether the version is already published, failing the run outright when the registry cannot answer rather than guessing at it — which is what also makes a push to `main` that is not a release a green no-op, with both legs and the tag skipped. A dispatch answers to one check more, that the typed `version` equals `main`'s `package.json`, and it checks out `main` whatever ref it was fired from, so it can neither ship a branch nor ship the wrong bump. From there:

- **The `@pipelex/mcp` package on npm** — the local workshop shell, whose `files` list publishes `dist/local`, `README.md` and `LICENSE`, with `prepack` rebuilding `dist/local` so the tarball is built from the commit being shipped. It goes out as `npm publish --access public --provenance` under npm trusted publishing, so no npm token exists anywhere; **the registration is bound to the filename `release.yml`**, and renaming or moving that workflow breaks publishing until the trusted publisher is re-registered. The `guard` job asks `npm view @pipelex/mcp@X.Y.Z` first and the publish step is skipped when the version is already there, so neither a re-run of the merge's run nor a dispatch at the same version can publish twice.
- **The hosted console on Alpic** — `npx alpic deploy --non-interactive`, authenticated by the `ALPIC_API_KEY` repo secret. The workflow passes no ids of its own: the project, team and environment come from the tracked `.alpic/project.json`, which pins Production and is the only thing telling a release where to go. `make deploy-dev` and `make deploy-staging` relink that file and restore it from a `trap`, so a leftover link is what would silently ship a release to the wrong console.
- **The `vX.Y.Z` tag** — the `tag` job, which needs `guard`, `publish` and `deploy` and runs only when the run is shipping both surfaces, which a merge always is and a one-leg dispatch never is. It creates the tag with `git tag`, so the tags here are **lightweight**, and it leaves an existing tag alone.

The landing verifies the `release.yml` run on the merge SHA, which is the play's default reading, so keep the release item open until that run is green.

```bash
gh run list --workflow=release.yml --limit 3 --json conclusion,event,headSha,url,createdAt   # the run whose headSha is the merge: success
npm view @pipelex/mcp version                                                                # the registry's answer: X.Y.Z
git fetch --tags --prune origin && git tag --list vX.Y.Z                                     # the tag
```

The console leg is verified from that run's *Deploy the hosted console to Alpic* job, which writes what it shipped into the run summary; the endpoint the README publishes is <https://pipelex-mcp-a3c6a115.alpic.live/mcp>. A partial failure is retried one leg at a time — `-f target=npm` or `-f target=alpic`, same version — and never by bumping the version. A release finished that way carries no tag, because the `tag` job runs only for a both-surface run: dispatch `-f target=both` at the same version to reach it, which is safe by the workflow's own guards, since the publish step skips a version already on npm, an Alpic deploy is idempotent per commit, and the tag step leaves an existing tag alone. That recovery is only valid while `main`'s tip is still the release merge, because a dispatch checks out `main` and not the commit the release shipped from: anything landed on `main` since would be what the console receives and what the tag names. Re-running the merge's own run is not the way: once npm holds the version, a push-triggered run skips both legs by design, which is the same rule that keeps a non-release push quiet. The dispatch is the retry door precisely because it ignores that skip.

## Version files and the lock

- **`package.json`** — the `"version"` field, with no `v` prefix. It is the only file the number is written in: nothing under `src/` carries a version literal, and the workflows read it back with `node -p "require('./package.json').version"` and `jq -r .version package.json`.
- **The lock** — `npm install --package-lock-only`, which rewrites `package-lock.json` from `package.json` without touching `node_modules`. The number lives there twice, as the top-level `"version"` and as `packages[""].version`; `node -p "require('./package-lock.json').version"` confirms the first, and both must have moved before the commit. If the command fails, stop and report it rather than committing a stale lock.
- **Also stamped:** nothing. No badge, no literal, no exported artifact carries the version.

## Gates

Run in the worktree, in this order, before the commit:

1. **`make check`** — `check-no-local-deps` first, then `npm run check` (eslint, `prettier --check`, `skybridge build`, `tsup`, and `tsc --noEmit` over both tsconfigs). `check-no-local-deps` fails when `@pipelex/mthds-ui` or `@pipelex/sdk` in `package.json` is a `file:`, `link:` or `portal:` link — what `make use-local` leaves behind — and the cure it names is `make use-npm`, because such a link resolves neither on Alpic's build machine nor in a published tarball. Note the guard greps for those two names only, so read the `@pipelex/mthds-form` line by eye. Red blocks the release: fix the code, never loosen the target.
2. **`make agent-test`** — the same hermetic Vitest suite as `make test`, run so an agent can afford to watch it: quiet unless it fails, with a heartbeat line while it runs.

Neither rewrites a tracked file — `npm run check` only checks formatting, and what it builds lands in the gitignored `dist/`. CI runs `make all` (`clean check test`) instead, both on the pull request and again inside the release workflow's `guard` job, and the `clean` it starts with removes `dist/`, `coverage/` and `*.tsbuildinfo`: when the two gates above are green and CI is not, `make all` is what reproduces CI here.

## The release commit

`package.json`, `package-lock.json` and `CHANGELOG.md`, staged by name. Nothing else, since no gate rewrites a tracked file.

## CI on the release pull request

- **`guard-branches.yml`** (`gate-main`) — the head branch into `main` must match `^release/v[0-9]+\.[0-9]+\.[0-9]+$` and must live in this repository rather than a fork.
- **`version-check.yml`** — `package.json`'s version equals the `X.Y.Z` in the release branch name **and**, when the base is `main`, is strictly greater than `main`'s current version, compared with `sort -V`. It fires on pull requests into `main` and into a `release/vX.Y.Z` branch, which is how a `dev`-into-release promotion is held to the same number; `gate-dev` in `guard-branches.yml` is what lets `dev` be the head there, alongside the usual work-branch prefixes.
- **`changelog-check.yml`** — on a pull request into `main` whose head starts with `release/v`: `CHANGELOG.md` must carry a `## [X.Y.Z]` heading, with **no `v`**. It asserts nothing about `[Unreleased]`; leaving none behind is the play's rule, not CI's.
- **`quality-checks.yml`** — `npm ci` then `make all` on Node 24, on every pull request, with a concurrency group that cancels a superseded run for the same ref. Its comment states the intent that this status be the one the branch-protection ruleset requires before anything merges.

`release.yml` is not among them: it has no pull-request trigger and gates nothing here — it fires afterwards, on the push the merge makes.

## Particulars

- **The changelog heading carries no `v`** — `## [X.Y.Z] - YYYY-MM-DD`, which is exactly what `changelog-check.yml` and `release.yml`'s guard both grep for (`^## \[$VERSION\]`) and what every existing entry reads. The `v` lives on the branch name, the git tag and the pull request title only. This is where the repo departs from the play's default heading, and copying a sibling repo's `## [vX.Y.Z]` fails CI.
- **No pre-release form.** `guard-branches.yml` refuses a head like `release/v0.14.0-rc.1` into `main` outright, and `changelog-check.yml` fires on any head starting with `release/v` and then demands the exact three-number form — so such a branch fails that check rather than skipping it the way it would elsewhere. Ship a plain `X.Y.Z`.
- **The two surfaces go out in lockstep**, at the same `package.json` version from the same `main` commit, so "what is live?" has one answer. Publishing is deliberately not transactional: retry a transient failure at the same version and commit, and when a permanent defect makes a published commit unshippable, deprecate the published npm version and fix forward with one new version for both surfaces.
- **The tags are lightweight**, created by `git tag` in the workflow rather than `git tag -a`, so always pass `--tags` when reading them, as the play's own `git describe --tags --abbrev=0` does. A bare `git describe` does not fail here, which is the trap: an annotated tag left over from before the release workflow existed still sits in the history, so a tags-less read answers with that stale one and silently skips every version released since.
- **`make publish` and `make deploy` are break-glass only**, for the case where CI itself is unavailable. Both are guarded by `check-no-local-deps` and `check-release-ready`, and the latter demands a checkout sitting on `main` with a clean tree — which the main-checkout invariant does not give you. Prefer the merge, which ships from a verified `main` rather than from someone's working tree.
- **The live drift detectors are not a release gate.** `make smoke`, `make test-e2e`, `make test-e2e-run` and `make seed-e2e-fixture` sit outside `make all` and `make check` on purpose so the local gate and CI stay hermetic; they need `PIPELEX_API_KEY`, touch the network, default to `https://api-dev.pipelex.com` rather than production, and `make test-e2e-run` spends inference credit. They exist because every capability reaches `@pipelex/sdk` through a hand-written narrow interface the unit tests fake, so an API wire-shape change fails nothing hermetic. Running one before a release is a judgment call, not a step of it.
- **A dependency bump is its own gesture, not part of the release commit.** `@pipelex/sdk` and `@pipelex/mthds-ui` move through this repo's `bump-sdks` skill, which reads their changelogs and maps the breaking bullets onto the seams this repo declares.
- **A tool-schema change needs a line in the release notes telling console users to remove and re-add the connector.** ChatGPT caches a connector's tool list at add-time and never refreshes it, so a changed tool schema reaches existing installations no other way. The changelog entry is where that is said, and past entries carry it as an italic note.
