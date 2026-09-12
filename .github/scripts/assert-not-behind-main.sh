#!/usr/bin/env bash
#
# Refuse to ship a version `main` has already moved past.
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
# Both surfaces need it, for different reasons. `npm publish` is run without
# `--tag`, so it writes the `latest` dist-tag: publishing an older version
# after a newer one has shipped points `npx @pipelex/mcp` at the older
# workshop. The Alpic deploy has no ordering property of its own at all — it
# ships whatever tree it is handed, and it is the hard one to undo. The `tag`
# job needs no guard: it leaves an existing tag alone, and creating an absent
# tag on its own commit is right however `main` has moved.
#
# Equal is the ordinary case — `main`'s tip either IS this commit, or has taken
# only commits that carry no bump. Only a LOWER version is refused, and the
# cure is cutting a new release rather than retrying this one.
#
# Usage: assert-not-behind-main.sh <version>
# Prints what `main` currently carries. Exits 1, with a workflow error
# annotation, when <version> is behind it.
#
set -euo pipefail

VERSION="${1:?usage: assert-not-behind-main.sh <version>}"

git fetch --depth=1 origin main
CURRENT=$(git show FETCH_HEAD:package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")

# `sort -V` orders release versions correctly, and a pre-release string cannot
# reach `main` to test its edges: `version-check.yml` pins the release branch
# to `release/vX.Y.Z`.
NEWEST=$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)
if [ "$NEWEST" != "$VERSION" ]; then
  echo "::error::This run ships $VERSION but main is already at $CURRENT." \
       "Publishing it would point npm's latest dist-tag back at an older release," \
       "and deploying it would roll the Production console back to an older tree." \
       "A release main has moved past is finished by cutting a new version, never by re-running its run."
  exit 1
fi

echo "main is at $CURRENT, so $VERSION is not behind it."
