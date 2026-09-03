#!/usr/bin/env bash
# NO MAGIC STRINGS — the gate over the gate.
#
# Each port carries a de-blinded gate proving its generated code references the
# `<Entity>Names` constants instead of respelling a physical database name. That claim is
# cross-port, and a cross-port claim held up by five independent files is exactly the shape
# that decays one port at a time: delete one, or drop it from a CI lane, and the remaining
# four go on passing while the sentence "every port is gated" quietly stops being true.
#
# So this checks two things a reader would otherwise have to take on trust:
#   1. every port still HAS its gate file, and
#   2. the two lanes that select JVM tests BY NAME still name it — those lanes run a
#      hand-listed `-Dtest=` set, so a gate not on the list runs in no fast lane at all.
#      (TypeScript, C# and Python run their whole suites, so file presence is sufficient
#      there; this script says which is which rather than leaving it implied.)
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { printf '  ✖ %s\n' "$1" >&2; fail=1; }

# --- 1. the five gate files -------------------------------------------------------------
# Each entry: <port> <path> <how it reaches CI>
while read -r port path how; do
  [ -z "$port" ] && continue
  if [ ! -f "$path" ]; then
    note "$port: missing its no-magic gate at $path (reached CI via: $how)"
  fi
done <<'PORTS'
typescript server/typescript/packages/codegen-ts/test/no-magic-physical-names.test.ts ts-unit_runs_the_whole_package_suite
csharp     server/csharp/MetaObjects.Codegen.Tests/NoMagicPhysicalNamesTests.cs        conf_csharp_runs_the_whole_project
python     server/python/tests/codegen/test_no_magic_physical_names.py                 conf_python_runs_the_whole_suite
java       server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/NoMagicPhysicalNamesTest.java  conf_java_names_it_explicitly
kotlin     server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/NoMagicPhysicalNamesTest.kt  conf_kotlin_names_it_explicitly
PORTS

# --- 2. the name-selected JVM lanes ------------------------------------------------------
CI=scripts/ci-local.sh
for fn in gate_conf_java gate_conf_kotlin; do
  # The lane body: from its declaration to the closing brace.
  body=$(awk "/^${fn}\(\) \{/,/^\}/" "$CI")
  [ -n "$body" ] || { note "$CI: no $fn to check — did the lane get renamed?"; continue; }
  case "$body" in
    *NoMagicPhysicalNamesTest*) ;;
    *) note "$CI: $fn does not name NoMagicPhysicalNamesTest. That lane selects tests by name, so the gate would run in no fast lane — only in the slow reactor, which --quick skips." ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "The no-magic-physical-names gate is the check behind 'generated code references the" >&2
  echo "constant, never a literal'. Restore the file, or wire it back into the lane." >&2
  exit 1
fi
echo "no-magic gate coverage: 5 ports wired"
