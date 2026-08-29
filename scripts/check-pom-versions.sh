#!/usr/bin/env bash
#
# Guard: every reactor-EXCLUDED pom must carry the SAME MetaObjects version as the
# reactor root (server/java/pom.xml) — whether it names it as a <parent><version>
# (the integration-test modules) or as a <metaobjects.version> property (a project
# that merely CONSUMES the published artifacts, like the website showcase).
#
# Why this exists: integration-tests + integration-tests-kotlin are intentionally
# NOT listed in the parent reactor's <modules> (they need docker; `mvn test` stays
# docker-free — see scripts/integration-test.sh). Because they are outside the
# reactor, `mvn versions:set` during a release bumps every reactor module but
# SILENTLY SKIPS these two. Their <parent><version> then lags (e.g. reactor at
# 7.5.1-SNAPSHOT, these stuck at 7.4.4-SNAPSHOT), so `../pom.xml` no longer matches
# the declared parent → Maven rejects relativePath, falls back to repos, the
# SNAPSHOT isn't there, and `release-gate (java|kotlin)` fails with
# "Non-resolvable parent POM". This guard turns that latent drift into a loud,
# instant, toolchain-free failure (just grep — no JVM/Maven needed).
#
# Usage:  scripts/check-pom-versions.sh        # exit 1 + diagnostic on drift
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REACTOR_POM="$ROOT/server/java/pom.xml"

# The reactor root's own <version> is the first <version> element in its pom (it has
# no <parent>, so this is unambiguous).
reactor_version="$(grep -m1 -oE '<version>[^<]+</version>' "$REACTOR_POM" | sed -E 's#</?version>##g')"
if [ -z "$reactor_version" ]; then
  echo "check-pom-versions: could not read reactor version from $REACTOR_POM" >&2
  exit 2
fi

EXCLUDED_POMS=(
  "server/java/integration-tests/pom.xml"
  "server/java/integration-tests-kotlin/pom.xml"
)

# Poms with NO <parent> that consume the published artifacts through a
# <metaobjects.version> property. Same drift, different spelling: `mvn versions:set`
# does not touch them either, and a missed bump here is SILENT — the pom keeps
# resolving, just against the PREVIOUS release, so the showcase would regenerate
# from a plugin one version behind the model it is meant to demonstrate.
PROPERTY_POMS=(
  "examples/showcase/jvm/pom.xml"
)

fail=0
for rel in "${EXCLUDED_POMS[@]}"; do
  pom="$ROOT/$rel"
  [ -f "$pom" ] || { echo "check-pom-versions: missing $rel" >&2; fail=1; continue; }
  # Parent version is the first <version> inside the <parent> block.
  parent_version="$(awk '/<parent>/,/<\/parent>/' "$pom" | grep -m1 -oE '<version>[^<]+</version>' | sed -E 's#</?version>##g')"
  if [ "$parent_version" != "$reactor_version" ]; then
    echo "  ✖ $rel parent <version> is '$parent_version' but the reactor is '$reactor_version'." >&2
    fail=1
  fi
done

for rel in "${PROPERTY_POMS[@]}"; do
  pom="$ROOT/$rel"
  [ -f "$pom" ] || { echo "check-pom-versions: missing $rel" >&2; fail=1; continue; }
  prop_version="$(grep -m1 -oE '<metaobjects.version>[^<]+</metaobjects.version>' "$pom" | sed -E 's#</?metaobjects.version>##g')"
  if [ -z "$prop_version" ]; then
    echo "  ✖ $rel declares no <metaobjects.version> property." >&2
    fail=1
  elif [ "$prop_version" != "$reactor_version" ]; then
    echo "  ✖ $rel <metaobjects.version> is '$prop_version' but the reactor is '$reactor_version'." >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "check-pom-versions: reactor-excluded pom(s) drifted from the reactor version." >&2
  echo "A version bump must update these too — they sit outside the reactor, so" >&2
  echo "'mvn versions:set' skips them. Fix — set each to '$reactor_version':" >&2
  for rel in "${EXCLUDED_POMS[@]}";  do echo "        $rel  (<parent><version>)" >&2; done
  for rel in "${PROPERTY_POMS[@]}";  do echo "        $rel  (<metaobjects.version>)" >&2; done
  exit 1
fi

echo "check-pom-versions: ✓ ${#EXCLUDED_POMS[@]} parent + ${#PROPERTY_POMS[@]} property pom(s) match reactor $reactor_version"
exit 0
