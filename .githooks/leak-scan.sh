#!/usr/bin/env bash
#
# Reusable public-repo leak scanner. metaobjects is PUBLIC — block added lines that
# leak absolute local paths or private/other-project names.
#
# This lives in .githooks/ (which the scanners themselves skip) so the pattern
# literals here never self-trip the guard. The committed patterns name NO private
# project; private names come only from an untracked denylist when present
# (.githooks/deny-list.local or `git config hooks.denyListPath`) — same source as
# .githooks/pre-commit.
#
# Usage:
#   .githooks/leak-scan.sh <base-ref>   # scan added lines in <base-ref>..HEAD (CI / PR)
#   .githooks/leak-scan.sh              # scan staged changes (local)
#
set -uo pipefail

# Generic, non-sensitive structural patterns (safe to commit — name no project):
PATTERNS='/home/[A-Za-z0-9._-]+/|~/Development'

# Legitimate matches to ignore (the published npm author email).
ALLOW='doug@dougmealing\.com'

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
DENY_FILE="$(git config --get hooks.denyListPath 2>/dev/null || true)"
[ -z "$DENY_FILE" ] && DENY_FILE="$ROOT/.githooks/deny-list.local"
if [ -f "$DENY_FILE" ]; then
  extra=$(grep -vE '^[[:space:]]*(#|$)' "$DENY_FILE" | paste -sd'|' -)
  [ -n "$extra" ] && PATTERNS="$PATTERNS|$extra"
fi

if [ -n "${1:-}" ]; then
  DIFF=$(git diff "$1...HEAD" -U0 --no-color --diff-filter=ACM 2>/dev/null)
else
  DIFF=$(git diff --cached --diff-filter=ACM -U0 --no-color 2>/dev/null)
fi

# Scan only newly-ADDED lines, attributed to their file; skip the hooks dir itself.
hits=$(printf '%s\n' "$DIFF" | awk '
  /^\+\+\+ /          { f=$2; sub(/^b\//,"",f); next }
  /^\+/ && !/^\+\+\+/ { if (f !~ /^\.githooks\//) print f "\t" substr($0,2) }
' | grep -Ei "$PATTERNS" | grep -vEi "$ALLOW" || true)

if [ -n "$hits" ]; then
  echo "" >&2
  echo "leak-scan: possible private/other-project or local-path leak in added lines (metaobjects is PUBLIC):" >&2
  printf '%s\n' "$hits" | sed 's/^/    /' >&2
  echo "" >&2
  echo "Genericize the references (e.g. 'a downstream consumer', '<repo-root>') — see CLAUDE.md -> Public repository hygiene." >&2
  exit 1
fi

echo "leak-scan: clean"
exit 0
