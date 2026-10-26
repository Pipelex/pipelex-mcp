#!/usr/bin/env bash
#
# Print the version the workshop, @pipelex/mcp, carries at a commit: the
# `version` of the root `package.json`, the manifest the package is published
# from.
#
# Every workflow that asks "which version does the workshop have here?" asks
# this script, so where that version is read from lives in one place.
#
# Usage: track-version.sh <commit-ish>
# Prints the version, with no `v`. Exits 1 when the manifest cannot be read at
# that commit or carries no version.
#
set -euo pipefail

REF="${1:?usage: track-version.sh <commit-ish>}"

if ! CONTENT=$(git show "$REF:package.json" 2>/dev/null); then
  echo "::error::package.json cannot be read at $REF." >&2
  exit 1
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
