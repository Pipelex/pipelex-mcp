# Developing pipelex-mcp

This page is for working on this repository: running the hosted console on your machine, building both servers, the test suites, and how versions are cut. [`CLAUDE.md`](../CLAUDE.md) holds the conventions behind all of it and the reasons for them, and [`SPEC.md`](../SPEC.md) is the source of truth for the tool contracts.

## Hosted console: local development

The hosted server is a Skybridge app. During early development this repo also supports the local `pipelex-api` runner so the MCP can be exercised before the hosted path is fully wired — temporary; the production target is the hosted Pipelex API only.

Prerequisites:

- Node.js 24.14.1 or later
- A Pipelex API serving `POST /v1/validate` and `POST /v1/build/inputs` (a local `pipelex-api` during development)
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

`PIPELEX_BASE_URL` defaults to the hosted Pipelex API when unset — set it to `http://localhost:8081` to develop against a local runner. `PIPELEX_API_KEY` has **no effect on the console**: the caller's verified OAuth token always overrides it. `.env` is dev-only and loaded via `nodemon.json` (`tsx --env-file-if-exists=.env`); it is not watched, so restart the dev server after editing it. `make dev` also sources it with `sh` before Node reads it, so keep it to plain `KEY=value` lines (no `$`, `#`, spaces or backticks inside a value; none of the console's keys need any), and `set -a` there exports the whole file to every process under `npm run dev`, the `alpic tunnel` CLI included.

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
npm run build        # Skybridge app (regenerates .skybridge/views.d.ts first)
npm run build:local  # tsup → dist/local/main.js (the npm-distributed bin)
npm run check        # lint + format:check + check:tool-texts + build + check:cascade + build:local + typecheck
```

`mthds_validate` registers the `run-graph` view (`src/views/run-graph.tsx`), which satisfies Skybridge's "≥1 view entry" production-build requirement. The Skybridge build scans `src/views/` and regenerates `.skybridge/views.d.ts` (the view-name registry) as its first step, so `npm run check` runs `build` before the standalone `typecheck` — the registry must exist for `tsc` to resolve the registered view name. The local build follows and `prepack` rebuilds it, so a pack/publish can never ship a stale or absent bin.

## Tests

```bash
make test         # the default suite — hermetic, no network
make agent-test   # the same suite for an agent — quiet unless it fails
make test-e2e     # the live suite — real client, real Pipelex API
make smoke        # the workshop stdio server, end to end, against the live API
make test-all     # all of the above plus the run family — SPENDS INFERENCE CREDIT
```

`make test` fakes every API client, so it proves the projections and never touches the network; `make all` and CI run only that. The live targets are the drift detector: the faked seams mean a wire-shape change on the API side fails nothing at all in the hermetic suite, so `make test-e2e` calls each capability with the real `PipelexApiClient` and `make smoke` drives the whole shell over stdio. Both read their own pair, `PIPELEX_E2E_API_KEY` and optionally `PIPELEX_E2E_BASE_URL` (it defaults to `https://api-dev.pipelex.com`), from the make command line, then a gitignored `.env` at the repo root, then the shell, and never read `PIPELEX_API_KEY` / `PIPELEX_BASE_URL`, so a key exported in your shell for other tools cannot aim them at another deployment; and neither spends inference credit — the run family that does only fires under `make test-e2e-run`. Their codegen legs need one thing more against the hosted API: `/v1/codegen` sits behind the `FF_PLAYGROUND` feature flag as well as the plan, so a perfectly valid key whose organization is not enabled for it gets a 403 that reddens the whole run — ask for the flag, or point `PIPELEX_E2E_BASE_URL` at a local runner, which does not gate the route. `make smoke` is entirely read-only. `make test-e2e` writes: the workshop arm of `mthds_prepare_inputs` uploads a 1x1 PNG to your organization's Pipelex storage to prove the upload path still rewrites values to `pipelex-storage://`, its by-address leg uploads another, and the catalog-write suite updates a seeded fixture method. The SDK exposes no storage delete, so the uploaded objects persist.

`make test-all` chains all three in cost order and adds the run family, so a single command covers every test in the repo; it spends inference credit, which is why `make all` does not reach it. `make agent-test` is the same hermetic suite as `make test` with its output captured and replayed only on failure, plus a heartbeat while it runs — meant for coding agents, whose context a few hundred lines of green vitest output would otherwise fill.

The by-id paths and the catalog-write suite need durable fixture methods in the API key's organization; `make seed-e2e-fixture` creates or refreshes them, idempotently, and no `make test-e2e` run ever creates one. See [`CLAUDE.md` → "Detecting API drift"](../CLAUDE.md#detecting-api-drift).

## Versioning

`pipelex-mcp` follows [Semantic Versioning](https://semver.org); `version` in `package.json` is tagged (`vX.Y.Z`) on release, and npm publish and the Alpic deploy ship together at one version. See [`CHANGELOG.md`](../CHANGELOG.md) for what has shipped. `0.1.0` is the first tagged release.

Merging a `release/vX.Y.Z` pull request into `main` is what ships a version: it publishes `@pipelex/mcp` to npm, deploys the console to Alpic and tags the commit. [`CLAUDE.md`](../CLAUDE.md#ci) describes the release workflow and its guards.
