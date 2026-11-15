#!/usr/bin/env bash
# Map a pushed commit range to the set of language ports local-ci must test.
#
# Usage: scripts/ci-affected-ports.sh <base-sha> <head-sha>
# Prints a space-separated subset of: ts java python csharp
# (empty output = docs-only push: run only the cheap shared gates).
#
# Fail-open policy: an unknown base (force-push zeros), an unresolvable
# range, or ANY path not matched by a rule in scripts/ci-lane-map.txt selects ALL
# ports — this script may only ever shrink coverage when it is certain.
#
# NOT the whole selection. local-ci calls `ci-ports-to-run.sh`, which unions this
# answer with the ports that are not known-green on main. "What changed" alone
# cannot see a lane that failed under an EARLIER commit and was skipped by this
# one — read that file before changing selection behaviour here.
set -uo pipefail

ALL="ts java python csharp"

# The path -> lane rules are scripts/ci-lane-map.txt, read through ci-select-lanes.sh, so
# the no-mistakes gate (`ci-local.sh --affected`) and the hosted workflows share ONE table.
# This script keeps its job of answering in PORTS, the unit the workflows' `detect` jobs
# pass on, by mapping each selected lane to its port.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MO_SELECT_LIB=1 source "$HERE/ci-select-lanes.sh"

map_paths_to_ports() { # args: changed paths; echoes the port set
  select_lanes "$@"
  local lane port out=""
  for lane in $SELECTED_LANES; do
    port="$(lane_to_port "$lane")"
    case " $out " in *" $port "*) ;; *) out="$out $port" ;; esac
  done
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
