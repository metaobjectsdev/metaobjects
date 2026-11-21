#!/usr/bin/env bash
# Tests for tools/prerelease/estate-run.sh, against a throwaway git project with stub commands.
#
#   bash tools/prerelease/test-estate-run.sh
#
# E1  a clean run passes and lists the files the first gen changed
# E2  a gen that writes on every run fails "second gen writes zero files"
# E3  a gen that rewrites identical bytes (new mtime only) fails the same check
# E4  an installed version that is not the candidate fails the run
# E5  a dirty project is refused (exit 2) before anything runs
# E6  each port spells the candidate its own way (PyPI rcN, Maven major + 7)
# E7  a build command that fails is reported and the run exits 1; no command is "skipped", not "passed"
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN="$HERE/estate-run.sh"
ROOT="$(mktemp -d "${DEV_SCRATCH:-${TMPDIR:-/tmp}}/estate-run-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
fails=0
t() { local name="$1"; shift; if "$@"; then echo "ok:   $name"; else echo "FAIL: $name"; fails=$((fails + 1)); fi; }

fresh() { # fresh <gen script body>  → prints the project dir
  local d; d="$(mktemp -d "$ROOT/p.XXXXXX")"
  ( cd "$d" && git init -q && git config user.email t@t && git config user.name t
    printf '%s\n' "$1" > gen.sh; echo seed > seed.txt; git add -A && git commit -q -m seed )
  echo "$d"
}
run() { # run <dir> <version> <port> [extra args...]
  local d="$1" v="$2" port="$3"; shift 3
  bash "$RUN" --project "$d" --port "$port" --version "$v" --no-link --install-cmd true \
    --verify-cmd true --gen-cmd 'sh gen.sh' "$@" 2>&1
}
IDEMPOTENT='[ "$(cat out.txt 2>/dev/null)" = "generated" ] || echo generated > out.txt'
VERS='--versions-cmd'

e1() { local d out; d="$(fresh "$IDEMPOTENT")"; out="$(run "$d" 1.3.0-rc.1 ts $VERS 'echo @metaobjectsdev/cli@1.3.0-rc.1' --build-cmd true)"; rc=$?
  [ $rc = 0 ] && grep -q 'second gen writes zero files | passed' <<<"$out" && grep -q '?? out.txt' <<<"$out"; }
e2() { local d out; d="$(fresh 'echo x >> out.txt')"; out="$(run "$d" 1.3.0-rc.1 ts $VERS 'echo cli@1.3.0-rc.1')"; rc=$?
  [ $rc = 1 ] && grep -q 'second gen writes zero files | \*\*FAILED' <<<"$out"; }
e3() { local d out; d="$(fresh 'echo generated > out.txt')"; out="$(run "$d" 1.3.0-rc.1 ts $VERS 'echo cli@1.3.0-rc.1')"; rc=$?
  [ $rc = 1 ] && grep -q 'second gen writes zero files | \*\*FAILED' <<<"$out"; }
e4() { local d out; d="$(fresh "$IDEMPOTENT")"; out="$(run "$d" 1.3.0-rc.2 ts $VERS 'echo @metaobjectsdev/cli@^1.3.0-rc.1')"; rc=$?
  [ $rc = 1 ] && grep -q 'installed version is 1.3.0-rc.2 | \*\*FAILED' <<<"$out"; }
e5() { local d out; d="$(fresh "$IDEMPOTENT")"; echo dirt > "$d/seed.txt"; out="$(run "$d" 1.3.0-rc.1 ts $VERS true)"; rc=$?
  [ $rc = 2 ] && grep -q 'uncommitted changes' <<<"$out"; }
e6() { local d1 d2 o1 o2; d1="$(fresh "$IDEMPOTENT")"; d2="$(fresh "$IDEMPOTENT")"
  o1="$(run "$d1" 1.3.0-rc.4 python $VERS 'echo metaobjects@1.3.0rc4')"; o2="$(run "$d2" 1.3.0-rc.4 java $VERS 'echo com.metaobjects:x:8.3.0-rc.4')"
  grep -q 'installed version is 1.3.0rc4 | passed' <<<"$o1" && grep -q 'installed version is 8.3.0-rc.4 | passed' <<<"$o2"; }
e7() { local d out; d="$(fresh "$IDEMPOTENT")"; out="$(run "$d" 1.3.0-rc.1 ts $VERS 'echo cli@1.3.0-rc.1' --build-cmd 'echo boom >&2; exit 3')"; rc=$?
  [ $rc = 1 ] && grep -q 'build | \*\*FAILED\*\* (exit 3)' <<<"$out" && grep -q 'boom' <<<"$out" && grep -q 'tests | skipped' <<<"$out"; }

t "E1 a clean run passes and lists what the first gen changed" e1
t "E2 a gen that writes on every run fails the zero-write check" e2
t "E3 a gen that rewrites identical bytes fails the zero-write check" e3
t "E4 a read-back without the candidate fails the run" e4
t "E5 a dirty project is refused" e5
t "E6 PyPI and Maven spell the candidate their own way" e6
t "E7 a failing build is reported; a missing command is skipped, not passed" e7

[ "$fails" = 0 ] && echo "all estate-run tests passed" || { echo "$fails failure(s)"; exit 1; }
