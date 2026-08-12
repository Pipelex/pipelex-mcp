---
name: release
description: >
  Automates the pipelex-mcp release workflow: bumps the version in package.json,
  finalizes the CHANGELOG.md Unreleased section, regenerates package-lock.json,
  runs quality checks and tests, creates a release/vX.Y.Z branch, commits,
  pushes, and opens a PR to main. Use when the user says "release", "cut a
  release", "bump version", "prepare a release", "make a release", "ship it",
  "create release branch", or any variation of shipping a new version of
  pipelex-mcp. The user can optionally provide changelog content inline when
  invoking the skill (e.g. "/release Added a run-graph fullscreen toggle"),
  which is merged into the changelog entry for this version.
---

# pipelex-mcp Release Workflow

This skill handles the full release cycle for both distributions of
`pipelex-mcp`: the public `@pipelex/mcp` npm package (local workshop) and the
Skybridge server deployed through Alpic (hosted console). A "release" means:
bump their one shared version, finalize the changelog, get it onto `main`
through a `release/vX.Y.Z` branch, then publish and deploy the same `main`
commit before tagging it.

The npm package and Alpic deployment are released in lockstep. They always use
the same `package.json` version and the same source commit, so "what is live?"
has one answer. Publishing is deliberately not transactional: if one finishing
step fails transiently after the other succeeds, retry it at the same version
and commit. If a permanent code or configuration defect makes that commit
unshippable, deprecate an already-published npm version, fix forward, and cut a
new version from the corrective commit for both surfaces.

Every step is interactive — confirm with the user before mutating files, and
never push or open a PR without explicit approval.

## Branch flow (read this first — it differs from the sibling TS repos)

pipelex-mcp uses a three-tier flow enforced by `.github/workflows/guard-branches.yml`:

    work-branch (fix/ feature/ refactor/ chore/ docs/ ci-cd/ changelog/ codex/)
      → dev
      → release/vX.Y.Z
      → main

The CI gate **only lets a `release/vX.Y.Z` branch merge into `main`** — `dev`
can no longer target `main` directly. That is exactly why this skill exists: the
release branch is the carrier that promotes everything on `dev` plus the
version-bump commit onto `main`.

Three CI checks will validate the PR to `main`, so getting them right here is
what makes the release mergeable:

- **`guard-branches.yml`** — the head branch must match `release/vX.Y.Z` (same repo).
- **`version-check.yml`** — `package.json` version must equal the `X.Y.Z` in the
  branch name **and** be strictly greater than `main`'s current version.
- **`changelog-check.yml`** — `CHANGELOG.md` must contain a `## [X.Y.Z]` entry
  (note: **no `v` prefix** in the heading — see the version-string rules below).

## The two version-string forms (don't mix them up)

- **`v` prefix** — branch name (`release/v0.2.0`), git tag (`v0.2.0`), PR title (`Release v0.2.0`).
- **no prefix** — `package.json` `"version"` (`0.2.0`) and the changelog heading
  (`## [0.2.0] - YYYY-MM-DD`).

This split is a real pipelex-mcp convention (see its `CLAUDE.md`): the changelog
heading is `## [x.y.z]`, the tag is `vX.Y.Z`. The sibling repos put `v` in their
changelog headings; **this repo does not** — match the existing entries in
`CHANGELOG.md`, don't copy the siblings.

## Files touched

- **`package.json`** — the `"version"` field (line 3), no `v` prefix.
- **`CHANGELOG.md`** — promote `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`.
- **`package-lock.json`** — regenerated so its root `version` matches.

## Workflow

### 1. Pre-flight checks

- Read the current version from `package.json`.
- Read `CHANGELOG.md` to see what is staged under `## [Unreleased]` (if anything).
- Run `git status --short` and `git log origin/main..HEAD --oneline` to assess
  the working tree:
  - If there are **uncommitted changes**, warn the user and ask whether to commit
    them as part of the release, stash them, or abort. Never silently sweep them in.
  - If there are **unpushed commits**, list them — they'll ride along on the
    release branch.
- Confirm the starting point. The release branch should be cut from an
  up-to-date **`dev`** (that's the branch whose accumulated work you're
  promoting). If the user is somewhere else, surface it and let them decide.

### 2. Determine the bump type

Unless the user already said which, ask with `AskUserQuestion` whether this is a
**patch**, **minor**, or **major** bump. Show the concrete resulting version for
each option (current `X.Y.Z` → patch `X.Y.Z+1` / minor `X.Y+1.0` / major
`X+1.0.0`) so the choice isn't abstract. Store the result as `TARGET_VERSION`
(no `v`, e.g. `0.2.0`).

### 3. Run quality checks

Run `make check && make test` (build + lint + format:check + typecheck, then the
Vitest suite). This is the gate — if it fails, stop and report the errors so the
user can fix them before retrying. Do not proceed past this step on failure, and
do not "skip checks" to push a release through.

### 4. Create / switch to the release branch

The branch **must** be named `release/v{TARGET_VERSION}` — the CI gate keys off
this exact shape (`release/v` + semver). All file edits below happen on it.

- If already on `release/v{TARGET_VERSION}`, stay.
- If on `dev` (the normal case), `main`, or another branch: confirm, then create
  and switch with `git switch -c release/v{TARGET_VERSION}`.
- If on a `release/` branch for a **different** version: warn and ask how to proceed.

### 5. Finalize the changelog

Promote the in-progress section into a concrete version entry.

1. If a `## [Unreleased]` section exists, **rename it** to
   `## [{TARGET_VERSION}] - {TODAY}` (today in `YYYY-MM-DD`). Its content becomes
   this version's content. Remove the now-empty `[Unreleased]` marker — **never
   leave or re-add an `[Unreleased]` heading**; the changelog holds only concrete
   versions (this repo's `CLAUDE.md` rule).
2. If there's no `[Unreleased]` section, insert the new heading directly under
   the `# Changelog` title, above the previous version.
3. If the user passed changelog content inline (e.g. `/release Added a fullscreen
   toggle`), **merge** it with any `[Unreleased]` content — don't discard either.
   Sort items under the right `###` subsections (`Added`, `Changed`, `Fixed`,
   `Removed`, `Breaking Changes`, `Notes`), inferring the heading from the wording.
4. If there's **no** changelog content from either source, derive a draft from
   `git log origin/main..HEAD --oneline`, propose it, and let the user accept or
   edit it. Don't invent a release with an empty body.

Result shape (note: no `v` in the heading):

```markdown
# Changelog

## [0.2.0] - 2026-07-01

### Added

- ...

## [0.1.0] - 2026-06-29
...
```

### 6. Bump the version in package.json

Edit the `"version"` line in `package.json` to `"{TARGET_VERSION}"` (no `v`).
Only touch that field. Show the diff.

### 7. Regenerate the lockfile

Run `npm install --package-lock-only`. This rewrites `package-lock.json`'s root
`version` to match `package.json` without touching `node_modules`. If it fails,
stop and report the error — a stale lockfile version is exactly what reviewers
and the lockfile checks catch.

### 8. Review, commit, push

Present a summary: target `v{TARGET_VERSION}`, branch `release/v{TARGET_VERSION}`,
the three files, and the changelog entry preview. On confirmation:

1. Stage **only** `package.json`, `package-lock.json`, and `CHANGELOG.md` — never
   `git add .` or `git add -A`. (If the user opted in step 1 to fold in other
   work, stage those specific paths too, explicitly.)
2. Commit: `Release v{TARGET_VERSION}`.
3. With explicit approval, push: `git push -u origin release/v{TARGET_VERSION}`.

### 9. Open the PR to main

With explicit approval, open a PR **targeting `main`** (this is the one branch
allowed to, by the gate):

- **Title:** `Release v{TARGET_VERSION}`
- **Body:**

```markdown
## Release v{TARGET_VERSION}

Bumps version from `{OLD_VERSION}` to `{TARGET_VERSION}`.

### Changelog

<paste this version's changelog entry>
```

Report the PR URL back.

### 10. After the merge: dispatch the release workflow (the user runs it)

Publishing and deploying are **not** local steps any more, and merging to `main`
does not ship anything on its own. Both surfaces go out through
`.github/workflows/release.yml`, which is `workflow_dispatch`-only — a human
fires it from the Actions tab. Merging is therefore safe; shipping is a separate,
deliberate act.

Once the PR merges to `main`, tell the user to run it:

1. **Dispatch:** GitHub → Actions → **Release (publish + deploy)** → *Run
   workflow*, with `version` = `{TARGET_VERSION}` (no `v`) and `target` = `both`.
   The `gh` equivalent, if they prefer the terminal:
   `gh workflow run release.yml -f version={TARGET_VERSION} -f target=both`
2. **What it does, in order:** checks out `main`; fails unless `main`'s
   `package.json` is exactly `{TARGET_VERSION}` (the guard against dispatching
   before the merge landed) and `CHANGELOG.md` has a `## [{TARGET_VERSION}]`
   heading; re-runs `make all` on the merge commit; publishes `@pipelex/mcp`;
   deploys the console to Alpic; pushes the `v{TARGET_VERSION}` tag.
3. **On a partial failure, re-dispatch the failed leg only** — `target` = `npm`
   or `alpic`, same `version`. Re-running is safe: an already-published version
   is skipped, and the tag step leaves an existing tag alone. Never bump the
   version to work around a transient failure.
4. **Sync `dev`:** bring the release commit back so `dev` and `main` don't
   diverge (merge `main` into `dev`, or fast-forward `dev`).

`make publish` / `make deploy` still exist as local escape hatches (with their
`check-release-ready` / `check-no-local-deps` guards) for the case where CI
itself is unavailable. Prefer the workflow — it ships from a verified `main`
rather than from whatever is in someone's working tree.

## Rules

- **Confirm the bump type before changing anything**, and keep every mutation on
  the `release/v{TARGET_VERSION}` branch.
- **`v` prefix only on branch name, tag, and PR title** — never in `package.json`
  or the changelog heading.
- **Stage explicitly** — only `package.json`, `package-lock.json`, `CHANGELOG.md`
  (plus any paths the user explicitly chose). Never `git add .`/`-A`.
- **Never push or open a PR without explicit user approval.**
- `make check && make test` is a hard gate — help fix failures rather than
  skipping them.
- Never publish npm and deploy Alpic from different commits or versions.
  Retry transient failures at the same release commit. If that commit has a
  permanent defect after npm publication, deprecate the bad npm version and
  fix forward with a new release version for both surfaces.
- Use today's date (`YYYY-MM-DD`) for the changelog entry.
- If any step fails or the user wants to abort, stop immediately.
