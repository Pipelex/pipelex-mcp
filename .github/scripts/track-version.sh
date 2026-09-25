#!/usr/bin/env bash
#
# Print the version one release track carries at a commit.
#
# This repository ships two servers on two release tracks, each versioned by
# its own workspace member's `package.json`:
#
#   workshop  packages/workshop/package.json   @pipelex/mcp on npm, tags vX.Y.Z
#   console   packages/console/package.json    the hosted console on Alpic, tags console-vX.Y.Z
#
# Every workflow that asks "which version does this track have here?" asks this
# script, so the mapping from a track to its manifest lives in one place.
#
# A commit from before the workspace split has no member manifests: one root
# `package.json` versioned both servers, which shipped together. Its version is
# therefore the version of both tracks at that commit, and this script falls
# back to it. That is what lets the first release after the split compare its
# version with its parent's, where the parent is the last release made the old
# way, instead of reading a missing file as "no version" and shipping both
# servers at once.
#
# Usage: track-version.sh <workshop|console> <commit-ish>
# Prints the version, with no `v`. Exits 1 on an unknown track or when neither
# manifest can be read at that commit.
#
set -euo pipefail

TRACK="${1:?usage: track-version.sh <workshop|console> <commit-ish>}"
REF="${2:?usage: track-version.sh <workshop|console> <commit-ish>}"

case "$TRACK" in
  workshop) MANIFEST=packages/workshop/package.json ;;
  console) MANIFEST=packages/console/package.json ;;
  *)
    echo "::error::Unknown release track '$TRACK': expected workshop or console." >&2
    exit 1
    ;;
esac

if ! CONTENT=$(git show "$REF:$MANIFEST" 2>/dev/null); then
  if ! CONTENT=$(git show "$REF:package.json" 2>/dev/null); then
    echo "::error::Neither $MANIFEST nor package.json can be read at $REF." >&2
    exit 1
  fi
fi

printf '%s' "$CONTENT" | node -e '
  const manifest = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (typeof manifest.version !== "string" || manifest.version === "") process.exit(1);
  process.stdout.write(manifest.version);
' || {
  echo "::error::The manifest $TRACK reads at $REF carries no version." >&2
  exit 1
}
echo
