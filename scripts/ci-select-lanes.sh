#!/usr/bin/env bash
# Select the ci-local lanes a change must run, from scripts/ci-lane-map.txt.
#
# Two callers share this file and the map, so the gate and the hosted workflows cannot
# disagree about what a path affects:
#   scripts/ci-local.sh --affected   sources it and runs the selected lanes
#   scripts/ci-affected-ports.sh     sources it and prints the ports those lanes belong to
#
# Run directly it explains a selection, which is how a reviewer sees what a change skips:
#   scripts/ci-select-lanes.sh [<base-ref>]   # the diff against the merge base with <base-ref>
#   git diff --name-only main | scripts/ci-select-lanes.sh -   # paths on stdin
# It prints the rule each path matched and a final `lanes:` line. With no base it uses
# origin/main.
#
# Fail-open policy, the one rule that matters: this may only shrink what runs when it is
# certain. An unreadable map, an unknown lane name, an unresolvable base, a git failure and
# any path no rule claims all select every lane. "Unknown" never means "skip".
set -uo pipefail

CI_SELECT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CI_LANE_MAP="${MO_CI_LANE_MAP:-$CI_SELECT_HERE/ci-lane-map.txt}"

# The lanes a change can select, in the order they run. The map's `ALL` means exactly this.
CI_SELECTABLE_LANES="ts-fast ts-unit java-slow python csharp"

# The port each lane belongs to, for callers that think in ports (the hosted workflows).
lane_to_port() {
  case "$1" in
    ts-fast|ts-unit) echo ts ;;
    java-slow)       echo java ;;
    python)          echo python ;;
    csharp)          echo csharp ;;
  esac
}

_trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; echo "${s%"${s##*[![:space:]]}"}"; }

# Prints one `<glob>\t<lanes>\t<why>` line per rule, comments and blanks dropped.
# Returns 1 when the map cannot be read.
lane_map_rules() {
  [ -r "$CI_LANE_MAP" ] || return 1
  local line pat lanes why
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*|[[:space:]]*'#'*) continue ;; esac
    [ -n "$(_trim "$line")" ] || continue
    IFS='|' read -r pat lanes why <<<"$line"
    printf '%s\t%s\t%s\n' "$(_trim "$pat")" "$(_trim "$lanes")" "$(_trim "${why:-}")"
  done < "$CI_LANE_MAP"
}

# Prints a problem per line when the map is malformed. Empty output = valid.
lane_map_problems() {
  local rules pat lanes why l last=""
  rules="$(lane_map_rules)" || { echo "cannot read $CI_LANE_MAP"; return 0; }
  [ -n "$rules" ] || { echo "$CI_LANE_MAP has no rules"; return 0; }
  while IFS=$'\t' read -r pat lanes why; do
    [ -n "$pat" ]   || echo "a rule has an empty glob"
    [ -n "$lanes" ] || echo "rule '$pat' names no lanes (write NONE for none)"
    [ -n "$why" ]   || echo "rule '$pat' has no reason"
    for l in $lanes; do
      case " ALL NONE $CI_SELECTABLE_LANES " in
        *" $l "*) ;;
        *) echo "rule '$pat' names '$l', which is not a selectable lane" ;;
      esac
    done
    last="$pat"
  done <<<"$rules"
  [ "$last" = "*" ] || echo "the last rule must be '*' (unmapped -> ALL), found '$last'"
}

# select_lanes <path>...
# Sets SELECTED_LANES (space-separated, run order; empty = no test lane) and
# SELECTION_REPORT (one line per rule that matched, naming its paths).
select_lanes() {
  SELECTED_LANES=""; SELECTION_REPORT=""
  local want=" " rules l

  if [ "$#" -eq 0 ]; then
    SELECTION_REPORT="  no changed paths: nothing to run"
    return 0
  fi

  if ! rules="$(lane_map_rules)" || [ -n "$(lane_map_problems)" ]; then
    SELECTED_LANES="$CI_SELECTABLE_LANES"
    SELECTION_REPORT="  the lane map is unreadable or invalid, so every lane runs: $(lane_map_problems | paste -sd';' -)"
    return 0
  fi

  local -a pats=() lanes_of=() why_of=()
  local pat lanes why
  while IFS=$'\t' read -r pat lanes why; do
    pats+=("$pat"); lanes_of+=("$lanes"); why_of+=("$why")
  done <<<"$rules"

  local -A paths_of=() count_of=()
  local p i hit
  for p in "$@"; do
    hit=-1
    for i in "${!pats[@]}"; do
      # shellcheck disable=SC2254 # the rule's glob is meant to be a pattern, not a literal
      case "$p" in ${pats[$i]}) hit="$i"; break ;; esac
    done
    if [ "$hit" -lt 0 ]; then   # unreachable while the last rule is '*', kept as the backstop
      want=" $CI_SELECTABLE_LANES "
      SELECTION_REPORT+="  ALL <- (no rule): $p"$'\n'
      continue
    fi
    count_of[$hit]=$(( ${count_of[$hit]:-0} + 1 ))
    [ "${count_of[$hit]}" -le 4 ] && paths_of[$hit]+="${paths_of[$hit]:+, }$p"
    case " ${lanes_of[$hit]} " in
      *" ALL "*)  want=" $CI_SELECTABLE_LANES " ;;
      *" NONE "*) ;;
      *)          want+="${lanes_of[$hit]} " ;;
    esac
  done

  for i in "${!pats[@]}"; do
    [ -n "${count_of[$i]:-}" ] || continue
    local more=""; [ "${count_of[$i]}" -gt 4 ] && more=", and $(( count_of[$i] - 4 )) more"
    SELECTION_REPORT+="  ${lanes_of[$i]} <- ${pats[$i]} (${why_of[$i]}): ${paths_of[$i]}$more"$'\n'
  done
  SELECTION_REPORT="${SELECTION_REPORT%$'\n'}"

  for l in $CI_SELECTABLE_LANES; do
    case "$want" in *" $l "*) SELECTED_LANES+="${SELECTED_LANES:+ }$l" ;; esac
  done
}

# changed_paths <merge-base>   — the paths this change touches, one per line.
# Committed work since the merge base, plus uncommitted and untracked files, so a run in a
# dirty tree selects for what it will actually test. --no-renames lists a rename's old path
# too: moving a file OUT of a port affects that port as much as moving one in.
changed_paths() {
  local mb="$1" tracked untracked
  tracked="$(git diff --no-renames --name-only "$mb")" || return 1
  untracked="$(git ls-files --others --exclude-standard)" || return 1
  printf '%s\n%s\n' "$tracked" "$untracked" | sed '/^$/d' | sort -u
}

# Test seam: `MO_SELECT_LIB=1 source` exposes the functions and does nothing else.
[ "${MO_SELECT_LIB:-0}" = "1" ] && return 0

# ── CLI: explain a selection ─────────────────────────────────────────────────
BASE_ARG="${1:-origin/main}"
if [ "$BASE_ARG" = "-" ]; then
  _list="$(cat)"
else
  _mb="$(git merge-base HEAD "$BASE_ARG" 2>/dev/null)" || { echo "no merge base with '$BASE_ARG': every lane runs" >&2; echo "lanes: $CI_SELECTABLE_LANES"; exit 0; }
  _list="$(changed_paths "$_mb")" || { echo "git could not list the change: every lane runs" >&2; echo "lanes: $CI_SELECTABLE_LANES"; exit 0; }
fi
mapfile -t _paths < <(printf '%s\n' "$_list" | sed '/^$/d')
select_lanes "${_paths[@]}"
echo "$SELECTION_REPORT"
echo "lanes: $SELECTED_LANES"
