# Developing pipelex-mcp

This page is for working on this repository: running the workshop from source, the build, the test suites, and how versions are cut and released. [`architecture.md`](architecture.md) explains how the code is built and why, [`testing.md`](testing.md) how it is tested, and [`SPEC.md`](../SPEC.md) is the source of truth for the tool contracts.

## Layout

The repository is one package at its root, `@pipelex/mcp`, published to npm from there:

| Path | What it is |
| --- | --- |
| `src/` | The workshop's shell: its entry point (`main.ts`), server and instructions (`server.ts`), tool table (`tools.ts`) and file resolver (`files.ts`), with the tool-definition shape and the helpers the server tests use. |
| `src/capabilities/` | The capability core the workshop is built from: the API calls, the projections, error classification, the run lifecycle and the workspace writers. |
| `scripts/`, `tests/` | The repository's own tooling and the tests that belong to no module: the text budgets, the publish guard, the live smoke run, and the Makefile, lint and manifest tests. |

tsup bundles `src/` into `dist/main.js`, the one file the tarball ships besides the README and the licence, so what every `npx @pipelex/mcp` install downloads is the manifest's `dependencies` alone. The layout is the one the package was published from through 0.20.0; from the workspace split of pipelex-mcp#89 until the flatten after 0.22.0 the core and the workshop were two packages under `packages/`, which older commits and items cite. Every `make` target runs from the root.

## Local development

The workshop is a stdio server: a host spawns it and talks to it over its standard input and output. During development you run it from source, and drive it by hand with MCP Inspector.

Prerequisites:

- Node.js 24.14.1 or later
- A Pipelex API. The workshop calls the hosted Pipelex API at `https://api.pipelex.com` unless `PIPELEX_BASE_URL` names another, with the `plx_sk_` key in `PIPELEX_API_KEY`; [the environment section of the hosts page](hosts.md#environment) lists every variable it reads. `mthds_inputs_template` and `mthds_prepare_inputs` read a method's signature from `POST /v1/pipe-io`, which needs pipelex-api 0.33.1 or later. `mthds_models` checks a reference through `GET /v1/models/check`, which needs pipelex-api 0.78.0 or later; an older runner answers a check with a `404`, which the tool reports as a `config` error naming the route.

Install the dependencies, then start the server:

```bash
make install
make dev-local       # run the stdio server from TypeScript (tsx)
make inspect-local   # open MCP Inspector against it
```

Neither target reads `.env`: the server takes `PIPELEX_BASE_URL` and `PIPELEX_API_KEY` from the environment it is started in, so export them in your shell or set them on the command line. To develop against a local runner, start the Pipelex API server with `make -C api run` in a checkout of [`Pipelex/pipelex`](https://github.com/Pipelex/pipelex), whose `api/` member it is; it serves `http://localhost:8081`, and you point the workshop at it with `PIPELEX_BASE_URL=http://localhost:8081`. A local runner checks no key, so `PIPELEX_API_KEY` can stay unset there, but it has neither the catalog nor the durable run lifecycle: a catalog id and the run family need the hosted API.

## Build

```bash
npm run build  # the workshop: tsup → dist/main.js (the npm-distributed bin)
npm run check  # lint + format:check + check:instructions + check:tool-texts + build + check:bundle + typecheck
```

`make build-local` runs the same build. tsup bundles `src/main.ts` into one ESM file with a Node shebang, inlining the core and leaving external exactly what `package.json`'s `dependencies` name. Node built-ins keep their `node:` prefix (`removeNodeProtocol: false`), because `node:sqlite`, which the write lock uses, answers to no other name. The manifest's `prepack` rebuilds the bin, so a pack or publish can never ship a stale or absent one. `make clean` removes `dist/`, and also the `packages/*/dist` a checkout built before the flatten still holds, untracked, which a tool still pointed at `packages/workshop/dist/main.js` would otherwise run without a word.

### What `make check` runs, and in what order

`make check` is `npm run check` behind the `check-no-local-deps` guard, which refuses to run while `@pipelex/sdk` or `@pipelex/mthds-ui` is a local `file:`, `link:` or `portal:` link. It does not run the publish guard, which a sprint pin would fail on purpose (see [Publishing by hand](#publishing-by-hand)). Its steps run in this order:

- `lint` runs ESLint over `src/`, `scripts/`, `tests/`, the repository's own lint rules and the tsup and Vitest configurations, and `format:check` runs Prettier in check mode, so neither rewrites a file.
- `check:instructions` holds this repository's agent instruction files to their ceilings: `CLAUDE.md`, which Claude Code loads into every session opened here, and each path-scoped rule under `.claude/rules/`. `CLAUDE.md` is a map, so when the gate fails, move the detail to the page that owns it (this directory, `SPEC.md`, a rule or a code comment) rather than raising the ceiling. `scripts/instruction-budget.ts` holds the ceilings and says why they sit where they do.
- `check:tool-texts` is the length gate on what a host shows the model. It builds the workshop's server in process, reads the `instructions` from `initialize` and every tool `description` from `tools/list` — the emitted strings, not the source constants, since some descriptions are assembled from parts — and fails when any is over 1,800 Unicode code points. Claude Code cuts each of those texts at 2,048, and the workshop's instructions once reached the model cut mid-word because nothing measured them; the ceiling leaves headroom for one more sentence and for hosts whose cap nobody has measured. Its report also lists schema sizes and the `tools/list` payload, for information only. When it fails, move the detail to the layer that owns it rather than raising the ceiling. It reads no build output, so it runs before the build.
- `build` bundles the workshop's bin, as described above.
- `check:bundle` refuses a `dist/main.js` that an installed copy could not load: every import it makes must be a Node built-in under the very name it uses, or a package `dependencies` declares. The tests run the workshop from source, so nothing else loads the shipped file, and a build that stripped `node:` from `node:sqlite` once passed every other gate while the bin failed at load. `scripts/bundle-imports.ts` holds the rule.
- `typecheck` runs `tsc` over `src/`, `scripts/` and `tests/`, one program under the one `tsconfig.json`.

## Tests

```bash
make test         # the default suite — hermetic, no network
make agent-test   # the same suite for an agent — quiet unless it fails
make test-e2e     # the live suite — real client, real Pipelex API
make smoke        # the workshop stdio server, end to end, against the live API
make test-all     # all of the above plus the run family — SPENDS INFERENCE CREDIT
```

`make test` fakes every API client, so it proves the projections and never touches the network; `make all` and CI run only that. The live targets are the drift detector: the faked seams mean a wire-shape change on the API side fails nothing at all in the hermetic suite, so `make test-e2e` calls each capability with the real `PipelexApiClient` and `make smoke` drives the whole server over stdio. Both read their own pair, `PIPELEX_E2E_API_KEY` and optionally `PIPELEX_E2E_BASE_URL` (it defaults to `https://api-dev.pipelex.com`), from the make command line, then a gitignored `.env` at the repo root, then the shell, and never read `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`, so a key exported in your shell for other tools cannot aim them at another deployment; and neither spends inference credit — the run family that does only fires under `make test-e2e-run`. Their codegen legs need one thing more against the hosted API: `/v1/codegen` sits behind the `FF_PLAYGROUND` feature flag as well as the plan, so a perfectly valid key whose organization is not enabled for it gets a 403 that reddens the whole run — ask for the flag, or point `PIPELEX_E2E_BASE_URL` at a local runner, which does not gate the route. `make smoke` is entirely read-only. `make test-e2e` writes: `mthds_prepare_inputs` uploads a 1x1 PNG to your organization's Pipelex storage to prove the upload path still rewrites values to `pipelex-storage://`, its by-address leg uploads another, and the catalog-write suite updates a seeded fixture method. The SDK exposes no storage delete, so the uploaded objects persist.

`make test-all` chains all three in cost order and adds the run family, so a single command covers every test in the repo; it spends inference credit, which is why `make all` does not reach it. `make agent-test` is the same hermetic suite as `make test` with its output captured and replayed only on failure, plus a heartbeat while it runs — meant for coding agents, whose context a few hundred lines of green vitest output would otherwise fill.

The by-id paths and the catalog-write suite need durable fixture methods in the API key's organization; `make seed-e2e-fixture` creates or refreshes them and publishes them, idempotently, and no `make test-e2e` run ever creates one. See [`testing.md`](testing.md) for the suites, the seams they fake, the fixtures and why each live leg exists.

## Versioning

The workshop, `@pipelex/mcp`, follows [Semantic Versioning](https://semver.org). Its version lives in `package.json` and its changelog in [`CHANGELOG.md`](../CHANGELOG.md); a release is cut on a `release/vX.Y.Z` branch, tagged `vX.Y.Z`, and shipped as an npm publish. A change belongs in the changelog whenever it changes what a user of the published package sees.

Work in progress accumulates under the changelog's `## [Unreleased]` — don't mint a new `## [x.y.z]` heading per commit. Mint it (and the tag) only when you actually release at that version; the newest versioned heading must then match the workshop's `package.json` `version`. To cut a release, use the **`/release` skill** (`.claude/skills/release/`): it promotes the changelog's `## [Unreleased]` to `## [x.y.z]`, bumps the workshop's `package.json`, regenerates `package-lock.json`, and opens the release PR into `main` that the CI gates expect. Note the version-string split: the `v` prefix is on the branch name, git tag, and PR title only — never in `package.json` or the `## [x.y.z]` changelog heading.

The tag history predates the current layout. This repository also used to hold the hosted console, the Pipelex connector, which is now a separate product released elsewhere. Up to and including `v0.20.0` the two servers shipped together at one version, so a `vX.Y.Z` tag up to `v0.20.0` marks a release of both, and the workshop's changelog carries their joint history; after it, a `vX.Y.Z` tag marks a release of the workshop alone, and the `console-vX.Y.Z` tags in the history mark the console's own releases from here. The tags are lightweight, so read the workshop's with `--tags` and its pattern: `git describe --tags --abbrev=0 --match 'v*'`.

`0.1.0` is the first tagged release. It **retires the `v0.x` prototype-increment track** (`docs/mcp/archive/2026-06-design/02-delivery/v0.x-prototype-plan.md` in the private Pipelex workspace): the milestones once called v0.1 / v0.2 / v0.3 were build increments, not package versions, and all shipped together as `0.1.0`. Use the changelog + semver from here on, not the v0.x numbering. The workspace's `docs/mcp/cold-start.md` remains the cold-start brief for resuming work; the workshop's changelog is the source of truth for what has shipped.

Merging a release pull request into `main` is what ships a version: the release workflow reads the version at the merge commit, publishes it to npm when that version rose, and tags the commit `vX.Y.Z`. [CI and releases](#ci-and-releases) below describes the release workflow and its guards.

## CI and releases

GitHub Actions under `.github/workflows/` (ported from the sibling TS repos, minus the CLA piece that doesn't apply here):

- `quality-checks.yml` — on every PR, runs `npm ci` then `make all` (the same gate as local) on Node 24, and a new push to a PR cancels the check still running for it. Meant to be a required status check on `main`.
- `guard-branches.yml` — enforces the `work-branch → dev → release branch → main` flow: **only a `release/vX.Y.Z` branch from this repository may target `main`** (`dev` no longer can — it's promoted *into* the release branch instead), and a branch targeting `dev` or a release branch must be a work branch prefixed `fix/`, `feature/`, `refactor/`, `chore/`, `docs/`, `ci-cd/`, `changelog/` or `codex/`, or `dev` itself into a release branch.
- `version-check.yml` — on PRs into `main` or a release branch: asserts that the workshop's version (`package.json`, read through `.github/scripts/track-version.sh`) equals the `X.Y.Z` in the release branch name and, for `main`, is strictly greater than `main`'s.
- `changelog-check.yml` — on a release PR into `main`: asserts that `CHANGELOG.md` has a `## [X.Y.Z]` entry for the version the branch names (no prefix in the heading — `v` lives on the branch name and the git tag only).
- `release.yml` — **on the push to `main`**, which in this repo means the merge of a release PR, it publishes the workshop to npm as `@pipelex/mcp` and tags the commit `vX.Y.Z`, all from the merge commit itself, so the run to verify is the one keyed to the merge SHA. What makes an unconditional trigger safe is that whether a push is a release is read from the pushed commit and from nothing else: the `detect` job compares the workshop's version at the commit with its version at the first parent, through `.github/scripts/track-version.sh <commit-ish>` (which reads `packages/workshop/package.json` at a commit from the workspace layout, between pipelex-mcp#89 and the flatten, and the root `package.json` at any other), and the push is a release exactly when it *raises* that version — a strict increase, so a revert that lowers it cannot read as a release. A push that does not raise it ends green in seconds with every later job skipped, and the property survives a release run that died before publishing, which a registry-state test does not. A commit carrying a version `main` has already moved past is refused outright, which is what stops a re-run of an older release's run from shipping that older tree: `npm publish` carries no `--tag`, so it would write the `latest` dist-tag back to the older release, and the run would end green having shipped a downgrade. That refusal (`.github/scripts/assert-not-behind-main.sh <version>`) runs inside the `publish` job and not only in `detect`, because GitHub's "Re-run failed jobs" never re-executes a job that succeeded: `detect`'s verdict reaches a partial re-run as an output it wrote before the newer release existed, so the publish job asks `main` for itself. The `tag` job needs no such guard, since it leaves an existing tag alone. `guard` then decides whether the commit is *shippable*: the changelog must carry a `## [X.Y.Z]` heading, `make all` is re-run on the merge commit rather than trusted from the PR, and `npm view` is asked whether the version is already there, an answer the registry could not give failing the run instead of reading as unpublished. That lookup is the double-publish guard and nothing more: it decides whether `publish` runs `npm publish`, and the tag does not read it, so a release whose version reached npm by another route still gets tagged instead of ending green having shipped nothing. `npm publish` itself runs the publish guard first, the manifest's `prepublishOnly` script, so a sprint pin or a git or local source among the dependencies stops the publish with the package named (see [Publishing by hand](#publishing-by-hand)). The workflow keeps `workflow_dispatch` for one purpose: retrying a release after a partial failure, at the same version (`gh workflow run release.yml -f version=X.Y.Z`). A dispatch is held to one check more, that the typed `version` equals what the commit carries; it reads `main` whatever ref it was fired from, so it cannot ship a branch, and it refuses to run once `main`'s tip does not raise the version, since that tip is no longer the release commit. Every job checks out one SHA that `detect` resolved once. npm auth is OIDC trusted publishing (registered against this repo + the `release.yml` filename), so no npm token exists anywhere — **renaming this workflow breaks publishing** until the trusted publisher is re-registered.

A release branch, its version bump, the changelog finalization, and the PR are produced by the **`/release` skill** (`.claude/skills/release/`) — run it to cut a release rather than hand-assembling these. Merging that PR is what ships it, through the `release.yml` run above (`make publish` remains a local escape hatch for a CI outage). Retry transient finishing-step failures at the same version; if a permanent defect makes a published workshop unshippable, deprecate that version on npm and fix forward with a new one.

### Publishing by hand

`make publish` publishes the workshop to npm from a local checkout. It is an escape hatch for a CI outage; a release ships through `release.yml`. It is release-guarded three ways: `check-no-local-deps` refuses a `@pipelex` dependency that is a local link, which would ship a broken install; `check-release-ready` demands a checkout on `main` with a clean working tree, at `origin/main`'s tip once it has fetched it; and `check-workshop-released` demands that HEAD be the commit that raised the workshop's version over its first parent, strictly, since a tip that did not raise it carries the released number with code that version never shipped. Once `main` has moved past the release, the cure is a new release rather than a publish.

Every publish, this one, `release.yml`'s and a bare `npm publish` alike, then passes through **the publish guard**, the manifest's `prepublishOnly` script (`make check-publishable` runs it alone). `make publish` also runs it as a prerequisite and passes `--ignore-scripts=false`, because an npm configured with `ignore-scripts` would otherwise skip both the guard and the `prepack` build. It refuses, naming each package, a dependency in any block that is not a registry version, range or tag, read the way npm reads it: a sprint prerelease (`X.Y.Z-sprint.g<sha>`, the form `wt pin` writes for `@pipelex/sdk`), a git source, a URL or a local source. `package.json` is both where a sprint pin is written (`.worktree.toml` names it) and what npm publishes, so a pin the release train failed to collapse would otherwise reach every install, needing git and credentials or shipping unreleased code. The guard stays out of `make check` on purpose, since that has to stay green with a pin in place on a sprint branch. `scripts/publish-guard.ts` says exactly what it refuses.

### Developing against a local SDK or UI

The SDK dependency is the published `@pipelex/sdk` npm package, not a `file:../pipelex-sdk/js` link, so CI just runs `npm ci`. To develop against local changes in `../pipelex-sdk/js` or `../mthds-ui`, `make use-local-sdk` / `make use-local-ui` (or `make use-local` for both) point the dependency at the sibling checkout through a `file:` link in `package.json`, and `make use-npm-sdk` / `make use-npm-ui` (or `make use-npm`) switch back. `make check` refuses to run while any such link is in place, so none is ever committed. Bump the `^x.y.z` range once the change is published.
