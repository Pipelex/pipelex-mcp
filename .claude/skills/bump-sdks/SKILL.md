---
name: bump-sdks
description: Bump this repo's two @pipelex npm dependencies — @pipelex/sdk and @pipelex/mthds-ui — to their latest published versions (or to versions the user names). Reads each package's CHANGELOG for the versions in between, maps every breaking bullet onto the client seams and view casts this repo actually declares, applies the bump through the Makefile, runs the checks, offers a live smoke run against the real API, and prepares a reviewable commit. Use this whenever the user says "bump the sdk", "bump the sdks", "bump @pipelex/sdk", "bump mthds-ui", "update the pipelex sdk", "upgrade the sdks", "is there a new sdk version", "are we behind on the sdk", or asks to pull in a newer @pipelex/sdk or @pipelex/mthds-ui release. Also use it when a tool fails at runtime against the live API while `make all` passes — that pattern usually means the installed SDK is behind the API.
---

# Bump the @pipelex SDKs

This repo depends on two published `@pipelex` packages, and both are pre-1.0:

| Package | What it gives this repo | Source repo |
|---|---|---|
| `@pipelex/sdk` | `PipelexApiClient` — every API call the capabilities make | `Pipelex/pipelex-sdk-js` |
| `@pipelex/mthds-ui` | `GraphViewer` / `GraphSpec` — the run-graph and run-follow views | `Pipelex/mthds-ui` |

Because they are `0.x`, npm treats the leading zero as the major: a `^0.9.0` range auto-resolves patches only, so every minor bump (`0.9.0 → 0.10.0`) needs a deliberate edit. **Bump both by default.** Only narrow to one package, or to a specific version, if the user asked for that.

Work through the steps below, showing the user each file change and each install before moving on. The judgment in this skill is concentrated in Step 4 — reading the changelogs and deciding what this repo actually has to migrate — so spend your effort explaining there, not narrating the mechanical steps.

## Why this repo needs more than `make all`

Every capability here talks to the SDK through a **hand-written narrow interface** (`CatalogClient`, `RunClient`, `MethodFetchClient`, …) that restates the SDK method signatures this repo uses. Tests inject fakes that satisfy those local interfaces. That design is good for testing and it creates one specific blind spot you must plan around:

- A **type** change in the SDK is caught — each capability falls back to `new PipelexApiClient(...)` where the local interface is expected, so `tsc` structurally compares the two and fails.
- A **behavior or wire-shape** change is *not* caught. The local interface still compiles, the fakes still return the shape they were written for, and `make all` goes green while the real client is broken against the live API.

This is not hypothetical. On SDK `0.9.0` the whole suite passed while `mthds_list_methods` failed on every real call with `wire.map is not a function` — the platform had reshaped `GET /v1/methods` into a page object and `0.9.0` still called `.map()` on the response. Step 4 and Step 7 exist to catch exactly that class of failure, and Step 7 is now a real target (`make smoke`) rather than a probe you assemble by hand.

## Step 1 — Gather state

Show the user, for both packages, the declared range, what is actually installed, and what npm has:

```bash
for p in sdk mthds-ui; do
  echo "@pipelex/$p"
  echo "  range:     $(node -p "require('./package.json').dependencies['@pipelex/$p']")"
  echo "  installed: $(node -p "require('./node_modules/@pipelex/$p/package.json').version" 2>/dev/null || echo 'not installed')"
  echo "  npm latest: $(npm view @pipelex/$p version)"
done
git status --short
```

**If either range reads `file:` / `link:` / `portal:`**, the repo is mid local-SDK development (`make use-local-sdk` / `make use-local-ui`). A bump targets the *published* package, so this must be undone first — and `make check` will refuse to run until it is, via the `check-no-local-deps` guard. Tell the user and offer to run `make use-npm-sdk` / `make use-npm-ui` to get back to a clean baseline before bumping.

A dirty working tree is not a blocker — this repo's checks don't need a clean tree. But if `package.json`, `package-lock.json`, or `CHANGELOG.md` is *already* dirty, say so and ask how to proceed: your edits will land on top of unrelated in-flight work in the same files, and Step 9 has to keep them apart.

## Step 2 — Decide the targets

Default to latest for both. If a package is already at latest, say so and drop it from this run rather than reinstalling it.

If the user named a version or a single package, honour that exactly. Otherwise, when there is a real choice to make (a large jump, or one package moving several minors), use `AskUserQuestion` to confirm — offering latest as the recommended default and letting them type a specific version.

Record targets without a `v` prefix (`0.12.0`). Flag any downgrade and confirm it is intended.

## Step 3 — Read what changed

You need each package's `CHANGELOG.md` entries strictly after its current version through its target. Their headings carry a `v` (`## [v0.12.0] - YYYY-MM-DD`) — **this repo's own changelog does not** (see Step 8), so don't let the two formats bleed into each other.

Prefer a sibling checkout, but **verify it is current before trusting it** — that is the trap here, not a formality. A workspace checkout sitting on `dev` a few commits behind `origin` simply will not contain the newest release entry, and you will silently review an incomplete set of breaking changes:

```bash
grep -n "^## \[v${TARGET}\]" ../pipelex-sdk-js/CHANGELOG.md   # ../mthds-ui for the UI
```

- **Heading found** → the checkout covers the target; read it from there.
- **Heading missing** → the checkout is stale. Either `git fetch && git show origin/main:CHANGELOG.md` in that repo, or fall back to GitHub raw:
  - `https://raw.githubusercontent.com/Pipelex/pipelex-sdk-js/main/CHANGELOG.md`
  - `https://raw.githubusercontent.com/Pipelex/mthds-ui/main/CHANGELOG.md`

Neither published npm tarball ships a `CHANGELOG.md`, so there is nothing to read in `node_modules` — GitHub raw is the only network-only source. Never assume the sibling checkouts exist at all.

Present the entries to the user grouped by package, then by version, newest first. **Call out every bullet marked "Breaking"** — those are the ones that can reach this repo. Mention the rest briefly; internal refactors, CI changes and additive APIs are FYI.

## Step 4 — Map the breaking changes onto this repo's real surface

This is the step that matters. For each breaking bullet, answer one question: *does this repo touch that surface?* Work from what the repo declares, not from memory.

### 4a — The SDK client seams

Every place the SDK's shape is restated locally is a place a breaking change has to be re-reconciled by hand. Find them all:

```bash
grep -rn "interface .*Client" src/ --include="*.ts" | grep -v test
grep -rn "new PipelexApiClient" src/ --include="*.ts"
```

They live in `src/capabilities/` — the catalog client, the shared method-fetch client, and the validation, inputs, prepare, attachment-upload and run clients, plus the `SizeGuardedPipelexApiClient` subclass in `upload-ceiling.ts` that overrides the `upload` wire call. For each seam whose methods appear in a breaking bullet:

1. Read the local interface's declared signature.
2. Read the new SDK's actual signature (`node_modules/@pipelex/sdk/dist/**/*.d.ts` after Step 5, or the sibling checkout's source before it).
3. Update the local interface to match, then follow the call site through — a return-shape change usually means the projection function downstream needs reworking too, not just the type. A method that now returns a page object rather than an array is the canonical example: the interface, the call site, *and* the projection all move.

`SizeGuardedPipelexApiClient` deserves its own look on any SDK bump: it overrides `upload` specifically because that is the one seam both upload paths funnel through. If the SDK reorganises where the wire call happens, that override can go silently dead — it would still compile.

### 4b — The test fakes

```bash
grep -rln "client:" src/ --include="*.test.ts"
```

A fake written against the old shape keeps the suite green through a breaking change. Every fake for a seam you touched in 4a needs the same reshaping, and its assertions need re-reading — otherwise the tests now assert the old contract.

### 4c — The mthds-ui views

`GraphSpec` is owned by `@pipelex/mthds-ui`, and `graph_spec` arrives opaque on the wire, so `src/views/run-graph.tsx` and `src/views/run-follow.tsx` reach it through an `as GraphSpec | null` cast. **A cast means `tsc` can never catch a `GraphSpec` shape change** — a UI bump that reshapes the spec compiles perfectly and degrades to `GraphViewer`'s internal empty state at runtime. So on any `@pipelex/mthds-ui` bump, read its changelog specifically for `GraphSpec`, `validateGraphSpec`, `GraphViewer` props, `TOOLBAR_POSITION`, and the `@pipelex/mthds-ui/graph/react` entry point, and treat a change to any of them as needing the visual check in Step 7.

### 4d — Everything mechanical

Some bullets are a plain rename — an option, an export, an env var written as `` `oldName` `` → `` `newName` ``. For those, grep the **whole repo**, not just `src/`: env var names in particular leak into `README.md`, `SPEC.md`, `CLAUDE.md`, `.env.example`, and `wip/` notes. Apply the rename everywhere and show the diff — this workspace keeps no backward-compatibility shims, so there is nothing to preserve. The one place to leave untouched is this repo's **already-dated `CHANGELOG.md` release headings**: those record what was true at that release. Step 8 is where the changelog gets its new entry.

Run `make format` after any edit, not just renames. Prettier re-flows on line length, so reworking a function body or a Markdown table will fail `format:check` on whitespace alone — a confusing way to fail Step 6 if you have forgotten that your own edit caused it.

### 4e — What you cannot fix mechanically

Behavior changes, removed methods, changed error shapes and new defaults need human judgment. **Never guess at these.** Collect them into a short "needs your call" list, explain how each one reaches this repo, and let the user decide before you continue. If any of them will break `make all`, say so now rather than letting Step 6 surface it as a mystery.

## Step 5 — Apply the bump

Use the Makefile targets rather than editing `package.json` by hand — they install and re-lock in one step, and they keep the caret style:

```bash
make use-npm-sdk VERSION=0.12.0
make use-npm-ui  VERSION=0.17.0
```

Omitting `VERSION` installs `latest`. Confirm each landed:

```bash
node -p "require('./node_modules/@pipelex/sdk/package.json').version"
node -p "require('./node_modules/@pipelex/mthds-ui/package.json').version"
```

Then show the user the resulting `package.json` diff.

## Step 6 — Run the checks

```bash
make all
```

That is clean + check + test: lint, format check, the Skybridge build, the tsup workshop bundle, typecheck, and Vitest. Note the build runs *before* typecheck on purpose — Skybridge regenerates the view-name registry that `tsc` needs to resolve the views' `view.component`.

**On failure**, show the errors and connect them back to Step 4 rather than dumping output. A typecheck error naming a client seam is the SDK telling you exactly which seam moved — that is the system working, not a surprise. If the failure traces to one of the 4e items, say so and ask how to proceed instead of guessing a fix.

Remember what green means here: the suite ran against fakes. It has not touched the API.

## Step 7 — Smoke it against the real API

An SDK bump always moves the API call path, and this repo has no e2e suite yet — so this is the only step that exercises the real `PipelexApiClient` against the live platform. Offer it every time.

```bash
make smoke
```

That spawns the workshop stdio server the way a host does, completes the MCP handshake, then calls `mthds_list_methods`, `mthds_validate` and `mthds_inputs_template` against the live API and asserts on their `structuredContent` (`scripts/smoke.ts` holds the assertions). Every call is read-only and spends no inference credit. Ask before running it — it does hit the live API with the user's key.

The target resolves `PIPELEX_BASE_URL` and `PIPELEX_API_KEY` from the shell or a gitignored `.env`, preflights `/v1/version`, and refuses to start without a key. Against a keyless local OSS runner, `npm run smoke` skips those guards.

Read the result as a whole rather than the exit code alone:

- **`SMOKE PASSED`** — the shipped client and the live API agree on every checked shape.
- **A failed check** — the real client disagreeing with the real API, which is precisely what Step 6 cannot see. The script names the tool, the field, and what it got. If the API moved, the fix belongs in `../pipelex-sdk-js` (plus its own e2e), then a bump here — never a local patch that papers over it.
- **`catalog is EMPTY`** on a pass — a note, not a failure, and worth repeating to the user: the org holds no methods, so row projection was not exercised by that run. A pass under an empty catalog is a weaker result than it looks.

Worth running **before** the bump too when the user reports a live failure: a probe that fails on the old version and passes on the new one turns "we upgraded" into "we fixed it", and gives Step 8 something concrete to write.

If Step 4c flagged a `GraphSpec` change, the graph view needs eyes on it as well — `make dev` serves the DevTools UI at `http://localhost:3000` where `mthds_validate` renders the run-graph view. That one needs `WORKOS_AUTHKIT_DOMAIN` and `PIPELEX_MCP_RESOURCE_INDICATOR` set, so offer it, but do not treat it as blocking.

## Step 8 — Sync the docs to any contract you changed

If Step 4 changed a **tool's input or output contract**, this repo requires the prose to move in the same change — its `CLAUDE.md` names the rule: keep `SPEC.md`'s declared shapes, the Zod schemas in `capabilities/`, and `README.md` in sync. Grep for every field you added, renamed or removed:

```bash
grep -rn "old_field_name\|new_field_name" README.md SPEC.md CLAUDE.md
```

Three documents carry different weight, so read what each one is for rather than pattern-matching the same edit into all three:

- **`SPEC.md`** is the source of truth for the contract. Update the declared input/output blocks *and* the prose that explains them — a stale sentence about how paging or filtering works is worse than a stale type, because the type is checked and the sentence is not.
- **`README.md`** is what a user of the npm package reads. Keep it to the shape and the behavior, not the reasoning.
- **`CLAUDE.md`** is what the next agent reads. Record *why* the contract moved, not just that it did — a removed field whose absence looks like an oversight will get helpfully re-added by someone six months from now.

A removed field deserves a sentence explaining why it cannot come back cheaply. That is the note that stops the next person reintroducing it.

## Step 9 — Update this repo's CHANGELOG.md

Entries accumulate under `## [Unreleased]` — **create that heading above the newest version heading if it is not there**, since releases consume it. Use this repo's format: `## [x.y.z]`, **no `v` prefix** (the `v` belongs to branch names and git tags only).

Add a `### Changed` bullet naming both packages and the versions they moved from and to. Then write for *this repo's* reader, not the SDK's — restate what changed in terms of what pipelex-mcp does:

- If the bump fixes a live failure, say what was broken and what now works. That is the most useful sentence in the entry.
- If Step 4 migrated a seam, name the tool or capability affected, not just the SDK method.
- If anything is user-visible (a renamed env var, a changed tool contract), add it under `### Breaking Changes` in this repo's own terms.

Never copy the SDK's changelog wording verbatim.

## Step 10 — Review and commit

Summarise: each package's `old → new`, every file touched, and any unresolved 4e items. Then ask for confirmation.

On approval:

1. Stage **only** the files this bump touched — `package.json`, `package-lock.json`, `CHANGELOG.md`, plus anything Steps 4 and 8 migrated. Never `git add .` or `git add -A`. If Step 1 flagged pre-existing changes in one of these files, stage hunks carefully or ask the user how to separate them.
2. If the current branch is `dev` or `main`, create a work branch first — `chore/Bump-sdks` (this repo's guard workflow requires one of `fix/ feature/ refactor/ chore/ docs/ ci-cd/ changelog/ codex/`).
3. Commit as `chore: bump @pipelex/sdk to X.Y.Z and @pipelex/mthds-ui to A.B.C`, with a short body naming any migration applied and any live failure fixed.
4. Show the result.

Then *offer* — do not run — pushing and opening a PR. PRs target **`dev`**, never `main`; only a `release/vX.Y.Z` branch may target `main` here. Wait for explicit approval.

## Rules

- Bump both packages unless the user narrowed the scope.
- Never `git add .` or `git add -A` — stage only what this bump touched.
- Never push or open a PR without explicit approval.
- Never guess a fix for a behavior change — flag it and let the user decide.
- Never trust a sibling checkout without confirming it contains the target version's heading.
- Never treat a green `make all` as proof the bump works — the suite runs on fakes.
- Don't assume `../pipelex-sdk-js` or `../mthds-ui` exist; keep the GitHub-raw path ready.
- If any step fails or the user aborts, stop immediately.
