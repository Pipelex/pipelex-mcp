# Developing pipelex-mcp

This page is for working on this repository: running the hosted console on your machine, building both servers, the test suites, and how versions are cut. [`architecture.md`](architecture.md) explains how the code is built and why, [`testing.md`](testing.md) how it is tested, and [`SPEC.md`](../SPEC.md) is the source of truth for the tool contracts.

## Layout

The repository is an npm workspace of three packages, installed together by one `npm install` at the root:

| Package | Name | What it is |
| --- | --- | --- |
| `packages/core` | `@pipelex/mcp-core`, private | The capability core both servers are built from: the API calls, the projections, error classification, the tool-definition shape and the shell-test helpers. Never published. |
| `packages/workshop` | `@pipelex/mcp` | The local stdio server, published to npm and run by the Pipelex plugin. |
| `packages/console` | `@pipelex/mcp-console`, private | The hosted console, a Skybridge app deployed to Alpic. |

The core exports its TypeScript source, not a build, and each server's build inlines it, so neither server imports a workspace package at run time. Each package's `package.json` declares only what its own entrypoint reaches, which is what keeps the console's React, Vite and Skybridge out of every `npx @pipelex/mcp` install. The root holds what spans the packages: the Makefile, the lint, format and test configuration, `scripts/` and the cross-package tests in `tests/`. Every `make` target runs from the root.

## Hosted console: local development

The hosted server is a Skybridge app. During early development this repo also supports the local `pipelex-api` runner so the MCP can be exercised before the hosted path is fully wired — temporary; the production target is the hosted Pipelex API only.

Prerequisites:

- Node.js 24.14.1 or later
- A Pipelex API serving `POST /v1/validate`, which the console's `pipelex_show_method` and `pipelex_run` read a method's signature from (a local `pipelex-api` during development)
- A WorkOS AuthKit tenant — **the console has no keyless mode and refuses to start without one** (see below)

**The console requires two WorkOS variables.** Per-user OAuth is its only auth posture, so the server throws at startup unless both are set:

| Variable | Value |
| --- | --- |
| `WORKOS_AUTHKIT_DOMAIN` | the AuthKit domain, e.g. `<tenant>.authkit.app` |
| `PIPELEX_MCP_RESOURCE_INDICATOR` | the server **origin with a trailing slash** — `http://localhost:6843/`, not `.../mcp` |

The Resource Indicator must also be registered in the WorkOS dashboard (Connect → Configuration), along with Dynamic Client Registration. It becomes the issued token's `aud`, and the server verifies it byte-for-byte — registering the `/mcp` path or dropping the trailing slash yields tokens that never validate. The startup check rejects both mistakes with a message naming the fix, rather than letting every tool call fail later at audience verification. Behind a tunnel (`make dev-tunnel`), the indicator is the tunnel's origin with a trailing slash rather than `http://localhost:6843/`, and that is the value to set in `.env` and register in the dashboard.

If you only need to work on the capability core, **use `make dev-local` instead** — the workshop shell shares the same capabilities, authenticates with a plain `PIPELEX_API_KEY`, and needs no WorkOS setup at all.

Install dependencies, start the API, then the Skybridge dev server:

```bash
make install

# in a checkout of pipelex-api, in another terminal:
make run                               # serves http://localhost:8081

# back in this repository:
make dev                               # sources .env ahead of the shell, then `npm run dev`
```

```env
# .env at the repo root (gitignored)
WORKOS_AUTHKIT_DOMAIN=<tenant>.authkit.app
PIPELEX_MCP_RESOURCE_INDICATOR=http://localhost:6843/
PIPELEX_BASE_URL=http://localhost:8081
```

`PIPELEX_BASE_URL` defaults to the hosted Pipelex API when unset — set it to `http://localhost:8081` to develop against a local runner. `PIPELEX_API_KEY` has **no effect on the console**: the caller's verified OAuth token always overrides it. `.env` is dev-only and loaded via `packages/console/nodemon.json` (`tsx --env-file-if-exists=../../.env`, run from the console's directory); it is not watched, so restart the dev server after editing it. `make dev` also sources it with `sh` before Node reads it, so keep it to plain `KEY=value` lines (no `$`, `#`, spaces or backticks inside a value; none of the console's keys need any), and `set -a` there exports the whole file to every process under `npm run dev`, the `alpic tunnel` CLI included.

Start it with `make dev`, not `npm run dev` — for the `.env` precedence here and for the pinned port below. Node's `--env-file` never overrides an inherited variable, so a profile-level `export PIPELEX_BASE_URL=…` would silently win over `.env` under a bare `npm run dev`. `make dev` (and `make dev-tunnel`) sources `.env` first so the file wins, prints the API target it resolved, and still lets `make dev PIPELEX_BASE_URL=http://localhost:8080` override it for one run.

The console runs on a **pinned port, `6843`**, not Skybridge's default 3000. Skybridge would otherwise walk up to the next free port when 3000 is busy (it is, whenever a Next.js app is running), and the Resource Indicator names the port — so a console that drifted to 3001 booted fine and then failed every tool call at audience verification. `make dev` and `make dev-tunnel` pass `--port` to turn that fallback off, and refuse to start, naming the fix, when the port is not a number, when it is held by another process (whatever address the holder bound), when a localhost Resource Indicator names a different port (no port means 80; `[::1]` counts as localhost), or when the port is right but the indicator is not the bare origin with a trailing slash. Register `http://localhost:6843/` as the Resource Indicator in the WorkOS dashboard and put the DevTools origin `http://localhost:6843` on its CORS list. The port follows the same precedence as every other console variable: `make dev CONSOLE_PORT=<n>` overrides it for one run, and a `CONSOLE_PORT=<n>` line in `.env` sets it for the checkout, for a port you registered elsewhere.

**A DevTools session lives as long as its WorkOS access token, and only a page reload renews it.** DevTools obtains a token when it connects and never refreshes it mid-session: once the token expires, every tool call gets the console's 401 (`"exp" claim timestamp check failed`), the MCP client throws instead of refreshing, and DevTools shows nothing — the call looks like it ran and delivered nothing. Reload the tab (F5) and it reconnects with a fresh token. Do not restart `make dev` for this: it fixes nothing, and a tab connected to the console you just killed stays on "Connecting to server…" until it is reloaded. The lifetime is the WorkOS application's "Access token duration" (dashboard → the application's Sessions tab). The default is five minutes, which makes DevTools unusable for anything longer than a short burst, so the dev tenant's is set to one hour. Skybridge prints nothing for a tool call in dev, so an empty Logs pane is not evidence either way.

`packages/console/nodemon.json` overrides Skybridge's default dev exec with `tsx --env-file-if-exists=../../.env src/server.ts`, run from the console's directory, and watches the core's source beside the console's. Keep its `watch` and `ext` in step with Skybridge's defaults: a `nodemon.json` replaces them entirely rather than adding to them. A bare `npm run dev` keeps the plain `--env-file` behavior, and `make dev-local` / `make inspect-local` never read `.env` at all. When `make dev` puts a command-line override back after sourcing `.env`, it does so by name, so any value survives, spaces and quotes included.

The port guard (`CONSOLE_PORT_GUARD` in the Makefile) looks for a holder with `lsof` first, so a listener bound to loopback only is seen, and falls back to a wildcard-bind Node probe on a machine without `lsof`; without it a pinned port would die on `EADDRINUSE` underneath Skybridge's UI. An indicator whose port is right but whose shape is not the bare origin with a trailing slash gets a message of its own, because the server's more exact refusal would be buried under that UI, and a non-localhost indicator, such as a tunnel URL, is left alone. The vendored `skybridge` skill is hash-locked in `skills-lock.json`, so it cannot be edited here, and its references still quote Skybridge's default port (`alpic tunnel --port 3000` and the like): in this repository the port is `CONSOLE_PORT`, which `make dev-tunnel` already passes, so ignore the skill's port numbers.

`PIPELEX_API_KEY` matters only to the workshop: set it for `make dev-local` when the API it targets requires a key, which a local runner does not.

When a tool call has to be traced, the running console can be instrumented without a restart, which matters because Skybridge logs nothing for a tool call in dev: `kill -USR1 <pid>` opens the Node inspector, and a `diagnostics_channel` subscriber on `http.server.request.start` and `undici:request:*`, evaluated through it, shows every request coming in and every upstream call going out.

The MCP endpoint is at `http://localhost:6843/mcp`, with Skybridge DevTools at `http://localhost:6843`.

To poke the **local workshop** stdio server during development:

```bash
make dev-local       # run the stdio server from TypeScript (tsx)
make inspect-local   # open MCP Inspector against it
```

## Build

```bash
npm run build        # the console: Skybridge app (regenerates .skybridge/views.d.ts first), then dist/server.bundle.js, under packages/console
npm run build:local  # the workshop: tsup → packages/workshop/dist/main.js (the npm-distributed bin)
npm run check        # lint + format:check + check:instructions + check:tool-texts + build + check:bundle + check:cascade + build:local + typecheck
```

### What `make check` runs, and in what order

`make check` is `npm run check` behind the `check-no-local-deps` guard, which refuses to run while `@pipelex/sdk` or `@pipelex/mthds-ui` in any manifest is a local `file:`, `link:` or `portal:` link. The order of the steps is deliberate:

- `check:instructions` holds this repository's agent instruction files to their ceilings: `CLAUDE.md`, which Claude Code loads into every session opened here, and each path-scoped rule under `.claude/rules/`. `CLAUDE.md` is a map, so when the gate fails, move the detail to the page that owns it (this directory, `SPEC.md`, a rule or a code comment) rather than raising the ceiling. `scripts/instruction-budget.ts` holds the ceilings and says why they sit where they do.
- `check:tool-texts` is the length gate on what a host shows the model. It builds both shells in process, reads the `instructions` from `initialize` and every tool `description` from `tools/list` — the emitted strings, not the source constants, since some descriptions are assembled from parts — and fails when any is over 1,800 Unicode code points. Claude Code cuts each of those texts at 2,048, and the workshop's instructions once reached the model cut mid-word because nothing measured them; the ceiling leaves headroom for one more sentence and for hosts whose cap nobody has measured. Its report also lists schema sizes and the `tools/list` payload, for information only. When it fails, move the detail to the layer that owns it rather than raising the ceiling. It needs no build, so it runs before `build`.
- `build` runs before the standalone `typecheck`, because Skybridge regenerates the view-name registry as its first step and `tsc` needs it (see below). A cold `typecheck` with no prior `build` or `dev` does not know the view name.
- `check:bundle` and `check:cascade` run right after `build`, because each reads what it emitted: the server bundle, described below, and the stylesheet, whose cascade `check:cascade` resolves declaration by declaration (see [the console's stylesheet](architecture.md#the-consoles-stylesheet-and-the-form-kernel) for what it protects and why nothing else can).
- `build:local` bundles the workshop's bin between the console's build and the typecheck.

**The console starts from one self-contained file, `packages/console/dist/server.bundle.js`.** `skybridge build` ends by writing a Vercel build output whose function is an esbuild bundle of the whole server, the core and every package inlined but the dev-only `vite` and `@skybridge/devtools`, whose code paths it strips; the console's `npm run build` copies that bundle into its `dist/` (`packages/console/scripts/emit-server-bundle.mjs`), and both the root `alpic.json` and the `Dockerfile` start it. The bundle is what lets the console run where the workspace does not: Alpic's runtime image holds the root `node_modules` and the build output, and the core's entry in that `node_modules` is a link to a directory the image does not carry. Skybridge, React, React DOM, Vite and nodemon are the console's to declare, and none of them reaches an `npx @pipelex/mcp` install, since the workshop's manifest does not name them. The bundle's path is Skybridge's Vercel output rather than a promised interface, so `check:bundle` (`packages/console/scripts/check-server-bundle.mjs`) copies the bundle alone into an empty directory, boots it there against a local stand-in for the AuthKit discovery document and its keys, and asserts that it answers its OAuth metadata, refuses an anonymous call, and serves the tools and views the console's contract snapshot pins. It never touches the network.

`pipelex_show_method` registers the `run-graph` view (`packages/console/src/views/run-graph.tsx`) and `pipelex_run` the `run-follow` view, which share the results panel in `packages/console/src/views/components/`, and which satisfies Skybridge's "≥1 view entry" production-build requirement. The Skybridge build scans the console's `src/views/` and regenerates its `.skybridge/views.d.ts` (the view-name registry) as its first step, so `npm run check` runs `build` before the standalone `typecheck` — the registry must exist for `tsc` to resolve the registered view name. The workshop's build follows, and its `prepack` rebuilds the bin and copies the root `README.md` and `LICENSE` into the package, so a pack or publish can never ship a stale or absent bin; `postpack` removes the copies.

## Tests

```bash
make test         # the default suite — hermetic, no network
make agent-test   # the same suite for an agent — quiet unless it fails
make test-e2e     # the live suite — real client, real Pipelex API
make smoke        # the workshop stdio server, end to end, against the live API
make test-all     # all of the above plus the run family — SPENDS INFERENCE CREDIT
```

`make test` fakes every API client, so it proves the projections and never touches the network; `make all` and CI run only that. The live targets are the drift detector: the faked seams mean a wire-shape change on the API side fails nothing at all in the hermetic suite, so `make test-e2e` calls each capability with the real `PipelexApiClient` and `make smoke` drives the whole shell over stdio. Both read their own pair, `PIPELEX_E2E_API_KEY` and optionally `PIPELEX_E2E_BASE_URL` (it defaults to `https://api-dev.pipelex.com`), from the make command line, then a gitignored `.env` at the repo root, then the shell, and never read `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`, so a key exported in your shell for other tools cannot aim them at another deployment; and neither spends inference credit — the run family that does only fires under `make test-e2e-run`. Their codegen legs need one thing more against the hosted API: `/v1/codegen` sits behind the `FF_PLAYGROUND` feature flag as well as the plan, so a perfectly valid key whose organization is not enabled for it gets a 403 that reddens the whole run — ask for the flag, or point `PIPELEX_E2E_BASE_URL` at a local runner, which does not gate the route. `make smoke` is entirely read-only. `make test-e2e` writes: `mthds_prepare_inputs` uploads a 1x1 PNG to your organization's Pipelex storage to prove the upload path still rewrites values to `pipelex-storage://`, its by-address leg uploads another, and the catalog-write suite updates a seeded fixture method. The SDK exposes no storage delete, so the uploaded objects persist.

`make test-all` chains all three in cost order and adds the run family, so a single command covers every test in the repo; it spends inference credit, which is why `make all` does not reach it. `make agent-test` is the same hermetic suite as `make test` with its output captured and replayed only on failure, plus a heartbeat while it runs — meant for coding agents, whose context a few hundred lines of green vitest output would otherwise fill.

The by-id paths and the catalog-write suite need durable fixture methods in the API key's organization; `make seed-e2e-fixture` creates or refreshes them, idempotently, and no `make test-e2e` run ever creates one. See [`testing.md`](testing.md) for the suites, the seams they fake, the fixtures and why each live leg exists.

## Versioning

The two servers are released separately, each on its own track following [Semantic Versioning](https://semver.org):

| Server | Version | Changelog | Release branch | Tag | What the merge ships |
| --- | --- | --- | --- | --- | --- |
| The workshop, `@pipelex/mcp` | `packages/workshop/package.json` | [`packages/workshop/CHANGELOG.md`](../packages/workshop/CHANGELOG.md) | `release/vX.Y.Z` | `vX.Y.Z` | an npm publish |
| The console | `packages/console/package.json` | [`packages/console/CHANGELOG.md`](../packages/console/CHANGELOG.md) | `release/console-vX.Y.Z` | `console-vX.Y.Z` | an Alpic deploy |

The workshop keeps the plain `v` because it is the published package, and its existing tags, its npm versions and the workspace's release landing all read that form already; the console takes the prefix so that its tags can never be read as the workshop's. Up to and including 0.20.0 both servers shipped together at one version, so a `vX.Y.Z` tag up to `v0.20.0` marks a release of both, and the workshop's changelog carries their joint history; the console's version continues from 0.20.0. The root `package.json` carries no version, and the core's `0.0.0` never moves, since the core is never released. A change to the core belongs in the changelog of each server it changes.

Work in progress accumulates under each changelog's `## [Unreleased]` — don't mint a new `## [x.y.z]` heading per commit. Mint it (and the tag) only when you actually release that server at that version; the newest versioned heading must then match its `package.json`'s `version`. To cut a release, use the **`/release` skill** (`.claude/skills/release/`): it asks which server ships, promotes that changelog's `## [Unreleased]` to `## [x.y.z]`, bumps that server's `package.json`, regenerates `package-lock.json`, and opens the release PR into `main` that the CI gates expect. Note the version-string split: the `v` and `console-v` prefixes are on the branch name, git tag, and PR title only — never in `package.json` or the `## [x.y.z]` changelog heading.

`0.1.0` is the first tagged release. It **retires the `v0.x` prototype-increment track** (`docs/mcp/archive/2026-06-design/02-delivery/v0.x-prototype-plan.md` in the private Pipelex workspace): the milestones once called v0.1 / v0.2 / v0.3 were build increments, not package versions, and all shipped together as `0.1.0`. Use the changelog + semver from here on, not the v0.x numbering. The workspace's `docs/mcp/cold-start.md` remains the cold-start brief for resuming work; the two changelogs are the source of truth for what has shipped.

Merging a release pull request into `main` is what ships a version, of the one server its branch names: the release workflow reads each server's version at the merge commit, publishes the workshop to npm or deploys the console to Alpic when that server's version rose, and tags the commit with that server's tag. A release of one server never ships the other. The `/release` skill cuts a release and asks which server ships, and [CI and releases](#ci-and-releases) below describes the release workflow and its guards.

## CI and releases

GitHub Actions under `.github/workflows/` (ported from the sibling TS repos, minus the CLA piece that doesn't apply here):

- `quality-checks.yml` — on every PR, runs `npm ci` then `make all` (the same gate as local). Meant to be a required status check on `main`.
- `guard-branches.yml` — enforces the `work-branch → dev → release branch → main` flow: **only a release branch may target `main`**, `release/vX.Y.Z` for the workshop or `release/console-vX.Y.Z` for the console (`dev` no longer can — it's promoted *into* the release branch instead), and work branches must be prefixed (`fix/`, `feature/`, `refactor/`, `chore/`, `docs/`, `ci-cd/`, `changelog/`, `codex/`).
- `version-check.yml` — on PRs into `main` or a release branch: asserts the released server's version (its member's `package.json`, read through `.github/scripts/track-version.sh`) equals the `X.Y.Z` in the release branch name and, for `main`, is strictly greater than `main`'s version of that server, while the other server's version is unchanged: a release carries one server.
- `changelog-check.yml` — on a release PR into `main`: asserts the released server's changelog (`packages/workshop/CHANGELOG.md` or `packages/console/CHANGELOG.md`) has a `## [X.Y.Z]` entry (no prefix in the heading — `v` and `console-v` live on the branch name and the git tag only).
- `release.yml` — **on the push to `main`**, which in this repo means the merge of a release PR, it ships each server whose version the pushed commit raised: the workshop is published to npm as `@pipelex/mcp` and tagged `vX.Y.Z`, the console is deployed to Alpic and tagged `console-vX.Y.Z`, all from the merge commit itself, so the run to verify is the one keyed to the merge SHA. A release of one server never publishes or deploys the other. What makes an unconditional trigger safe is that whether a push is a release is read from the pushed commit and from nothing else: the `detect` job compares each server's version at the commit with its version at the first parent, through `.github/scripts/track-version.sh` (which reads the root `package.json` at a commit from before the workspace split, when one version covered both servers), and a server ships exactly when the push *raises* its version — a strict increase, so a revert that lowers it cannot read as a release. A commit carrying a version `main` has already moved past, for the server being shipped, is refused outright, which is what stops a re-run of an older release's run from shipping that older tree: the tag legs would leave the existing tag alone, but the console deploy ships whatever tree it is handed and `npm publish` carries no `--tag`, so it would write the `latest` dist-tag back to the older release, and the run would end green having shipped a downgrade. That refusal (`.github/scripts/assert-not-behind-main.sh <track> <version>`) runs inside each shipping leg and not only in `detect`, because GitHub's "Re-run failed jobs" never re-executes a job that succeeded: `detect`'s verdict reaches a partial re-run as an output it wrote before the newer release existed, so each leg asks `main` for itself. A push that raises neither version ends green in seconds with every later job skipped, and the property survives a release run that died before publishing, which a registry-state test does not. `guard` then decides whether the commit is *shippable* — the released server's changelog must carry a `## [X.Y.Z]` heading, `make all` is re-run on the merge commit rather than trusted from the PR, and, for a workshop release, `npm view` is asked whether the version is already there, an answer the registry could not give failing the run instead of reading as unpublished. That lookup is the double-publish guard on the npm leg alone: the workshop's tag does not read it, so a release whose version reached npm by another route still gets tagged instead of ending green having shipped nothing, and a console release never asks the registry at all. The workflow keeps `workflow_dispatch` for one purpose: retrying one server's release after a partial failure, at the same version (`-f track=workshop` or `-f track=console`, with `-f version=X.Y.Z`). A dispatch is held to one check more, that the typed `version` equals what the commit carries for that server; it reads `main` whatever ref it was fired from, so it cannot ship a branch, and it refuses to run once `main`'s tip does not raise that server's version, since that tip is no longer its release commit. Every job checks out one SHA that `detect` resolved once. Needs `ALPIC_API_KEY` as a repo secret; npm auth is OIDC trusted publishing (registered against this repo + the `release.yml` filename), so no npm token exists anywhere — **renaming this workflow breaks publishing** until the trusted publisher is re-registered.


A release branch, its version bump, the changelog finalization, and the PR are produced by the **`/release` skill** (`.claude/skills/release/`), which asks which server ships — run it to cut a release rather than hand-assembling these. Merging that PR is what ships it, through the `release.yml` run above (`make publish` for the workshop and `make deploy` for the console remain as local escape hatches for a CI outage). Retry transient finishing-step failures at the same version; if a permanent defect makes a published workshop unshippable, deprecate that version on npm and fix forward with a new one.

### Deploying the console by hand

`make deploy` deploys the hosted console to Alpic **Production** (`alpic deploy`), release-guarded: it demands a clean `main` at `origin/main`'s tip whose HEAD is the commit that raised the console's version, and `make publish` holds the workshop to the same guards. Both are escape hatches for a CI outage; a release ships through `release.yml`. `make deploy-dev` and `make deploy-staging` ship the **working tree** — not the branch the environment is named after, since this project has no Alpic git integration — to the other two consoles, without the release guards. They name their environment id explicitly because the tracked `.alpic/project.json` pins Production and is the only thing telling `release.yml` where a release goes; the CLI relinks that file to whatever it deployed, so the recipe restores it from a `trap`, since an interrupt during the multi-minute build is the likely ending and a restore that runs only on a clean exit is the one that misses. `make deploy-envs` lists the environments and their URLs.

### Developing against a local SDK or UI

The SDK dependency is the published `@pipelex/sdk` npm package, not a `file:../pipelex-sdk-js` link, so CI just runs `npm ci`. To develop against local changes in `../pipelex-sdk-js` or `../mthds-ui`, `make use-local-sdk` / `make use-local-ui` (or `make use-local` for both) point the dependency at the sibling checkout through a `file:` link in every manifest that declares it — both in all three packages — and `make use-npm-sdk` / `make use-npm-ui` (or `make use-npm`) switch back. `make check` refuses to run while any such link is in place, so none is ever committed. Bump the `^x.y.z` range once the change is published.
