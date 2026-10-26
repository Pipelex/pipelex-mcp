#!/usr/bin/env bash
#
# Decide whether a commit is a release of the workshop, @pipelex/mcp: whether
# it brings a version its first parent did not carry.
#
# Both routes to the registry ask this script, so what counts as a release
# commit lives in one place: `release.yml`'s `detect` job, for the commit a push
# or a dispatch names, and the Makefile's `check-workshop-released`, for the
# break-glass `make publish`.
#
# A commit with a parent is a release exactly when it RAISES the version its
# first parent carries. The rise must be strict, so a revert that lowers the
# version, whose changelog heading is still there, never reads as a release.
#
# A commit with no parent is a release of the version it carries. The
# repository's root commit is such a commit: it holds the tree of a release cut
# before the repository existed, so its own release run finds that version
# already on npm, skips the publish and tags the root commit.
#
# Whether a commit has a parent is read from the commit object, never from what
# the checkout holds. A shallow clone shows its deepest commit with no parent,
# and reading that as a root commit would make a release of any push checked
# out one commit too shallow. A commit whose first parent the checkout does not
# hold therefore gets no verdict at all.
#
# Usage: release-verdict.sh <commit-ish>
# Prints three lines in the `key=value` form `$GITHUB_OUTPUT` takes:
#   version=X.Y.Z          the version the commit carries
#   parent_version=X.Y.Z   its first parent's, empty for a commit with no parent
#   release=true|false
# Exits 1, with a workflow error annotation, when no verdict can be reached: the
# commit cannot be resolved, a version cannot be read, or the first parent is
# not in the checkout.
#
set -euo pipefail

REF="${1:?usage: release-verdict.sh <commit-ish>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! SHA=$(git rev-parse --verify --quiet "$REF^{commit}"); then
  echo "::error::$REF names no commit in this checkout." >&2
  exit 1
fi
VERSION=$(bash "$HERE/track-version.sh" "$SHA")

# The commit object's header, everything before its first empty line, holds one
# `parent` line per parent whatever the checkout's depth.
OBJECT=$(git cat-file commit "$SHA")
HEADER=${OBJECT%%$'\n\n'*}
PARENTS=$(printf '%s\n' "$HEADER" | grep -c '^parent ' || true)

if [ "$PARENTS" -eq 0 ]; then
  printf 'version=%s\nparent_version=\nrelease=true\n' "$VERSION"
  exit 0
fi

if ! PARENT=$(git rev-parse --verify --quiet "$SHA^1"); then
  echo "::error::$SHA has a parent this checkout does not hold, so whether it raises the workshop's version cannot be read. Fetch at least one commit deeper." >&2
  exit 1
fi
PARENT_VERSION=$(bash "$HERE/track-version.sh" "$PARENT")

# `sort -V` orders release versions correctly, and a pre-release string cannot
# reach `main` to test its edges: `version-check.yml` pins each release branch
# to `release/vX.Y.Z`.
HIGHEST=$(printf '%s\n%s\n' "$PARENT_VERSION" "$VERSION" | sort -V | tail -1)
RELEASE=false
if [ "$VERSION" != "$PARENT_VERSION" ] && [ "$HIGHEST" = "$VERSION" ]; then
  RELEASE=true
fi

printf 'version=%s\nparent_version=%s\nrelease=%s\n' "$VERSION" "$PARENT_VERSION" "$RELEASE"
