#!/usr/bin/env bash
# Test of the affected-lane selection: scripts/ci-lane-map.txt as read by
# scripts/ci-select-lanes.sh, and `scripts/ci-local.sh --affected` end to end.
#
# Part 1 feeds fixed change sets straight into select_lanes and asserts the lanes each
# selects: one port, two ports, the shared model, a CI script, an unmapped path, docs, and
# an empty diff. Part 2 asserts the map itself is well formed and that the rules which
# must stay (a change to the map or a script runs everything) have not been edited away.
# Part 3 builds a throwaway repository and runs the real `ci-local.sh --affected` in it,
# so the git side (merge base, committed + uncommitted + untracked, fail-open) is exercised
# and not just the pure function. Nothing here runs a lane.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
MO_SELECT_LIB=1 source scripts/ci-select-lanes.sh

fails=0
check() { # check "<expected>" "<got>" "<what>"
  if [ "$2" != "$1" ]; then
    echo "FAIL: $3 -> '$2' (expected '$1')" >&2; fails=$((fails+1))
  else
    echo "ok:   $3 -> '${2:-<none>}'"
  fi
}
lanes() { select_lanes "$@"; echo "$SELECTED_LANES"; }

ALL="ts-fast ts-unit java-slow python csharp rust"

# ── 1. change sets ────────────────────────────────────────────────────────────
check "ts-fast ts-unit"  "$(lanes server/typescript/packages/cli/src/x.ts)"                "one port: typescript"
check "ts-fast ts-unit"  "$(lanes client/web/packages/react/src/y.tsx)"                    "one port: the web client is typescript's"
check "java-slow"        "$(lanes server/java/metadata/src/main/java/A.java server/java/codegen-kotlin/src/main/kotlin/B.kt)" "one port: java and kotlin"
check "python"           "$(lanes server/python/src/metaobjects/loader.py)"               "one port: python"
check "csharp"           "$(lanes server/csharp/MetaObjects/Loader.cs)"                   "one port: csharp"
check "rust"             "$(lanes server/rust/metaobjects/src/loader.rs)"                 "one port: rust"
check "ts-fast ts-unit python" "$(lanes server/python/b.py server/typescript/a.ts)"       "two ports, given out of order, run in lane order"
check "ts-fast ts-unit java-slow python csharp" "$(lanes server/csharp/a.cs server/java/b.java server/python/c.py server/typescript/d.ts)" "all four ports touched"
check "$ALL"             "$(lanes fixtures/conformance/foo/meta.json)"                    "shared fixtures run everything"
check "$ALL"             "$(lanes spec/metamodel.md)"                                     "the spec runs everything"
check "$ALL"             "$(lanes agent-context/skills/x.md)"                             "agent context runs everything"
check "$ALL"             "$(lanes scripts/ci-local.sh)"                                   "a CI script runs everything"
check "$ALL"             "$(lanes scripts/ci-lane-map.txt)"                               "the map itself runs everything"
check "$ALL"             "$(lanes .github/workflows/local-ci.yml)"                        "a workflow runs everything"
check "$ALL"             "$(lanes weird-new-toplevel/file.txt)"                           "an unmapped path runs everything"
check "$ALL"             "$(lanes .no-mistakes.yaml)"                                     "an unmapped dotfile runs everything"
check "$ALL"             "$(lanes server/python/a.py weird-new-toplevel/file.txt)"        "one unmapped path among mapped ones runs everything"
check "$ALL"             "$(lanes docs/x.md fixtures/y.json)"                             "docs beside a shared fixture: the fixture wins"
check "$ALL"             "$(lanes docs/recipes/generators/typescript/x.ts)"               "recipe generators are executed by port tests, so they are not docs"
check "$ALL"             "$(lanes docs/features/cli.md)"                                  "a docs page: port tests read docs/, so it runs everything"
check "$ALL"             "$(lanes docs/ports/java.md)"                                    "the java port doc is read by a java test"
check "$ALL"             "$(lanes examples/foo/README.md)"                                "markdown outside the named root files is unmapped"
check ""                 "$(lanes README.md CHANGELOG.md CONTRIBUTING.md)"                "root prose only: no test lane, the gates lane checks it"
check "python"           "$(lanes server/python/README.md)"                               "a port's own markdown still selects the port"
check ""                 "$(lanes)"                                                       "empty diff: no test lane"

select_lanes; check "  no changed paths: nothing to run" "$SELECTION_REPORT" "empty diff says why"
select_lanes server/java/A.java server/java/B.java server/java/C.java server/java/D.java server/java/E.java server/java/F.java
case "$SELECTION_REPORT" in
  *"java-slow <- server/java/*"*"server/java/A.java"*"and 2 more"*) echo "ok:   the report names the rule, the paths and how many it elided" ;;
  *) echo "FAIL: report does not name rule, paths and the elided count: $SELECTION_REPORT" >&2; fails=$((fails+1)) ;;
esac

# ports, for the hosted workflows' detect jobs: derived from the same lanes
check "ts python" "$(MO_AFFECTED_TEST=1 bash -c 'source scripts/ci-affected-ports.sh; map_paths_to_ports server/typescript/a.ts server/python/b.py')" "ports derive from lanes"

# ── 2. the map ────────────────────────────────────────────────────────────────
check "" "$(lane_map_problems)" "the committed map is well formed"

bad="$(mktemp "${DEV_SCRATCH:-${TMPDIR:-/tmp}}/ci-lane-map-bad.XXXXXX")"
printf '%s\n' 'server/python/* | pyton | typo in a lane name' 'weird/* | ALL | no catch-all follows' > "$bad"
check "yes" "$([ -n "$(CI_LANE_MAP="$bad" lane_map_problems)" ] && echo yes || echo no)" "a misspelt lane and a missing catch-all are reported"
# A map that is broken must widen, never narrow.
check "$ALL" "$(CI_LANE_MAP="$bad" lanes server/python/a.py)" "an invalid map selects every lane"
check "$ALL" "$(CI_LANE_MAP=/nonexistent lanes server/python/a.py)" "an unreadable map selects every lane"
rm -f "$bad"

# ── 3. ci-local.sh --affected on a real repository ────────────────────────────
tmp="$(mktemp -d "${DEV_SCRATCH:-${TMPDIR:-/tmp}}/ci-lane-selection.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
git init -q -b main "$tmp/repo" || { echo "FAIL: cannot create a throwaway repository" >&2; exit 1; }
mkdir -p "$tmp/repo/scripts/lib" "$tmp/repo/server/python" "$tmp/repo/server/typescript" "$tmp/repo/docs"
cp scripts/ci-local.sh scripts/ci-select-lanes.sh scripts/ci-lane-map.txt scripts/ci-affected-ports.sh "$tmp/repo/scripts/"
cp scripts/lib/maven-private-repo.sh "$tmp/repo/scripts/lib/"
echo a > "$tmp/repo/server/python/a.py"; echo a > "$tmp/repo/server/typescript/a.ts"; echo a > "$tmp/repo/docs/a.md"
git -C "$tmp/repo" add -A
git -C "$tmp/repo" -c user.name=t -c user.email=t@example.invalid commit -q -m base
git -C "$tmp/repo" checkout -q -b change

run() { # run [ENV=val ...] — prints the selected line of the explanation
  ( cd "$tmp/repo" && env MO_CI_AFFECTED_BASE=main MO_CI_SELECTION_PRINT_ONLY=1 "$@" scripts/ci-local.sh --affected 2>&1 ) \
    | sed -n 's/^  selected: //p'
}
commit() { git -C "$tmp/repo" add -A; git -C "$tmp/repo" -c user.name=t -c user.email=t@example.invalid commit -q -m "$1"; }

check "(none)" "$(run)" "git: no change selects nothing"
echo b >> "$tmp/repo/server/python/a.py"; commit python
check "python" "$(run)" "git: a committed python change selects python"
echo b >> "$tmp/repo/server/typescript/a.ts"
check "ts-fast ts-unit python" "$(run)" "git: an uncommitted typescript change joins it"
commit typescript
echo b >> "$tmp/repo/README.md"
check "ts-fast ts-unit python" "$(run)" "git: an untracked root-prose file adds no lane"
commit prose
check "$ALL" "$(run MO_CI_FULL=1)" "MO_CI_FULL=1 selects every lane"
check "$ALL" "$(run MO_CI_AFFECTED_BASE=no-such-ref)" "an unresolvable base selects every lane"
# How the selection RUNS (MO_CI_LIST_ONLY prints the plan): several port groups are parallel
# lanes, so a change to every port is not slower than the full run; one group stays serial.
plan() { ( cd "$tmp/repo" && env MO_CI_AFFECTED_BASE=main MO_CI_LIST_ONLY=1 "$@" scripts/ci-local.sh --affected 2>&1 ); }
lane_blocks() { { grep -o '^── lane [a-z]*' || true; } | sed 's/^── lane //' | sort | paste -sd' ' -; }
check "csharp java python rust ts" "$(plan MO_CI_FULL=1 | lane_blocks)" "every port selected: one parallel lane per port group"
check "python ts"             "$(plan | lane_blocks)"             "python and typescript selected: two parallel lanes"
check "yes" "$(plan | grep 'run as parallel lanes' >/dev/null && echo yes || echo no)" "several groups are announced as parallel"
check ""    "$(plan MO_CI_AFFECTED_BASE=HEAD~2 | lane_blocks)"    "one group (typescript, the docs adds none) stays serial"
check "yes" "$(plan MO_CI_AFFECTED_BASE=HEAD~2 | grep 'ts build + typecheck' >/dev/null && echo yes || echo no)" "the serial plan still lists typescript's steps"
# A rename's OLD path counts too (ci-affected-ports.sh diffs with --no-renames, like
# changed_paths does): moving a file OUT of a path that maps broader than its destination
# must select what the old path affects, not only the new one. Before --no-renames this
# printed 'java', silently dropping the ts/python/csharp lanes agent-context selects.
# (Before the `map` corruption below, which widens every later selection to ALL on purpose.)
mkdir -p "$tmp/repo/agent-context/skills" "$tmp/repo/server/java"
echo s > "$tmp/repo/agent-context/skills/x.md"; commit shared
git -C "$tmp/repo" mv agent-context/skills/x.md server/java/x.md; commit rename-into-java
ports() { ( cd "$tmp/repo" && scripts/ci-affected-ports.sh "$(git rev-parse HEAD~1)" HEAD ); }
check "ts java python csharp rust" "$(ports)" "git: a rename out of agent-context still selects every port"
git -C "$tmp/repo" mv server/java/x.md server/python/x.py; commit rename-java-to-python
check "java python" "$(ports)" "git: a rename between ports selects both"

echo b >> "$tmp/repo/scripts/ci-lane-map.txt"; commit map
check "$ALL" "$(run)" "git: editing the map selects every lane"
# --affected is a selector; combining it with the other selectors is refused, not guessed at.
( cd "$tmp/repo" && scripts/ci-local.sh --affected --only gates >/dev/null 2>&1 ); check "2" "$?" "--affected with --only is a usage error"
( cd "$tmp/repo" && scripts/ci-local.sh --affected --quick >/dev/null 2>&1 );     check "2" "$?" "--affected with --quick is a usage error"

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails failure(s)" >&2; exit 1; }
