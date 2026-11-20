#!/usr/bin/env bash
#
# Refuse author/committer identities that match the private denylist. metaobjects is PUBLIC and
# a commit's author and committer name and email travel with it, but the added-line scan never
# sees them. Same denylist source as .githooks/pre-commit (git config hooks.denyListPath, else
# .githooks/deny-list.local); this script names NO private term and prints none: it reports
# only that an identity matched, and whether it was the author or the committer.
#
# Usage:
#   .githooks/identity-scan.sh staged            # the identity git would record for a new commit
#   .githooks/identity-scan.sh range <rev-list args...>   # every commit selected, by SHA only
#
# Exit 0 clean (or no denylist), 1 matched.
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
# shellcheck source=leak-patterns.sh
. "$ROOT/.githooks/leak-patterns.sh"

DENY_FILE="$(git config --get hooks.denyListPath 2>/dev/null || true)"
[ -z "$DENY_FILE" ] && DENY_FILE="$ROOT/.githooks/deny-list.local"
[ -f "$DENY_FILE" ] || exit 0
PATTERNS=$(grep -vE '^[[:space:]]*(#|$)' "$DENY_FILE" | paste -sd'|' -)
[ -n "$PATTERNS" ] || exit 0

# 0 when the identity text matches the denylist after the maintainer's allowed address is removed.
matches() {
  printf '%s\n' "$1" | sed -E "s/$LEAK_ALLOW//Ig" | grep -qEi "$PATTERNS"
}

mode="${1:-}"
[ $# -gt 0 ] && shift
bad=0
case "$mode" in
  staged)
    for role in AUTHOR COMMITTER; do
      ident=$(git var "GIT_${role}_IDENT" 2>/dev/null) || continue
      if matches "${ident% * *}"; then   # drop the trailing "<epoch> <tz>"
        echo "  commit blocked — the $(echo "$role" | tr A-Z a-z) identity git would record matches the private denylist (metaobjects is PUBLIC)." >&2
        bad=1
      fi
    done
    [ "$bad" -eq 1 ] && echo "  Set a public identity for this repo (git config user.name / user.email)." >&2
    ;;
  range)
    shas=""
    while IFS=$'\t' read -r sha an ae cn ce; do
      if matches "$an $ae $cn $ce"; then shas="$shas $sha"; fi
    done < <(git log --format='%H%x09%an%x09%ae%x09%cn%x09%ce' "$@" 2>/dev/null)
    if [ -n "$shas" ]; then
      echo "" >&2
      echo "  push blocked — author or committer identity matches the private denylist on:" >&2
      for s in $shas; do echo "      $s" >&2; done
      echo "  Rewrite those commits with a public identity (metaobjects is PUBLIC)." >&2
      bad=1
    fi
    ;;
  *) echo "usage: identity-scan.sh staged | range <rev-list args>" >&2; exit 2 ;;
esac
exit "$bad"
