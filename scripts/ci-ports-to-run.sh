#!/usr/bin/env bash
# Select the ports local-ci must run for THIS push.
#
# `ci-affected-ports.sh` answers "what did this push change?" — which is the wrong
# question to select lanes on by itself, and the gap is not hypothetical. Across the
# 1.0.1 cut five lanes failed on c59bb31c0 and were never re-run: the next commit was
# docs-only, so its run skipped every code lane and reported GREEN, and the red sat
# unverified under a green tip until the full matrix was dispatched by hand.
#
# The question that closes it is "what is not currently known-green on main?", and the
# answer is a union:
#
#     affected(this push)  ∪  ports whose newest verdict on main is not success
#
# Re-running is deliberately chosen over merely reporting. A report that says "java was
# red three commits ago" leaves the red UNVERIFIED, which is the defect itself; running
# the lane resolves it either way. So a docs push landing after a red java lane runs
# java, and it either recovers or stays red loudly.
#
# This can only ever WIDEN the affected set — the same direction ci-affected-ports.sh's
# fail-open policy already commits to, and for the same reason: coverage may only shrink
# when the shrink is certain.
#
# Usage: scripts/ci-ports-to-run.sh <base-sha> <head-sha>
# Prints a space-separated subset of: ts java python csharp
set -uo pipefail

ALL="ts java python csharp"

# Resolve the sibling by the script's own location, never by the caller's cwd — the
# workflow happens to run from the repo root, and a relative call would keep working
# right up until something invoked this from anywhere else and it fell back to ALL.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# How far back to look for a lane's newest verdict. The nightly full matrix gives every
# lane a fresh verdict daily, so this window only has to outlive one day of pushes.
RUN_WINDOW="${MO_PORTS_RUN_WINDOW:-20}"

# Every local-ci job that TESTS a port, mapped to the port it tests. `detect`, `gates`
# and `notify` are absent on purpose: they run on every push, so they can never be the
# skipped-and-stale lane this file exists to catch.
#
# A new lane missing from this map would be invisible to the known-green check and could
# sit red forever under green runs — the same defect, one level down. Both directions are
# asserted against the workflow's real job list by scripts/test-ci-ports-to-run.sh.
lane_port() {
  case "$1" in
    ts-fast|ts-unit|ts-slow) echo ts ;;
    java-fast|java-slow)     echo java ;;
    python)                  echo python ;;
    csharp)                  echo csharp ;;
    *)                       echo "" ;;
  esac
}

all_lanes() { echo "ts-fast ts-unit ts-slow java-fast java-slow python csharp"; }

# Canonical order, deduplicated, unknown tokens dropped. The order is FIXED rather than
# sorted because the workflow tests the result with `contains(..., 'ts')` — a substring
# match on a string that must read the same whichever path produced it.
union_ports() {
  local want=" $* " out="" p
  for p in $ALL; do
    case "$want" in *" $p "*) out="$out $p" ;; esac
  done
  echo "${out# }"
}

# stdin: one "<job><TAB><conclusion>" line per job, with runs ordered NEWEST FIRST.
# Prints the ports that are not known-green.
#
# The first non-`skipped` conclusion for a lane is that lane's newest verdict. `skipped`
# is walked past rather than counted, because it describes the SELECTION and says nothing
# about the code — treating it as a verdict is precisely the bug.
#
# Anything that is not `success` counts as not-green, `cancelled` included: a cancelled
# lane was never verified, and `cancel-in-progress: true` makes cancellation common
# enough that counting it as green would reopen the hole from the other side. A lane with
# no verdict in the window is UNKNOWN, which widens for the same reason.
not_green_ports() {
  local -A verdict=()
  local job conc
  while IFS=$'\t' read -r job conc; do
    [ -n "$job" ] || continue
    [ "$conc" = "skipped" ] && continue
    [ -n "${verdict[$job]+x}" ] && continue
    verdict[$job]="$conc"
  done

  local out="" lane
  for lane in $(all_lanes); do
    [ "${verdict[$lane]:-}" = "success" ] || out="$out $(lane_port "$lane")"
  done
  union_ports $out
}

# Test seam: `MO_PORTS_TEST=1 source` exposes the pure functions and makes no network
# or git call. Everything above this line is pure; everything below talks to the world.
[ "${MO_PORTS_TEST:-0}" = "1" ] && return 0

# Ask the API for each lane's newest verdict on main, newest run first.
#
# curl + jq rather than `gh`: both are in /usr/bin on the self-hosted runner, while `gh`
# is on a user PATH the runner service does not necessarily inherit. A missing binary
# here would fail open to the full matrix, which is safe but silently expensive forever.
fetch_verdicts() {
  local repo="${GITHUB_REPOSITORY:-}" token="${GITHUB_TOKEN:-}" api="${GITHUB_API_URL:-https://api.github.com}"
  [ -n "$repo" ] && [ -n "$token" ] || return 1
  command -v curl >/dev/null && command -v jq >/dev/null || return 1

  local get=(curl -sS --fail --max-time 30
             -H "Authorization: Bearer $token"
             -H "Accept: application/vnd.github+json"
             -H "X-GitHub-Api-Version: 2022-11-28")

  local runs
  runs="$("${get[@]}" \
    "$api/repos/$repo/actions/workflows/local-ci.yml/runs?branch=main&status=completed&per_page=$RUN_WINDOW" \
    | jq -r '.workflow_runs[].id')" || return 1
  [ -n "$runs" ] || return 0   # no history is not an error; not_green_ports widens on it

  local id
  for id in $runs; do
    # The run doing the asking is not completed and so cannot appear here — but a rerun
    # of it could, and its own lanes are exactly the ones with no verdict yet.
    [ "$id" = "${GITHUB_RUN_ID:-}" ] && continue
    "${get[@]}" "$api/repos/$repo/actions/runs/$id/jobs?per_page=50" \
      | jq -r '.jobs[] | "\(.name)\t\(.conclusion // "none")"' || return 1
  done
}

BASE="${1:-}"; HEAD="${2:-HEAD}"
AFFECTED="$("$HERE/ci-affected-ports.sh" "$BASE" "$HEAD")"

VERDICTS="$(fetch_verdicts)"
if [ $? -ne 0 ]; then
  # Fail open, loudly. An API blip must not be able to shrink coverage; the cost of
  # widening is one extra matrix on a runner that bills nothing.
  echo "ci-ports-to-run: could not read lane history — selecting all ports" >&2
  union_ports $ALL
  exit 0
fi

STALE="$(printf '%s\n' "$VERDICTS" | not_green_ports)"
[ -n "$STALE" ] && echo "ci-ports-to-run: not known-green on main: $STALE" >&2
union_ports $AFFECTED $STALE
