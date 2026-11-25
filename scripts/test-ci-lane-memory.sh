#!/usr/bin/env bash
# Test of the lane scheduler's memory admission in scripts/ci-local.sh (lane_has_memory).
#
# A waiting lane starts only while MemAvailable covers MO_CI_LANE_MIN_FREE_MB for it and for
# each lane started in the last LANE_WARMUP_S seconds. Without that, a parallel run on a busy
# machine drove memory down to earlyoom's limit, and earlyoom's SIGTERMs surfaced as a crashed
# C# test host and SIGTERMed bun workers instead of as a memory problem.
#
# The functions are read out of ci-local.sh itself, so this tests the shipped code. The
# script cannot be sourced whole because it runs CI. MemAvailable is stubbed, so the result
# does not depend on the machine running the test. Nothing here starts a lane.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fails=0
check() { # check "<expected>" "<got>" "<what>"
  if [ "$2" != "$1" ]; then
    echo "FAIL: $3 -> '$2' (expected '$1')" >&2; fails=$((fails+1))
  else
    echo "ok:   $3 -> '$2'"
  fi
}

defs="$(sed -n '/^LANE_WARMUP_S=/p; /^lane_has_memory() {/,/^}/p' scripts/ci-local.sh)"
[ -n "$defs" ] || { echo "FAIL: lane_has_memory not found in scripts/ci-local.sh" >&2; exit 1; }
eval "$defs"

AVAIL=""
mem_available_mb() { echo "$AVAIL"; }
admit() { # admit <min_free_mb> <avail_mb> <running> <recent>
  MO_CI_LANE_MIN_FREE_MB="$1"; AVAIL="$2"
  if lane_has_memory "$3" "$4"; then echo start; else echo wait; fi
}

check start "$(admit 8192 1000 0 3)"   "the first lane starts even with no headroom (no deadlock)"
check start "$(admit 8192 9000 1 0)"   "enough for one more lane"
check wait  "$(admit 8192 7000 1 0)"   "below the threshold: the lane waits"
check wait  "$(admit 8192 20000 2 2)"  "two lanes still warming up hold 8 GiB each in reserve"
check start "$(admit 8192 24576 2 2)"  "enough for the new lane and both warming lanes"
check start "$(admit 0 100 5 5)"       "MO_CI_LANE_MIN_FREE_MB=0 turns the check off"
check start "$(admit 8192 '' 4 4)"     "unreadable MemAvailable (not Linux) never blocks"

# The scheduler must consult it, or the function is dead code that this test keeps green.
check 1 "$(sed -n '/^run_lanes() {/,/^}/p' scripts/ci-local.sh | grep -c 'lane_has_memory "$running" "$recent"')" \
  "run_lanes gates each lane start on lane_has_memory"

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed" >&2; exit 1; fi
echo "lane memory admission: all checks passed"
