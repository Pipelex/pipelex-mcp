#!/usr/bin/env bash
#
# Refuse to publish a workshop version that `main` has already moved past.
#
# Called by `release.yml`'s publish job, and deliberately not called once in a
# job the others depend on. GitHub's "Re-run failed jobs" re-runs only the jobs
# that failed and the jobs below them, so a job that succeeded is not
# re-executed and its `needs.<job>.outputs` survive as the values it wrote in
# the earlier attempt. A freshness verdict reached before a newer release
# existed is exactly the answer this guard must not reuse, so the publish job
# asks again for itself. `detect` asks too, as the cheap refusal on the
# ordinary path, but its answer is not what protects the publish.
#
# `npm publish` is run without `--tag`, so it writes the `latest` dist-tag:
# publishing an older version after a newer one has shipped points
# `npx @pipelex/mcp` at the older workshop. The tag job needs no guard: it
# leaves an existing tag alone, and creating an absent tag on its own commit is
# right however `main` has moved.
#
# The workshop's version on `main` is read by `track-version.sh`. Equal is the
# ordinary case — `main`'s tip either IS this commit, or has taken only commits
# that carry no bump. Only a LOWER version is refused, and the cure is cutting
# a new release rather than retrying this one.
#
# Usage: assert-not-behind-main.sh <version>
# Prints what `main` currently carries. Exits 1, with a workflow error
# annotation, when <version> is behind it.
#
set -euo pipefail

VERSION="${1:?usage: assert-not-behind-main.sh <version>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

git fetch --depth=1 origin main
CURRENT=$(bash "$HERE/track-version.sh" FETCH_HEAD)

# `sort -V` orders release versions correctly, and a pre-release string cannot
# reach `main` to test its edges: `version-check.yml` pins each release branch
# to `release/vX.Y.Z`.
NEWEST=$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)
if [ "$NEWEST" != "$VERSION" ]; then
  echo "::error::This run ships the workshop at $VERSION but main is already at $CURRENT." \
       "Publishing it would point npm's latest dist-tag back at an older release." \
       "A release main has moved past is finished by cutting a new version, never by re-running its run."
  exit 1
fi

echo "main carries the workshop at $CURRENT, so $VERSION is not behind it."
