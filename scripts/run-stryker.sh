#!/usr/bin/env bash
# Run a package's Stryker mutation gate without wearing the drives or leaving anything behind.
#
#   scripts/run-stryker.sh <package-label> [stryker run options]   (run from the package directory)
#
# - The sandbox (a full copy of the package, rewritten once per mutant) goes under
#   $DEV_SCRATCH/stryker/<package-label>-XXXXXX, a RAM-backed scratch area, falling back to the
#   system temp directory when DEV_SCRATCH is unset. The package's stryker.conf.mjs reads the
#   directory from METAOBJECTS_STRYKER_TEMP.
# - Stryker runs in its own process group, so its test-runner children go with it: on exit, on
#   failure and on Ctrl-C or SIGTERM the whole group is stopped before the sandbox is removed.
set -uo pipefail

label="${1:?usage: run-stryker.sh <package-label>}"
scratch="${DEV_SCRATCH:-${TMPDIR:-/tmp}}"
mkdir -p "$scratch/stryker"
sandbox="$(mktemp -d "$scratch/stryker/${label}-XXXXXX")"
export METAOBJECTS_STRYKER_TEMP="$sandbox"

pid=""
cleanup() {
  if [[ -n "$pid" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- "-$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null
  fi
  rm -rf "$sandbox"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A background job of a non-interactive shell is not a group leader, so setsid execs in place:
# $pid is Stryker's own pid and the id of its new process group.
setsid stryker run "${@:2}" &
pid=$!
wait "$pid"
status=$?
# Stryker has exited; the EXIT trap stops any runner left in its group and removes the sandbox.
exit "$status"
