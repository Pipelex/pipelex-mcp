#!/usr/bin/env bash
#
# Print the version the workshop, @pipelex/mcp, carries at a commit.
#
# Every workflow that asks "which version does the workshop have here?" asks
# this script, so where that version is read from lives in one place.
#
# The workshop's version has lived in two manifests. From the workspace split
# (pipelex-mcp#89) on, it is `packages/workshop/package.json`; before it, one
# root `package.json` versioned the package, which was published from the
# root. A commit that has the first is read from it, and any other commit falls
# back to the second. That is what lets a release compare its version with a
# parent from either layout, instead of reading a missing file as "no version".
#
# Usage: track-version.sh <commit-ish>
# Prints the version, with no `v`. Exits 1 when neither manifest can be read at
# that commit or the one read carries no version.
#
set -euo pipefail

REF="${1:?usage: track-version.sh <commit-ish>}"
MANIFEST=packages/workshop/package.json

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
  echo "::error::The manifest read at $REF carries no version." >&2
  exit 1
}
echo
