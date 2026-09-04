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
#   3. every port's FIXTURE still models the same set of metamodel shapes.
#
# Point 3 is the one that was missing, and its absence is why five green gates could sit on
# top of six real escapes. A gate speaks only for the code paths its fixture reaches, so
# "all five ports are gated" is true of whatever the narrowest fixture happens to contain —
# and the five drifted, one shape at a time, with nothing able to notice: Kotlin's fixture
# had no projection, no write-through entity, no TPH pair and no callable, so those paths
# were unmeasured in that port while the cross-port sentence went on being repeated.
#
# Checking CONTENT rather than a self-declared manifest is deliberate: a list of shapes a
# gate claims to cover is exactly as reliable as the claim it is supposed to verify. The
# markers below are metamodel type and attribute names, which appear in each gate's
# embedded model regardless of host language (JSON keys, quoted the same way in a TS object
# literal, a Python dict, a Kotlin raw string and a Java escaped string).
#
# The honest limit: a marker could in principle be matched by prose rather than by the
# model. That is why every marker is a QUOTED metamodel token or a `<key>: true` pair, both
# of which a sentence does not contain by accident — and why a port that genuinely cannot
# model a shape must say so in EXPECTED_MISSING below, with a reason, rather than being
# quietly tolerated.
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

# --- 3. fixture shape parity across the five ports --------------------------------------
# Each row: <shape> <grep -E pattern matching the shape in an embedded model>
#
# A shape belongs here when a generator handles it on its OWN code path — that is what
# makes a fixture without it unable to speak for it.
shapes() {
  cat <<'SHAPES'
tph_base \"@discriminator\"
tph_subtype \"@discriminatorValue\"
enum \"field\.enum\"
enum_int_backed \"@intValueMap\"
secondary_identity \"identity\.secondary\"
lookup_index \"index\.lookup\"
callable_source \"storedProc\"
schema \"@schema\"
array_field isArray\"?[[:space:]]*:[[:space:]]*[tT]rue
abstract_base abstract\"?[[:space:]]*:[[:space:]]*[tT]rue
projection \"object\.projection\"
value_object \"object\.value\"
write_through_role \"@role\"
SHAPES
}

ports() {
  cat <<'PORTS'
typescript server/typescript/packages/codegen-ts/test/no-magic-physical-names.test.ts
csharp server/csharp/MetaObjects.Codegen.Tests/NoMagicPhysicalNamesTests.cs
python server/python/tests/codegen/test_no_magic_physical_names.py
java server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/NoMagicPhysicalNamesTest.java
kotlin server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/NoMagicPhysicalNamesTest.kt
PORTS
}

# The KNOWN GAPS ledger: `<port>:<shape>` pairs whose fixture does not model that shape.
#
# It exists so the gaps are ENUMERATED rather than invisible, which is the whole lesson of
# the escapes this check was added for — five gates went green over five fixtures nobody
# had ever compared. A row here is a statement that this port's gate does not speak for
# that path, not permission for it never to.
#
# Checked in BOTH directions, like every other ledger in this repo: a shape a port stops
# modelling fails as a new gap, and a row whose shape the port has since started modelling
# fails too, with "delete this row". A stale exemption is how a ledger ends up describing a
# codebase that moved on.
#
# TypeScript models every shape and appears nowhere below; it is the reference the other
# four are being widened against.
known_gaps() {
  cat <<'GAPS'
csharp:tph_base
csharp:tph_subtype
csharp:enum
csharp:enum_int_backed
csharp:secondary_identity
csharp:lookup_index
csharp:callable_source
csharp:schema
csharp:array_field
csharp:abstract_base
java:tph_base
java:tph_subtype
java:enum
java:enum_int_backed
java:secondary_identity
java:lookup_index
java:callable_source
java:schema
java:array_field
java:abstract_base
java:projection
java:value_object
java:write_through_role
kotlin:tph_base
kotlin:tph_subtype
kotlin:enum
kotlin:enum_int_backed
kotlin:secondary_identity
kotlin:lookup_index
kotlin:callable_source
kotlin:schema
kotlin:array_field
kotlin:abstract_base
kotlin:projection
kotlin:write_through_role
GAPS
}

observed_gaps=$(
  while read -r port path; do
    [ -z "$port" ] && continue
    [ -f "$path" ] || continue   # already reported by section 1
    while read -r shape pattern; do
      [ -z "$shape" ] && continue
      grep -Eq "$pattern" "$path" || printf '%s:%s\n' "$port" "$shape"
    done <<SHAPELIST
$(shapes)
SHAPELIST
  done <<PORTLIST
$(ports)
PORTLIST
)

# New gap: a port models one shape fewer than the ledger says.
while read -r gap; do
  [ -z "$gap" ] && continue
  note "${gap%%:*}: its fixture models no ${gap##*:} — that gate cannot speak for that path, so the cross-port claim does not cover it. Add the shape, or add '$gap' to known_gaps with a reason."
done <<< "$(comm -23 <(printf '%s\n' "$observed_gaps" | grep . | sort) <(known_gaps | sort))"

# Stale row: the port models the shape now, so the ledger is describing a past codebase.
while read -r gap; do
  [ -z "$gap" ] && continue
  note "known_gaps lists '$gap', but that fixture DOES model the shape now. Delete the row — a gap that closed without the ledger noticing is how the ledger stops being true."
done <<< "$(comm -13 <(printf '%s\n' "$observed_gaps" | grep . | sort) <(known_gaps | sort))"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "The no-magic-physical-names gate is the check behind 'generated code references the" >&2
  echo "constant, never a literal'. A gate speaks only for the paths its fixture reaches, so" >&2
  echo "this script checks that every port still HAS its gate, that the name-selected JVM" >&2
  echo "lanes still run it, and that the five fixtures still model the same shapes. Restore" >&2
  echo "the file, wire it back into the lane, or reconcile the shape ledger above." >&2
  exit 1
fi
echo "no-magic gate coverage: 5 ports wired; $(shapes | grep -c .) shapes tracked, $(known_gaps | grep -c .) known gaps"
