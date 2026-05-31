#!/usr/bin/env bash
# Cross-language persistence conformance — on-demand integration suite.
#
# Spins up ephemeral Postgres containers (one per scenario) and runs the same
# fixture corpus through every shipped runner: TypeScript (Bun), C# (dotnet),
# Java (Maven), Python (uv + pytest), and Kotlin (Maven). Each runner
# exercises that port's metaobjects persistence layer (codegen + runtime)
# against a real Postgres instance.
#
# The Java- and Kotlin-runner Maven modules are intentionally NOT in the
# parent reactor — they require docker and we keep `mvn test` docker-free.
# This script invokes them via `-f <module>/pom.xml` so they run on demand.
#
# Usage:
#   scripts/integration-test.sh            # all runners
#   scripts/integration-test.sh ts         # only typescript
#   scripts/integration-test.sh csharp     # only c#
#   scripts/integration-test.sh java       # only java
#   scripts/integration-test.sh python     # only python
#   scripts/integration-test.sh kotlin     # only kotlin
#
# Pre-flight: docker daemon must be running.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

WHICH=${1:-all}
FAIL=0

if ! docker info >/dev/null 2>&1; then
  echo "error: docker daemon is not reachable. Start docker and try again." >&2
  exit 2
fi

run_ts() {
  echo "==> TypeScript persistence conformance"
  ( cd server/typescript/packages/integration-tests && bun test ) || FAIL=1
}

run_csharp() {
  echo "==> C# persistence conformance"
  dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj || FAIL=1
}

run_java() {
  echo "==> Java persistence conformance"
  ( cd server/java && mvn -f integration-tests/pom.xml test ) || FAIL=1
}

run_python() {
  echo "==> Python persistence conformance"
  # BOTH extras are required, on `uv run` itself:
  #   --extra dev          → puts pytest in the PROJECT venv. Without it, `uv run
  #                          pytest` falls back to a global pytest (~/.local/bin)
  #                          running in a foreign env that lacks the project deps.
  #   --extra integration  → fastapi/httpx/pg8000 for the api-contract scenarios.
  # Syncing only one (or `uv sync --extra ... && uv run pytest`, since `uv run`
  # re-syncs to its own flags) silently drops fastapi and aborts api-contract
  # collection, leaving only the query scenarios running.
  ( cd server/python && uv run --extra dev --extra integration pytest tests/integration -q ) || FAIL=1
}

run_kotlin() {
  echo "==> Kotlin persistence conformance"
  ( cd server/java && mvn -f integration-tests-kotlin/pom.xml test ) || FAIL=1
}

case "$WHICH" in
  all)    run_ts; run_csharp; run_java; run_python; run_kotlin ;;
  ts)     run_ts ;;
  csharp) run_csharp ;;
  java)   run_java ;;
  python) run_python ;;
  kotlin) run_kotlin ;;
  *)      echo "unknown runner: $WHICH (expected: all|ts|csharp|java|python|kotlin)" >&2; exit 2 ;;
esac

if [ "$FAIL" -ne 0 ]; then
  echo "FAILED — one or more runners did not pass." >&2
  exit 1
fi

echo "OK — all selected runners passed."
