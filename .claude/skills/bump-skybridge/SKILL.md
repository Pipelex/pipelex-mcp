---
name: bump-skybridge
description: Bump the Skybridge framework this repo's hosted console is built on — the lockstep pair `skybridge` and `@skybridge/devtools` — to their latest published versions, or to a version the caller names. Reads the GitHub Releases that serve as Skybridge's changelog (there is no CHANGELOG.md anywhere), maps every breaking change onto the places this repo actually touches Skybridge (the console entrypoint, the tool-registration shell, the view hooks, the Vite plugin, the dev recipe, and the server bundle the console is started from), applies the bump, runs the checks, and then boots the console for real — because the automated suite boots the built console only against a stand-in authorization server, and never calls a tool or renders a view. Use this whenever the user says "bump skybridge", "update skybridge", "upgrade skybridge", "bump to skybridge 2", "migrate to skybridge v2", "bump the devtools", "are we behind on skybridge", or asks to pull in a newer Skybridge release. Also use it when the hosted console fails to boot, fails to register its tools, or renders a broken view while `make all` passes — that pattern almost always means the installed Skybridge disagrees with what `src/server.ts` and `src/hosted/server.ts` declare.
---

# Bump the Skybridge framework

Skybridge is the framework behind **one of this repo's two shells** — the hosted console on Alpic. It ships as a lockstep pair:

| Package | What it gives this repo | Block |
|---|---|---|
| `skybridge` | `McpServer` / `OAuthConfig` / `workosProvider` (`skybridge/server`), the view hooks and `generateHelpers` (`skybridge/web`), the Vite plugin (`skybridge/vite`), and the `skybridge dev \| build \| start` CLI, and the self-contained server bundle the console is started from | `devDependencies` |
| `@skybridge/devtools` | the DevTools UI `make dev` serves — the only way to exercise the console by hand | `devDependencies` |

Both come from `alpic-ai/skybridge`. `@skybridge/devtools` is declared as a **non-optional peer of `skybridge` pinned to the same major**, so they are not two independent bumps — move one and you have to move the other. Read the pin rather than assuming it: `npm view skybridge@<target> peerDependencies`.

The judgment in this skill is concentrated in Step 4 (what a release actually reaches in this repo) and Step 7 (booting the console, which is the only real check there is). Spend your effort explaining those; narrate the mechanical steps briefly.

## Why a green `make all` proves almost nothing here

This is the single most important thing to carry through the whole run, and it is the opposite of the situation an SDK bump is in.

**The workshop shell imports no Skybridge at all.** `src/local/` builds a plain MCP-SDK stdio server and imports nothing from Skybridge; the shell tests' only Skybridge symbol is a type-only `OAuthConfig` import in `src/shell-test-support.ts`, which sits outside it. So the two live detectors this repo is proud of — `make smoke`, which drives the workshop over stdio, and `make test-e2e`, which reaches the real API through the real `PipelexApiClient` — run the whole capability core **without ever loading the console shell**. They will pass with a completely broken console. Do not let a green e2e run stand in for a check on this bump.

What `make all` genuinely covers is narrow but real: `skybridge build` has to succeed (it regenerates the gitignored view-name registry `.skybridge/views.d.ts`, which is why `build` runs before `typecheck`), and `tsc` then checks that `src/server.ts`, `src/hosted/server.ts`, `src/helpers.ts` and the views still typecheck against the new `.d.ts` files. A renamed export or a changed signature does fail there, loudly. That is worth having.

What it cannot see is everything that only exists at run time or at deploy time:

- whether the server boots against the **real** WorkOS AuthKit (the OAuth provider is resolved with a top-level `await` in `src/server.ts`, and `workosProvider` performs discovery over the network);
- whether the per-request `extra.authInfo` a handler reads still arrives in that shape, since no automated check calls a tool on the built console;
- whether a **view renders**, since `_meta` plumbing and the host bridge are runtime contracts;
- whether the **CLI flags** the Makefile passes still exist (`make dev` appends `--port`).

Steps 7 and 8 exist for exactly that list.

**One gate does start the built console: `check:bundle`**, the step of `make check` right after the build. The console is started from `dist/server.bundle.js`, which `scripts/emit-server-bundle.mjs` copies out of the Vercel build output `skybridge build` writes (`.vercel/output/functions/mcp.func/index.js`), and `scripts/check-server-bundle.mjs` boots that copy from an empty directory, with no `node_modules` anywhere above it, against a local stand-in for AuthKit. It proves the bundle is self-contained, that it boots, that it refuses an anonymous call, and that an authenticated client gets the `tools/list` and view resources `src/hosted/console.contract.json` pins. So a release that moves the Vercel output, leaves a new package external, or changes what registration emits fails `make check`. It does not prove the four items above.

## Step 1 — Gather state

Show the user, for both packages, the declared range, what is installed, and what npm has:

```bash
for p in skybridge @skybridge/devtools; do
  echo "$p"
  echo "  range:      $(node -p "const m=require('./package.json'); m.dependencies['$p'] ?? m.devDependencies['$p']")"
  echo "  installed:  $(node -p "require('./node_modules/$p/package.json').version" 2>/dev/null || echo 'not installed')"
  echo "  npm latest: $(npm view "$p" version)"
done
git status --short
```

Two things to read carefully in that output.

**The declared range and the installed version can differ, and that changes what "bump" means.** Skybridge is past 1.0, so `^1.3.5` *admits* every later minor and patch — but admitting is not installing. `package-lock.json` is committed here and CI installs with `npm ci`, so the tree sits at exactly what the lock pins and a plain `npm install` leaves it there; only `npm update`, or naming a version explicitly the way Step 5 does, moves it. This is *not* the `0.x` situation the `bump-sdks` skill deals with, where the leading zero makes npm treat a minor as a major and pins it in the range itself. So say plainly which of the two you are moving: the **installed** version (what the lock pins, which an explicit install re-pins) or the **declared floor** (a deliberate edit, and the only way across a major). A major always needs the floor moved.

**Both packages are `devDependencies`, and the bump must keep them there.** The console is started from the server bundle, which inlines everything `skybridge/server` reaches, so nothing reads `skybridge` from `node_modules` at run time. Putting `skybridge` back in `dependencies` would change nothing for the console and would put its non-optional peers (`react`, `react-dom`, `vite`, `nodemon`, `@skybridge/devtools`) back into every `npx @pipelex/mcp` install, because the npm package and the console share one `package.json`. No test catches that move, so read the `package.json` diff in Step 11 rather than trusting the suite to object.

A dirty tree is not a blocker, but if `package.json`, `package-lock.json` or `CHANGELOG.md` is already dirty, say so and agree how to keep your edits separable before you start.

## Step 2 — Decide the target

Default to latest for `skybridge`, then resolve `@skybridge/devtools` **against** its peer pin — do not pick two versions independently:

```bash
npm view skybridge@latest peerDependencies
npm view "skybridge@$(node -p "require('./node_modules/skybridge/package.json').version")" peerDependencies
npm view @skybridge/devtools version          # the concrete version to aim at
```

**The peer pin is a range, not a version — it constrains the devtools target, it does not name it.** `skybridge@1.4.1` pins `@skybridge/devtools: ^1.1.0`, so "what the pin says" is a floor that `1.1.0` and `1.4.1` both satisfy; substituting it into Step 5 would write `^1.1.0` into `package.json` and silently lower the declared floor. So resolve a **concrete** `<devtools-target>`: take the newest published `@skybridge/devtools` that satisfies the pin and does not cross past `<target>`'s major — in practice the same version number as `<target>`, since the two ship together — and say out loud which version you settled on. If the newest devtools does **not** satisfy the pin, stop and show the user: the lockstep assumption has broken and a version has to be chosen by hand.

Diff those two peer sets and show the user. A peer that **appeared** may force another bump in this repo (a new `vite` floor, say); a peer that **vanished** is usually harmless but tells you the framework stopped owning something. Check each surviving peer against what this repo declares, and **work from the diff you just computed rather than from any list written here** — the peer set is version-specific and a major rewrites it. `react`, `react-dom` and `vite` are declared here and have been peers throughout; `nodemon` is a peer this repo leaves to npm's automatic peer install. The two that move are the lesson: at `1.4.1` the peers include `@modelcontextprotocol/sdk >=1.27.0` and **not** `zod`, while at `2.0.0` that inverts — `zod ^4.2.0` is added as a peer of `skybridge` itself and `@modelcontextprotocol/sdk` drops out of the peer set into Skybridge's own dependencies. This repo declares its own floor for both (`@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.3.6`, each in `dependencies`), so either can be the one that forces a second bump depending on which version you are moving to. None of the peers is optional — neither release declares `peerDependenciesMeta` — so every one of them binds.

If the user named a version, honour it exactly and still resolve the devtools pin from *that* version's peers. Record versions without a `v` prefix (`2.0.0`); the `v` belongs to git tags and the upstream release names only.

If this is a **major**, say so before going further and let the user decide whether to continue now. A Skybridge major rewrites the console's entrypoint shape, and Step 4 will be a migration rather than a version edit. Flag any downgrade and confirm it is intended.

## Step 3 — Read what changed

**Skybridge has no `CHANGELOG.md`** — not in the repo, not in the npm tarball. The release notes on GitHub are the only source, and they are written as prose with the mechanical before/after list at the end. Do not go hunting for a changelog file and conclude there were no breaking changes.

```bash
gh release list --repo alpic-ai/skybridge --limit 15
gh release view v<version> --repo alpic-ai/skybridge   # once per release in the range, oldest first
```

Read every release strictly after the current version through the target, oldest to newest — a two-minor jump can contain a deprecation in the first and its removal in the second, and only the pair explains what you are looking at. Without `gh`, the same content is at `https://api.github.com/repos/alpic-ai/skybridge/releases` (unauthenticated is fine for this public repo). The API reference behind the prose is `https://docs.skybridge.tech`.

Present the releases to the user newest first, calling out every breaking item. Mention the rest briefly — a DevTools feature or a new template is FYI, not work.

## Step 4 — Map what changed onto this repo's Skybridge surface

This is the step that matters. For each breaking item, answer one question: *does this repo touch that surface?* Work from what the repo declares. The whole surface is small enough to enumerate, so enumerate it:

```bash
grep -rni "skybridge" src/ vite.config.ts nodemon.json Dockerfile package.json Makefile 2>/dev/null | grep -v node_modules
```

**No `--include` filter, and `-i` rather than `-n` alone — both deliberate.** `--include` applies to the explicitly named operands too, not only to what `-r` walks, so `--include="*.ts"` drops `package.json`, `Dockerfile`, `Makefile` and `nodemon.json` from the very command that lists them: the enumeration comes back source-only and the two version declarations the bump has to edit never appear. And the wiring points spell the name capitalized in prose (`Dockerfile`, `Makefile`), which a lowercase pattern misses.

### 4a — The console entrypoint and the tool-registration shell

`src/server.ts` resolves `workosProvider({ domain, audience })`, hands the resulting `OAuthConfig` to `createHostedServer`, and ends with `export default await server.run()` plus `export type AppType = typeof server`. `src/hosted/server.ts` takes that config, constructs `McpServer` and chains `.registerTool(hostedToolConfig(tool), (input, extra) => …)` once per tool, reaching `extra.authInfo` for the caller's verified token; `hostedToolConfig` reads `{ name, description, inputSchema, outputSchema, annotations, view?, _meta }` off the console's own definitions in `src/hosted/tools.ts`, which is where each tool's `view` and `_meta` are declared (typed with Skybridge's `ViewConfig`).

Those two files are where a Skybridge major lands hardest, and the chain carries more than it looks: **`AppType` is inferred from the chained server**, `src/helpers.ts` feeds it to `generateHelpers<AppType>()`, and the views' `useCallTool` types come from there. Break the chain and the views lose their types several files away from the edit.

Two details in this repo that a migration must preserve rather than flatten:

- **`createHostedServer` takes `oauth` as a required first argument and stays synchronous.** That is deliberate: the shell tests (`src/hosted/server.test.ts`, `src/tool-names.test.ts`) and `scripts/check-tool-texts.ts` construct the server directly and must not await an OAuth discovery fetch. `src/hosted/console.contract.json` pins what the console emits (`initialize`, `tools/list`, `resources/list`), so a bump that changes Skybridge's emitted metadata shows up there as a snapshot diff — read it before accepting it with `-u`. If the new shape wants the provider inside a config object, keep the builder a function of its argument — do not move the discovery call into it.
- **`src/server.ts`'s two startup refusals** (both env vars present; the Resource Indicator being the bare origin with a trailing slash) must still run **before** anything serves. They are the difference between a misconfigured deploy failing loudly and one that boots clean and then fails every tool call at audience verification.

### 4b — The view layer

```bash
grep -rn "skybridge/web" src/
```

`src/helpers.ts` calls `generateHelpers<AppType>()`; `src/views/run-graph.tsx` and `src/views/run-follow.tsx` pull `useDisplayMode`, `useLayout`, `useSendFollowUpMessage` and `useViewState`. A release that regroups the hooks surface renames these or moves them behind a namespace — `tsc` catches that, which is the good case.

What `tsc` cannot catch is the runtime side of the same contract: `responseMetadata` (this repo's view-only `_meta` channel), `useToolInfo`'s `output`, and the display-mode handshake are all data crossing the host bridge. A release that changes how `_meta` is delivered compiles perfectly and renders an empty state. Anything in the notes touching `_meta`, `responseMetadata`, display modes or the view bridge means Step 7 is mandatory rather than optional.

### 4c — The build and dev toolchain

Four wiring points, none of them in `src/`, and each fails in its own quiet way:

- **`vite.config.ts`** imports `skybridge()` from `skybridge/vite`. A plugin option change surfaces at build time, so `make all` covers it.
- **`.skybridge/views.d.ts`** is gitignored and regenerated as `skybridge build`'s first step. No Make target removes it — `make clean` takes `dist`, `coverage` and `*.tsbuildinfo` only — but `skybridge build` rewrites it, so `make all` refreshes it in passing. `rm -rf .skybridge dist` is how to force it by hand.
- **`nodemon.json`** overrides Skybridge's default dev exec with `tsx --env-file-if-exists=.env src/server.ts`. Two hazards: a `nodemon.json` **replaces** Skybridge's watch defaults rather than extending them, so a change to what Skybridge watches never reaches us; and if a major splits the entrypoint (app definition in one file, `run()` in another), this `exec` must be repointed at whichever file actually runs.
- **The Makefile's `dev` and `dev-tunnel` recipes append `--port "$CONSOLE_PORT"`** to pin the console to 6843, because the WorkOS Resource Indicator names the port and Skybridge's default walks up from 3000 when it is busy. `src/make-dev-recipe.test.ts` asserts the recipe *text* and executes only its guard prelude under `sh` — it never invokes the Skybridge CLI. So a renamed or removed `--port` flag leaves that test green and breaks `make dev` for everyone.

### 4d — The deploy surface

Alpic's `startCommand` in `alpic.json` and the `Dockerfile`'s `CMD` both run `node dist/server.bundle.js`, a copy of `.vercel/output/functions/mcp.func/index.js`. That path is Skybridge's Vercel build output, not a promised interface, and it is where a release is most likely to break this repo without touching a line of `src/`. Three things guard it, and each tells you something different when it fails:

- `scripts/emit-server-bundle.mjs` (the last step of `npm run build`) refuses when the file is missing, when it is older than this build's `dist/__entry.js`, or when the function directory holds a file other than the bundle, `.vc-config.json` and `package.json`. The first two mean Skybridge moved or stopped writing its Vercel output; find where the bundle went before anything else. The third means esbuild now ships a file beside the bundle (a native addon, say), which the copy would leave behind.
- `check:bundle` failing to boot from the empty directory means a package is now left external. Read the esbuild call in `node_modules/skybridge/dist/cli/build-helpers.js`: today only `vite` and `@skybridge/devtools` are external, the two dev-only packages whose code paths the production define strips.
- `EXPOSE` and the port: the bundle listens on `__PORT`, default 3000, which is what the `Dockerfile` exposes. A release that renames that variable or moves the default changes both the `Dockerfile` and how Alpic reaches the console.

### 4e — What a major looks like, as a worked example

The `1.x → 2.0` release is the shape to expect, and it is worth reading even on a smaller jump because it shows where the blast radius runs. It moved the MCP protocol revision forward and, to do it, stopped sharing one long-lived server across requests: registration moved into a `handler` the framework calls per request, `new McpServer(info, caps, { oauth })` became a single `new Skybridge({ name, version, oauth, handler })` config object, the app definition and the `run()` call split across two files, and the auth info a handler reads moved down a level on `extra`. Every one of those touches 4a, and the entrypoint split touches 4c's `nodemon.json` as well. That is one release reaching five of this repo's files, none of them in `capabilities/`.

### 4f — What you cannot fix mechanically

Behavior changes, a changed per-request lifecycle, new defaults, and anything touching auth need human judgment. **Never guess at these.** Collect them into a short "needs your call" list, explain how each one reaches this repo, and let the user decide before continuing. If one of them will break the build, say so now rather than letting Step 6 surface it as a mystery.

## Step 5 — Apply the bump

There is no Makefile switch for these two (the `use-npm-*` targets are `@pipelex`-only). **Edit both version strings in `package.json` first, then resolve once** — both under `devDependencies`, where they already are:

```jsonc
// package.json — two edits, in place, both in devDependencies
"devDependencies": { "skybridge": "^<target>", "@skybridge/devtools": "^<devtools-target>" }
```

```bash
npm install
```

**Two edits then one resolve, rather than two `npm install` commands — and that ordering is the point.** The packages are peer-coupled: `skybridge@2.0.0` peers `@skybridge/devtools@^2.0.0`, non-optionally. So `npm install --save-prod skybridge@2.0.0` run on its own, while the old `@skybridge/devtools@^1.4.1` is still declared at the root, asks npm to place a package whose peer contradicts a root dependency — which is the canonical `ERESOLVE` shape, and it aborts before the second command ever runs. Editing both entries first means npm sees one consistent manifest and resolves it in a single pass. It also makes the block question moot: nothing is being re-added, so nothing can infer the wrong block.

`<target>` is what Step 2 settled on and `<devtools-target>` is the concrete version Step 2 resolved against the peer pin — never the pin's own range, and never a literal typed from this document. `2.0.0` is a real published release, so a copied literal succeeds and silently performs the migration Step 2 says to put to the user first.

Then confirm both landed, and that npm is not quietly unhappy about a peer:

```bash
node -p "require('./node_modules/skybridge/package.json').version"
node -p "require('./node_modules/@skybridge/devtools/package.json').version"
npm ls skybridge @skybridge/devtools
```

Show the user the `package.json` diff, and check the two entries did not swap blocks.

## Step 6 — Run the checks

```bash
make clean && make check && make agent-test
```

That is `make all`, with the agent-facing test target substituted: same hermetic suite, but output is replayed only on failure with a heartbeat while it runs. (`make all` itself is fine when a human is watching.)

The order inside `check` is deliberate — lint, format check, `skybridge build` (which ends by copying the server bundle), `check:bundle`, the tsup workshop bundle, then typecheck — because the build regenerates the view-name registry `tsc` needs to resolve each view's `view.component`, and `check:bundle` can only boot what the build just wrote.

**On failure**, connect each error back to Step 4 rather than dumping output. A typecheck error naming `McpServer`, `OAuthConfig` or a `skybridge/web` hook is the framework telling you precisely which surface moved; that is the system working. If a failure traces to a 4f item, stop and ask.

And remember what green means here: the console compiled, and its bundle booted against a stand-in authorization server and listed its tools. It has not run a tool, met the real AuthKit, or rendered a view.

## Step 7 — Boot the console and use it

This is the step that carries the bump. Nothing before it has started the server.

```bash
make dev    # run it in the background — it is a watch server and never exits
```

**`make dev` does not return, so never run it in the foreground**: it is `skybridge dev` under nodemon, and a foreground call simply burns the Bash timeout and is killed with the console still unexamined. Start it in the background, then read its log to learn whether it booted.

**Items 2 and 3 below are browser work, and an agent cannot do them.** Driving DevTools means an authenticated WorkOS session in a real browser. So an agent does what it can reach from a shell — the server boots, the port is listening, `/.well-known/oauth-protected-resource` serves the right resource indicator, and an unauthenticated `tools/list` is refused with a well-formed challenge, which together prove the entrypoint's refusals passed and `workosProvider` completed discovery — and then **hands items 2 and 3 to the user**, saying plainly which checks are still outstanding rather than reporting the step as done. Leave the server running for them, and say where it is.

It needs `WORKOS_AUTHKIT_DOMAIN` and `PIPELEX_MCP_RESOURCE_INDICATOR` in `.env` — the console has no keyless mode and refuses to boot without them. `wt` copies `.env` into a new worktree, so it is usually already there; if it is not, say so rather than working around it, because there is no substitute for this step.

Watch three things, in order, and report each:

1. **It boots.** A throw here is `src/server.ts`'s own refusal (read the message — it names the fix) or `workosProvider` failing discovery against the new version.
2. **The tools list.** Open `http://localhost:6843` and check every console tool is advertised, the console-only `mthds_upload_attachments` included. A registration-shape change can drop tools silently.
3. **A tool runs and its view renders.** Call `mthds_validate` on a valid bundle: the structured verdict proves `extra.authInfo` still reaches `contextsForRequest` with the caller's token, and the `run-graph` view rendering proves the `_meta` channel survived. If Step 4b flagged anything about `_meta` or the hooks, this is the assertion; if the graph comes up empty, that is the 4b failure mode, not a bad bundle.

One diagnosis to keep straight, because it wastes the most time: **a DevTools session lives only as long as its WorkOS access token, and only a page reload renews it.** After it expires, a tool call returns the console's 401 and DevTools shows nothing at all — which reads exactly like "the bump broke the tool". Reload the tab. Restarting `make dev` fixes nothing and strands the tab on "Connecting to server…".

## Step 8 — Ship it to the Dev console

Compiling and running locally still leaves the platform build untested, and on a major that is where the last surprises live.

```bash
make deploy-dev
```

That ships the **working tree** (not a branch) to the Dev environment and restores the tracked `.alpic/project.json` afterwards. Offer it; treat it as strongly recommended on a major and optional on a patch. When it is done, exercise the deployed console the way Step 7 exercised the local one.

## Step 9 — Sync the prose that names Skybridge behavior

This repo's `CLAUDE.md` carries several paragraphs that are statements *about Skybridge*, not about this repo, and a bump can falsify them without touching a line of code. Check each one you have reason to doubt:

```bash
grep -rn "Skybridge\|skybridge" CLAUDE.md README.md docs/ SPEC.md
```

The ones most exposed are the pinned-port paragraph (Skybridge's default port and its walk-up-when-busy behavior), the `nodemon.json` note (that it replaces the watch defaults), the DevTools token-lifetime note, and the `dependencies` paragraph, which explains why `skybridge` is a devDependency and names the server bundle's path. Record *why* something moved, not only that it did.

Two more, both flag-don't-fix:

- **The vendored `.claude/skills/skybridge/` skill is hash-locked** in `skills-lock.json` and is not editable here. A major makes it stale — its references will describe the old app shape. Say so, and leave it: the lock's `computedHash` is not a plain sha256 of `SKILL.md`, so it cannot be honestly recomputed locally. If the drift matters, that is a ledger item, not a silent rewrite.
- **The `alpic` CLI and `@alpic-ai/ui`** are the same vendor but a different concern, and are deliberately outside this skill's scope. If a release note implies one of them has to move too, raise it and let the user decide.

## Step 10 — Update `CHANGELOG.md`

Entries accumulate under `## [Unreleased]` — create that heading above the newest version heading if a release has consumed it. This repo's format is `## [x.y.z]` with **no `v` prefix**.

Add a `### Changed` bullet naming both packages and the versions they moved from and to, then write for *this repo's* reader rather than restating the upstream notes: name the console behavior that changed, the file that was migrated, or the bug that is now fixed. If anything is user-visible or operator-visible — a changed env var, a changed port, a changed deploy entry — put it under `### Breaking Changes` in this repo's own terms.

## Step 11 — Review and commit

Summarise: `old → new` for both packages, every file touched, every 4f item still unresolved, and what Steps 7 and 8 actually showed. Then ask for confirmation.

On approval:

1. Stage **only** what this bump touched — `package.json`, `package-lock.json`, `CHANGELOG.md`, plus whatever Steps 4 and 9 migrated. Never `git add .` or `git add -A`.
2. Read the `package.json` diff one more time for the block boundary: `skybridge` and `@skybridge/devtools` both under `devDependencies`.
3. If the branch is `dev` or `main`, stop — this repo's work happens in a worktree off a prefixed branch (`fix/ feature/ refactor/ chore/ docs/ ci-cd/ changelog/ codex/`). `chore/Bump-skybridge` is the usual name.
4. Commit as `chore: bump skybridge and @skybridge/devtools to X.Y.Z`, with a body naming any migration applied and what the console check showed.

Then *offer* — do not run — a `/rev` pass, pushing, and opening a PR. PRs target `dev`; only a `release/vX.Y.Z` branch may target `main` here. A major migration deserves the review pass before the PR opens.

## Rules

- Move both packages together, at the major the `skybridge` peer pin names.
- Never treat a green `make all`, `make smoke` or `make test-e2e` as evidence the console works. The last two never load the console shell, and `make all`'s `check:bundle` boots it against a stand-in authorization server without calling a tool or rendering a view.
- Never skip Step 7 on a major. A console that compiles is not a console that boots.
- Keep `skybridge` and `@skybridge/devtools` in `devDependencies`; no test catches a move back into `dependencies`.
- Don't look for a `CHANGELOG.md` upstream — GitHub Releases are the changelog.
- Never guess at a behavior or auth change — flag it and let the user decide.
- Never rewrite the vendored `skybridge` skill or its lock hash.
- Never push, deploy to Staging or Production, or open a PR without explicit approval.
- If any step fails or the user aborts, stop immediately.
