#!/usr/bin/env bash
# Downloads the evidence engine source (a private module) at the commit pinned in attendd/ENGINE_SHA into .engine-src/
# (git-ignored, never committed: this tree is public). attendd/go.mod points its replace directive there.
#   GITLAB_TOKEN  read_api + read_repository token for the engine project (omit where a proxy injects the credential)
#   ENGINE_SHA    override the pinned commit
# Usage: scripts/fetch-engine.sh   (from anywhere; paths are relative to the knowbot/ root)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHA="${ENGINE_SHA:-$(tr -d '[:space:]' < "$ROOT/attendd/ENGINE_SHA")}"
PROJECT="recoursellm-group%2Fknowdrive-resolve.engine"
URL="https://gitlab.com/api/v4/projects/${PROJECT}/repository/archive.tar.gz?sha=${SHA}"
DEST="$ROOT/.engine-src"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
AUTH=()
if [ -n "${GITLAB_TOKEN:-}" ]; then AUTH=(-H "Authorization: Bearer ${GITLAB_TOKEN}"); fi
curl -fsSL --retry 3 ${AUTH[@]+"${AUTH[@]}"} -o "$TMP/engine.tgz" "$URL"
mkdir -p "$TMP/x"
tar -xzf "$TMP/engine.tgz" -C "$TMP/x" --strip-components=1
test -f "$TMP/x/go.mod" || { echo "fetch-engine: archive has no go.mod" >&2; exit 1; }
rm -rf "$DEST"
mv "$TMP/x" "$DEST"
echo "$SHA" > "$DEST/.sha"
echo "fetch-engine: engine ${SHA:0:12} in .engine-src ($(head -1 "$DEST/go.mod"))"
