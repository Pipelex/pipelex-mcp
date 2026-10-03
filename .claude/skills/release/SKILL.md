---
name: release
description: >
  Cut a release of pipelex-mcp's MCP server, the workshop, published to npm as
  @pipelex/mcp (release/vX.Y.Z, tag vX.Y.Z). Makes the release worktree, bumps
  the workshop's package.json and the package-lock.json that follows, promotes
  its changelog entry (whose heading carries no prefix), runs the quality
  gates, makes one commit, and opens a pull request to main, whose merge is
  what publishes the workshop. Use when the user says "release", "cut a
  release", "bump version", "prepare a release", "make a release", "ship it",
  "release the workshop", "create release branch", "promote dev to main",
  "publish to npm", or any variation of shipping a new version of
  pipelex-mcp. Changelog content passed inline ("/release Added a codegen
  target") becomes the entry. The merge is landed by /ledger-land, never by
  this skill.
---

# Releasing pipelex-mcp

The procedure is the workspace release play, [`docs/workspace/releasing.md`](../../../../docs/workspace/releasing.md) at the workspace root — read it first, then run it with what follows. The repo key is `pipelex-mcp`, the base is `dev`, and the pull request targets `main`: `guard-branches.yml`'s `gate-main` job refuses any head branch into `main` but a release branch, so there is no other way in.

## What a release is here

**This repository ships one server, the workshop: `@pipelex/mcp` on npm, the stdio server the Pipelex plugin runs.** Its member is `packages/workshop`, its version lives in `packages/workshop/package.json` and its changelog in `packages/workshop/CHANGELOG.md`; the release branch is `release/vX.Y.Z`, the tag `vX.Y.Z`, and what the merge ships is an npm publish. The hosted console, the Pipelex connector for chat hosts, is a separate product released from its own repository, and nothing here releases it: work waiting on a console release names that repository, `pipelex-mcp-console@X.Y.Z`, and the `console-vX.Y.Z` tags in this history are the console's past releases from here, which no condition reads.

**A release files nothing in the ledger.** Work another repo must do once this version is on npm, such as a consumer's move of its `@pipelex/mcp` floor, is filed with `ledger new --after-release pipelex-mcp@X.Y.Z`, or put on an item already open with `ledger link <id> --after-release pipelex-mcp@X.Y.Z`, and becomes ready by itself once the `vX.Y.Z` tag is in this repository's checkout.

The release worktree is `_pipelex-mcp--release`, made with `wt add pipelex-mcp release --branch release/vX.Y.Z`. `wt` resolves the base from `origin/dev`, copies the main checkout's `.env` by the default rule, and provisions with the Makefile's `install` target (`npm install` at the root, which installs every workspace member) — which is what puts `node_modules` in the worktree for the gates below.

**Check the changelog after the back-merge.** `ledger land` protects the back-merge by rewriting the changelog at the repository root, and this repository keeps none there, so it accepts git's own merge of `packages/workshop/CHANGELOG.md` without reading it (workspace item L-260925-238fd3). A line `dev` added under `## [Unreleased]` far enough below the heading merges without a conflict and lands under the version just released. Every entry `dev` gained since the release branch was cut must still sit under `## [Unreleased]`, and the released `## [X.Y.Z]` section must read exactly as it does in `git -C <main> show origin/main:packages/workshop/CHANGELOG.md`. `ledger land` has already committed and pushed the merge by then, so fix a stray entry with a pull request into `dev`.

**What the release promotes.** Step 1 of the play reads `git -C <main> log origin/main..dev`; the changes that reach the published package are the part of that range touching the workshop or the core it inlines — `git -C <main> log origin/main..dev --oneline -- packages/core packages/workshop` — and the changelog's `## [Unreleased]` section is the record to promote.

## What ships

**The merge to `main` is the release.** `.github/workflows/release.yml` fires on the push to `main`, so nothing is dispatched, and the run to watch is the one keyed to the merge SHA. Its `detect` job reads the workshop's version at the merge commit and at its first parent, through `.github/scripts/track-version.sh`, and the workshop ships exactly when its version rose. A push that does not raise it ends green in seconds with every later job skipped. When it is a release, `guard` refuses to go on unless the changelog carries a `## [X.Y.Z]` heading for that version; it then re-runs `make all` on the merge commit rather than trusting the pull request's own run, and asks `npm view` whether the version is already published, failing the run outright when the registry cannot answer rather than guessing at it. That lookup decides the publish and nothing else, so a release whose version reached npm by another route still gets tagged.

The member's `files` list publishes `dist`, `README.md` and `LICENSE`; its `prepack` rebuilds `dist/main.js` with tsup and copies the repository's README and licence into the member, and its `postpack` removes the copies, so the tarball is built from the commit being shipped. It goes out as `npm publish --workspace @pipelex/mcp --access public --provenance` under npm trusted publishing, so no npm token exists anywhere; **the registration is bound to the filename `release.yml`**, and renaming or moving that workflow breaks publishing until the trusted publisher is re-registered. The `tag` job then creates `vX.Y.Z`.

The tag is created by `git tag`, so it is **lightweight**, and the tag job leaves an existing tag alone. The landing verifies the `release.yml` run on the merge SHA, which is the play's default reading, and the tag the release branch spells after `release/`, so the release is verified only once that run is green and the tag is there; the landing then closes nothing, since a release files nothing in the ledger.

```bash
gh run list --workflow=release.yml --limit 3 --json conclusion,event,headSha,url,createdAt   # the run whose headSha is the merge: success
npm view @pipelex/mcp version                                                                # the registry's answer, X.Y.Z
git fetch --tags --prune origin && git tag --list vX.Y.Z                                     # the tag the release branch spells
```

A partial failure is retried at the same version and never by bumping it: re-run the merge's own run, which is pinned to the merge commit and finishes the release however `main` has moved since, or dispatch it by hand, which reads `main`'s tip and refuses outright once something has landed there, since a tip that does not raise the version is not the release commit:

```bash
gh workflow run release.yml -f version=X.Y.Z   # the version carries no prefix
```

Both doors are safe to reach for by the workflow's own guards: the publish step skips a version already on npm, and the tag job leaves an existing tag alone. There is one thing a re-run will not do, and it is the reason the door is safe to leave open: a commit carrying a version `main` has already moved past is refused, so re-running an *older* release's run cannot point npm's `latest` dist-tag at the older package. That refusal (`.github/scripts/assert-not-behind-main.sh`) lives in the publish job rather than only in `detect`, which is what makes it hold for the retry you are most likely to reach for: GitHub's "Re-run failed jobs" re-runs only the jobs that failed and the jobs below them, so `detect`'s verdict arrives as an output written before the newer release existed, and a publish that trusted it would ship the downgrade green. A release `main` has moved past is finished by cutting a new version, never by reaching back for its run. Every job of a run checks out one SHA, resolved once by `detect`, so the tree that ships, the provenance npm records and the tag all name the same commit.

## Version files and the lock

- **`packages/workshop/package.json`**, its `"version"` field, with no prefix. It is the only file the number is written in: nothing under `packages/*/src/` carries a version literal (the server reads its own `package.json` for its handshake and its `User-Agent`), and the workflows read it back through `.github/scripts/track-version.sh`. The root `package.json` has no version, and the core's `0.0.0` never moves, since the core is never released.
- **The lock** — `npm install --package-lock-only` at the repository root, which rewrites `package-lock.json` from the manifests without touching `node_modules`. The workshop's number lives there once, as `packages["packages/workshop"].version`; `node -p "require('./package-lock.json').packages['packages/workshop'].version"` confirms it, and it must have moved before the commit. If the command fails, stop and report it rather than committing a stale lock.
- **Also stamped:** nothing. No badge, no literal, no exported artifact carries the version.

## Gates

Run in the worktree, in this order, before the commit:

1. **`make check`** — `check-no-local-deps` first, then `npm run check` (eslint, `prettier --check`, the instruction and tool-text budgets, the workshop's tsup build, and `tsc` over every package). `check-no-local-deps` fails when `@pipelex/mthds-ui` or `@pipelex/sdk` in any manifest of the workspace is a `file:`, `link:` or `portal:` link — what `make use-local` leaves behind — and the cure it names is `make use-npm`, because such a link does not resolve in a published tarball. Red blocks the release: fix the code, never loosen the target.
2. **`make agent-test`** — the same hermetic Vitest suite as `make test`, run so an agent can afford to watch it: quiet unless it fails, with a heartbeat line while it runs.

Neither rewrites a tracked file — `npm run check` only checks formatting, and what it builds lands in the gitignored `packages/*/dist/`. CI runs `make all` (`clean check test`) instead, both on the pull request and again inside the release workflow's `guard` job, and the `clean` it starts with removes `packages/*/dist`, `coverage/` and the `*.tsbuildinfo` files: when the two gates above are green and CI is not, `make all` is what reproduces CI here.

## The release commit

`packages/workshop/package.json`, `packages/workshop/CHANGELOG.md` and `package-lock.json`, staged by name. Nothing else, since no gate rewrites a tracked file.

## CI on the release pull request

- **`guard-branches.yml`** (`gate-main`) — the head branch into `main` must match `^release/v[0-9]+\.[0-9]+\.[0-9]+$` and must live in this repository rather than a fork.
- **`version-check.yml`** — the workshop's version equals the `X.Y.Z` in the release branch name **and**, when the base is `main`, is strictly greater than `main`'s, compared with `sort -V`. It fires on pull requests into `main` and into a release branch, which is how a `dev`-into-release promotion is held to the same number; `gate-dev` in `guard-branches.yml` is what lets `dev` be the head there, alongside the usual work-branch prefixes.
- **`changelog-check.yml`** — on a pull request into `main` whose head starts with `release/`: the changelog must carry a `## [X.Y.Z]` heading, with **no prefix**. It asserts nothing about `[Unreleased]`; leaving none behind is the play's rule, not CI's.
- **`quality-checks.yml`** — `npm ci` then `make all` on Node 24, on every pull request, with a concurrency group that cancels a superseded run for the same ref. Its comment states the intent that this status be the one the branch-protection ruleset requires before anything merges.

`release.yml` is not among them: it has no pull-request trigger and gates nothing here — it fires afterwards, on the push the merge makes.

## Particulars

- **The changelog heading carries no prefix** — `## [X.Y.Z] - YYYY-MM-DD`, which is exactly what `changelog-check.yml` and `release.yml`'s guard both grep for (`^## \[$VERSION\]`) and what every existing entry reads. The `v` lives on the branch name, the git tag and the pull request title only. This is where the repo departs from the play's default heading, and copying a sibling repo's `## [vX.Y.Z]` fails CI.
- **No pre-release form.** `guard-branches.yml` refuses a head like `release/v0.14.0-rc.1` into `main` outright, and `changelog-check.yml` fires on any head starting with `release/` and then demands the exact three-number form — so such a branch fails that check rather than skipping it the way it would elsewhere. Ship a plain `X.Y.Z`.
- **Publishing is deliberately not transactional**: retry a transient failure at the same version and commit, and when a permanent defect makes a published workshop unshippable, deprecate the npm version and fix forward with a new one.
- **The tags are lightweight**, created by `git tag` in the workflow rather than `git tag -a`, so always pass `--tags` when reading them, with the workshop's pattern: `git describe --tags --abbrev=0 --match 'v*'`. The history also holds the `console-vX.Y.Z` tags of the console's releases from this repository, and an annotated tag left over from before the release workflow existed, so a read without the pattern or without `--tags` can answer with one of those and silently skip every version released since. Up to and including `v0.20.0`, a `vX.Y.Z` tag marks a release of both servers; after it, of the workshop alone.
- **`make publish` is break-glass only**, for the case where CI itself is unavailable. It is guarded by `check-no-local-deps` and `check-release-ready`, and the latter demands a checkout sitting on `main` with a clean tree, at `origin/main`'s tip once it has fetched it — which the main-checkout invariant does not give you. It is also guarded by `check-workshop-released`, which refuses unless HEAD is the commit that raised the version, strictly: a tip that did not raise it carries the released number with code that version never shipped, so the recovery would put the wrong bytes under the right number, and the cure from there is a new release. Prefer the merge, which ships from a verified `main` rather than from someone's working tree.
- **The live drift detectors are not a release gate.** `make smoke`, `make test-e2e`, `make test-e2e-run` and `make seed-e2e-fixture` sit outside `make all` and `make check` on purpose so the local gate and CI stay hermetic; they need `PIPELEX_E2E_API_KEY`, touch the network, default to `https://api-dev.pipelex.com` rather than production, and `make test-e2e-run` spends inference credit. They exist because every capability reaches `@pipelex/sdk` through a hand-written narrow interface the unit tests fake, so an API wire-shape change fails nothing hermetic. Running one before a release is a judgment call, not a step of it.
- **A dependency bump is its own gesture, not part of the release commit.** `@pipelex/sdk` and `@pipelex/mthds-ui` move through this repo's `bump-sdks` skill, which reads their changelogs and maps the breaking bullets onto the seams this repo declares.
