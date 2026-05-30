#!/usr/bin/env bash
#
# Spring Boot fat-jar bootstrap smoke test.
#
# Verifies that a bare `metadata:` YAML root loads via `java -jar` from a
# repackaged Spring Boot fat jar, where MetaDataTypeProvider service manifests
# live in nested BOOT-INF/lib jars. This guards the runtime type-registry
# bootstrap that flat-classpath unit tests and conformance cannot exercise.
#
# Run on demand (NOT part of the reactor build):
#   scripts/fatjar-smoke.sh
#
# Exit 0 = boots and loads (FATJAR_SMOKE_OK); non-zero = regression.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAVA_DIR="$REPO_ROOT/server/java"
SMOKE_DIR="$JAVA_DIR/fatjar-smoke"

echo "==> Installing metaobjects-metadata snapshot to the local repository"
mvn -q -f "$JAVA_DIR/pom.xml" -pl metadata -am install -DskipTests

echo "==> Packaging the fat-jar smoke application"
mvn -q -f "$SMOKE_DIR/pom.xml" clean package

JAR="$SMOKE_DIR/target/fatjar-smoke.jar"
echo "==> Running: java -jar $JAR"
set +e
OUT="$(java -jar "$JAR" 2>&1)"
CODE=$?
set -e
echo "----------------------------------------"
echo "$OUT"
echo "----------------------------------------"

if [ "$CODE" -eq 0 ] && printf '%s' "$OUT" | grep -q "FATJAR_SMOKE_OK"; then
  echo "==> PASS: fat-jar bootstrap smoke"
  exit 0
fi

echo "==> FAIL: fat-jar bootstrap smoke (exit $CODE)"
exit 1
