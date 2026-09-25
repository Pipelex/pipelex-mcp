#!/usr/bin/env bash
#
# Refuse to ship a version of one release track that `main` has already moved
# past.
#
# Called by every `release.yml` job that ships something, and deliberately not
# called once in a job the others depend on. GitHub's "Re-run failed jobs"
# re-runs only the jobs that failed and the jobs below them, so a job that
# succeeded is not re-executed and its `needs.<job>.outputs` survive as the
# values it wrote in the earlier attempt. A freshness verdict reached before a
# newer release existed is exactly the answer this guard must not reuse, so
# each shipping leg asks again for itself. `detect` asks too, as the cheap
# refusal on the ordinary path, but its answer is not what protects the legs.
#
# Both tracks need it, for different reasons. The workshop's `npm publish` is
# run without `--tag`, so it writes the `latest` dist-tag: publishing an older
# version after a newer one has shipped points `npx @pipelex/mcp` at the older
# workshop. The console's Alpic deploy has no ordering property of its own at
# all — it ships whatever tree it is handed, and it is the hard one to undo. The
# tag jobs need no guard: they leave an existing tag alone, and creating an
# absent tag on its own commit is right however `main` has moved.
#
# The comparison is within one track: the workshop's version against the
# workshop's version on `main`, the console's against the console's, each read
# by `track-version.sh`. Equal is the ordinary case — `main`'s tip either IS
# this commit, or has taken only commits that carry no bump of this track. Only
# a LOWER version is refused, and the cure is cutting a new release rather than
# retrying this one.
#
# Usage: assert-not-behind-main.sh <workshop|console> <version>
# Prints what `main` currently carries for that track. Exits 1, with a workflow
# error annotation, when <version> is behind it.
#
set -euo pipefail

TRACK="${1:?usage: assert-not-behind-main.sh <workshop|console> <version>}"
VERSION="${2:?usage: assert-not-behind-main.sh <workshop|console> <version>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

git fetch --depth=1 origin main
CURRENT=$(bash "$HERE/track-version.sh" "$TRACK" FETCH_HEAD)

# `sort -V` orders release versions correctly, and a pre-release string cannot
# reach `main` to test its edges: `version-check.yml` pins each release branch
# to `release/vX.Y.Z` or `release/console-vX.Y.Z`.
NEWEST=$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)
if [ "$NEWEST" != "$VERSION" ]; then
  case "$TRACK" in
    workshop) CONSEQUENCE="Publishing it would point npm's latest dist-tag back at an older release." ;;
    console) CONSEQUENCE="Deploying it would roll the Production console back to an older tree." ;;
  esac
  echo "::error::This run ships the $TRACK at $VERSION but main is already at $CURRENT." \
       "$CONSEQUENCE" \
       "A release main has moved past is finished by cutting a new version, never by re-running its run."
  exit 1
fi

echo "main carries the $TRACK at $CURRENT, so $VERSION is not behind it."
