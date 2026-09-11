#!/usr/bin/env bash
#
# Guard: server/python/uv.lock's own `metaobjects` entry must carry the SAME version
# as server/python/pyproject.toml.
#
# Why this exists: nothing in this repo runs `uv` with `--locked` or `--frozen` — every
# lane uses plain `uv run`, which silently REWRITES the lockfile in place when it
# disagrees with the project. So a release that bumps pyproject.toml and forgets the
# lock leaves a committed file stating the previous version, every lane stays green,
# and the drift is invisible until someone happens to run the suite and notices a dirty
# tree. That is not hypothetical and it is not once: the 1.0.0 cut needed a dedicated
# follow-up commit (`chore(release): uv.lock resolves metaobjects at 1.0.0`), and the
# 1.0.1 cut skipped the step again — pyproject at 1.0.1, lock still saying 1.0.0.
#
# It matters beyond tidiness because the lock is what a `--locked` install would
# resolve: the moment any consumer or CI adds that flag, a stale lock fails the install
# rather than quietly self-healing.
#
# Toolchain-free on purpose (grep + sed, no uv), so it runs in the `gates` lane beside
# the pom and bun version-parity guards rather than needing the python lane.
#
# Usage:  scripts/check-uv-lock-version.sh      # exit 1 + diagnostic on drift
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYPROJECT="$ROOT/server/python/pyproject.toml"
LOCK="$ROOT/server/python/uv.lock"

for f in "$PYPROJECT" "$LOCK"; do
  [ -f "$f" ] || { echo "check-uv-lock-version: missing $f" >&2; exit 1; }
done

# `version = "..."` under [project]; the first such line in the file is the project's.
project_version="$(grep -m1 -oE '^version[[:space:]]*=[[:space:]]*"[^"]+"' "$PYPROJECT" \
                   | sed -E 's/.*"([^"]+)".*/\1/')"
if [ -z "$project_version" ]; then
  echo "check-uv-lock-version: could not read the version from $PYPROJECT" >&2
  exit 1
fi

# The lock's own entry for this project — `name = "metaobjects"` followed by its
# version. Anchored to the package block so a DEPENDENCY that happens to be named
# similarly cannot be read instead.
lock_version="$(awk '
  /^name = "metaobjects"$/ { inpkg = 1; next }
  inpkg && /^version = / { gsub(/^version = "|"$/, ""); print; exit }
  inpkg && /^\[\[package\]\]$/ { inpkg = 0 }
' "$LOCK")"
if [ -z "$lock_version" ]; then
  echo "check-uv-lock-version: could not find the metaobjects package entry in $LOCK" >&2
  exit 1
fi

if [ "$project_version" != "$lock_version" ]; then
  cat >&2 <<MSG
check-uv-lock-version: server/python/uv.lock is STALE.

  pyproject.toml : $project_version
  uv.lock        : $lock_version

The lock still resolves the previous version. Nothing runs uv with --locked, so every
lane will keep passing while the committed lock says something untrue — and a plain
\`uv run\` rewrites it, so whoever next runs the suite gets a surprise dirty tree.

Fix:  (cd server/python && uv lock)   then commit server/python/uv.lock
MSG
  exit 1
fi

echo "check-uv-lock-version: uv.lock agrees with pyproject.toml ($project_version)"
