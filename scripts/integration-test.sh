#!/usr/bin/env bash
# Cross-language persistence conformance — on-demand integration suite.
#
# Spins up ephemeral Postgres containers (one per scenario) and runs the same
# fixture corpus through every shipped runner: TypeScript (Bun), C# (dotnet),
# Java (Maven), and Python (uv + pytest). Each runner exercises that port's
# metaobjects persistence layer (codegen + runtime) against a real Postgres
# instance.
#
# Usage:
#   scripts/integration-test.sh            # all runners
#   scripts/integration-test.sh ts         # only typescript
#   scripts/integration-test.sh csharp     # only c#
#   scripts/integration-test.sh java       # only java
#   scripts/integration-test.sh python     # only python
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
  ( cd server/python && uv sync --extra integration --quiet && uv run pytest tests/integration -q ) || FAIL=1
}

case "$WHICH" in
  all)    run_ts; run_csharp; run_java; run_python ;;
  ts)     run_ts ;;
  csharp) run_csharp ;;
  java)   run_java ;;
  python) run_python ;;
  *)      echo "unknown runner: $WHICH (expected: all|ts|csharp|java|python)" >&2; exit 2 ;;
esac

if [ "$FAIL" -ne 0 ]; then
  echo "FAILED — one or more runners did not pass." >&2
  exit 1
fi

echo "OK — all selected runners passed."
