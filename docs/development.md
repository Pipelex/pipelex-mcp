# Developing pipelex-mcp

This page is for working on this repository: running the hosted console on your machine, building both servers, the test suites, and how versions are cut. [`CLAUDE.md`](../CLAUDE.md) holds the conventions behind all of it and the reasons for them, and [`SPEC.md`](../SPEC.md) is the source of truth for the tool contracts.

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

The Resource Indicator must also be registered in the WorkOS dashboard (Connect → Configuration), along with Dynamic Client Registration. It becomes the issued token's `aud`, and the server verifies it byte-for-byte — registering the `/mcp` path or dropping the trailing slash yields tokens that never validate. The startup check rejects both mistakes with a message naming the fix, rather than letting every tool call fail later at audience verification.

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
npm run check        # lint + format:check + check:tool-texts + build + check:bundle + check:cascade + build:local + typecheck
```

**The console starts from one self-contained file, `packages/console/dist/server.bundle.js`.** `skybridge build` ends by writing a Vercel build output whose function is an esbuild bundle of the whole server, the core and every package inlined but the dev-only `vite` and `@skybridge/devtools`, whose code paths it strips; the console's `npm run build` copies that bundle into its `dist/` (`packages/console/scripts/emit-server-bundle.mjs`), and both the root `alpic.json` and the `Dockerfile` start it. The bundle is what lets the console run where the workspace does not: Alpic's runtime image holds the root `node_modules` and the build output, and the core's entry in that `node_modules` is a link to a directory the image does not carry. Skybridge, React, React DOM, Vite and nodemon are the console's to declare, and none of them reaches an `npx @pipelex/mcp` install, since the workshop's manifest does not name them. The bundle's path is Skybridge's Vercel output rather than a promised interface, so `check:bundle` (`packages/console/scripts/check-server-bundle.mjs`) copies the bundle alone into an empty directory, boots it there against a local stand-in for the AuthKit discovery document and its keys, and asserts that it answers its OAuth metadata, refuses an anonymous call, and serves the tools and views the console's contract snapshot pins. It never touches the network.

`pipelex_show_method` registers the `run-graph` view (`packages/console/src/views/run-graph.tsx`) and `pipelex_run` the `run-follow` view, which satisfies Skybridge's "≥1 view entry" production-build requirement. The Skybridge build scans the console's `src/views/` and regenerates its `.skybridge/views.d.ts` (the view-name registry) as its first step, so `npm run check` runs `build` before the standalone `typecheck` — the registry must exist for `tsc` to resolve the registered view name. The workshop's build follows, and its `prepack` rebuilds the bin and copies the root `README.md` and `LICENSE` into the package, so a pack or publish can never ship a stale or absent bin; `postpack` removes the copies.

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

The by-id paths and the catalog-write suite need durable fixture methods in the API key's organization; `make seed-e2e-fixture` creates or refreshes them, idempotently, and no `make test-e2e` run ever creates one. See [`CLAUDE.md` → "Detecting API drift"](../CLAUDE.md#detecting-api-drift).

## Versioning

The two servers are released separately, each on its own track following [Semantic Versioning](https://semver.org):

| Server | Version | Changelog | Release branch | Tag | What the merge ships |
| --- | --- | --- | --- | --- | --- |
| The workshop, `@pipelex/mcp` | `packages/workshop/package.json` | [`packages/workshop/CHANGELOG.md`](../packages/workshop/CHANGELOG.md) | `release/vX.Y.Z` | `vX.Y.Z` | an npm publish |
| The console | `packages/console/package.json` | [`packages/console/CHANGELOG.md`](../packages/console/CHANGELOG.md) | `release/console-vX.Y.Z` | `console-vX.Y.Z` | an Alpic deploy |

Up to and including 0.19.0 both servers shipped together at one version, tagged `vX.Y.Z`, and the workshop's changelog carries that joint history. `0.1.0` is the first tagged release.

Merging a release pull request into `main` is what ships a version, of the one server its branch names: the release workflow reads each server's version at the merge commit, publishes the workshop to npm or deploys the console to Alpic when that server's version rose, and tags the commit with that server's tag. A release of one server never ships the other. The `/release` skill cuts a release and asks which server ships, and [`CLAUDE.md`](../CLAUDE.md#ci) describes the release workflow and its guards.
