#!/usr/bin/env bash
#
# Guard: the reactor-EXCLUDED Java/Kotlin integration-test modules must carry the
# SAME parent <version> as the reactor root (server/java/pom.xml).
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

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "check-pom-versions: reactor-excluded integration-test module(s) drifted from the" >&2
  echo "reactor version. A version bump must update these too (they are outside the" >&2
  echo "reactor, so 'mvn versions:set' skips them). Fix — set their parent <version> to" >&2
  echo "the reactor version ('$reactor_version') in:" >&2
  echo "        server/java/integration-tests/pom.xml" >&2
  echo "        server/java/integration-tests-kotlin/pom.xml" >&2
  exit 1
fi

echo "check-pom-versions: ✓ excluded integration-test modules match reactor $reactor_version"
exit 0
