#!/usr/bin/env bash
# Map a pushed commit range to the set of language ports local-ci must test.
#
# Usage: scripts/ci-affected-ports.sh <base-sha> <head-sha>
# Prints a space-separated subset of: ts java python csharp
# (empty output = docs-only push: run only the cheap shared gates).
#
# Fail-open policy: an unknown base (force-push zeros), an unresolvable
# range, or ANY path not matched by a rule selects ALL ports — this script
# may only ever shrink coverage when it is certain.
set -uo pipefail

ALL="ts java python csharp"

map_paths_to_ports() { # args: changed paths; echoes the port set
  local p sel_ts=0 sel_java=0 sel_python=0 sel_csharp=0
  for p in "$@"; do
    case "$p" in
      server/typescript/*|client/web/*)   sel_ts=1 ;;
      server/java/*)                      sel_java=1 ;;
      server/python/*)                    sel_python=1 ;;
      server/csharp/*)                    sel_csharp=1 ;;
      fixtures/*|spec/*|scripts/*|.github/*|agent-context/*)
                                          echo "$ALL"; return 0 ;;
      docs/*|*.md)                        : ;;   # gates only
      *)                                  echo "$ALL"; return 0 ;;  # fail open
    esac
  done
  local out=""
  [ "$sel_ts" -eq 1 ]     && out="$out ts"
  [ "$sel_java" -eq 1 ]   && out="$out java"
  [ "$sel_python" -eq 1 ] && out="$out python"
  [ "$sel_csharp" -eq 1 ] && out="$out csharp"
  echo "${out# }"
}

# Test seam: `MO_AFFECTED_TEST=1 source` exposes map_paths_to_ports only.
[ "${MO_AFFECTED_TEST:-0}" = "1" ] && return 0

BASE="${1:-}"; HEAD="${2:-HEAD}"
if [ -z "$BASE" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ] \
   || ! git rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1; then
  echo "$ALL"; exit 0
fi
CHANGED="$(git diff --name-only "$BASE" "$HEAD")" || { echo "$ALL"; exit 0; }
[ -z "$CHANGED" ] && { echo ""; exit 0; }
# shellcheck disable=SC2086
mapfile -t paths <<<"$CHANGED"
map_paths_to_ports "${paths[@]}"
