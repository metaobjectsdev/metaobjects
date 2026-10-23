#!/usr/bin/env bash
# Cross-language persistence conformance — on-demand integration suite.
#
# Spins up ephemeral Postgres containers (one per scenario, unless METAOBJECTS_TEST_PG_URL
# points every scenario at a shared server, where each still gets its own database) and runs the same
# fixture corpus through every shipped runner: TypeScript (Bun), C# (dotnet),
# Java (Maven), Python (uv + pytest), and Kotlin (Maven). Each runner
# exercises that port's metaobjects persistence layer (codegen + runtime)
# against a real Postgres instance. The FR-044 report scenarios also run on MySQL 8.4 and
# SQLite where a port's runtime has the engine (see docs/CONFORMANCE.md); the lanes need no
# extra flags, the MySQL ones start their own mysql:8.4 container.
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
#   scripts/integration-test.sh cube       # the cube-model live check (NOT in `all`)
#
# `cube` is not a persistence runner: it loads the TypeScript cube-model generator's output
# into a real Cube (cubejs/cube, pinned) over its own throwaway Postgres and compares each
# report's Cube query with the report's view (FR-044). It owns its containers and a private
# network and binds only an ephemeral 127.0.0.1 port. `all` leaves it out because the image
# is about 1 GB; scripts/ci-local.sh runs it as its own `cube` lane. It runs two files: the
# Postgres path and the MySQL path (Cube against a real MySQL 8.4 holding the report views).
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

# Arguments every JVM integration `mvn test` takes.
#
# -Djacoco.skip=true, ONLY when MO_CI_INTEG_JACOCO_SKIP=1: the parent pom's JaCoCo gate is
# haltOnFailure=false, so it never decides a verdict, but its agent instruments every class
# the suites load, the embedded Kotlin compiler included, and that has broken class loading
# before. So it stays ON by default (integration-tests.yml keeps that instrumented run), and
# only scripts/ci-local.sh's full local run turns it off, as it does in the reactor.
# MO_CI_JACOCO=1 keeps it on there too.
#
# -DforkCount: surefire runs the test classes in that many JVMs side by side (default 1, one
# after another). The classes are independent: every scenario gets its own database, every
# MySQL class its own randomly named container on a random port, every compile a temp dir.
# Serially the MySQL, SQLite and report classes waited on each other for minutes; measured
# on integration-tests-kotlin, 4m52s -> 2m33s at 3. MO_CI_JVM_FORKS overrides it.
jvm_test_args() {
  printf '%s' "-DforkCount=${MO_CI_JVM_FORKS:-3}"
  if [ "${MO_CI_INTEG_JACOCO_SKIP:-0}" = "1" ] && [ "${MO_CI_JACOCO:-0}" != "1" ]; then
    printf ' %s' "-Djacoco.skip=true"
  fi
}

run_ts() {
  echo "==> TypeScript persistence conformance"
  # BUILD FIRST — this is load-bearing, not a convenience.
  #
  # The feature-combination gate runs a real `tsc --strict` over the generated
  # tree WITH the routes tier, so it resolves `@metaobjectsdev/*` through the
  # `types` export condition, which points into `dist/`. Bun's own resolution
  # takes the `bun` condition straight to `src/` and never needs `dist` at all —
  # so every bun test in this package passes without it, and a dev box that has
  # built even once stays green forever. A cold runner cannot: the workflow
  # installs but never builds, so `tsc` reported `Cannot find module
  # '@metaobjectsdev/runtime-ts/drizzle-fastify'` for all 23 models.
  #
  # It went unseen because the gate landed (2026-09-19) while GitHub Actions was
  # disabled, so its first hosted run was the v1.0.5-rc.3 tag — every earlier
  # release had run this lane green without the gate existing.
  #
  # The build belongs HERE rather than in the workflow, so a local
  # `scripts/integration-test.sh ts` proves the same thing CI does. Warmth is
  # what hid this; a caller that skips the build gets it back.
  #
  # The ONE exception is MO_CI_WORKSPACE_BUILT=1, which only scripts/ci-local.sh's full run
  # sets: it has just built this same tree, and other lanes are reading dist/ while this
  # one runs, so a second build here would rewrite it under them.
  if [ "${MO_CI_WORKSPACE_BUILT:-0}" != "1" ]; then
    ( cd "$REPO_ROOT" && bun run --filter '*' build ) || { FAIL=1; return; }
  fi
  # --parallel: the suite is ~50 files whose time sits in a dozen of them (the MySQL,
  # SQLite and D1 corpora), each generating and compiling its own app into a fresh
  # mkdtemp directory and provisioning its own database, so the files are independent and
  # serially they spent ten minutes waiting on each other. MO_CI_TS_WORKERS overrides it.
  ( cd server/typescript/packages/integration-tests && bun test --parallel="${MO_CI_TS_WORKERS:-6}" ) || FAIL=1
}

run_csharp() {
  echo "==> C# persistence conformance"
  # Each generated-server test boots an ASP.NET host, and every host's config watcher
  # takes an inotify instance. Run in parallel on a desktop that already holds most of the
  # per-user limit (128), they fail with "The configured user limit (128) on the number of
  # inotify instances has been reached". The tests never reload config; poll instead.
  DOTNET_USE_POLLING_FILE_WATCHER=1 \
    dotnet test server/csharp/MetaObjects.IntegrationTests/MetaObjects.IntegrationTests.csproj || FAIL=1
}

run_java() {
  echo "==> Java persistence conformance"
  # integration-tests is EXCLUDED from the parent reactor (docker-only), so its
  # <version>-SNAPSHOT module dependencies are not on Maven Central — install them to
  # the local .m2 first (SERIALLY; a parallel -T build clobbers the shared render jar).
  # Without this a fresh CI checkout fails with
  # "Could not find artifact com.metaobjects:metaobjects-metadata:jar:<v>-SNAPSHOT".
  #
  # MO_CI_JAVA_INSTALLED=1 (set only by scripts/ci-local.sh's full run, once its reactor
  # install has passed) skips that install: the reactor already installed every module, and
  # the Kotlin lane runs beside this one, so installing here too would race it over the same
  # jars.
  ( cd server/java \
      && { [ "${MO_CI_JAVA_INSTALLED:-0}" = "1" ] || mvn -q -DskipTests install -pl metadata,om,omdb,codegen-spring -am; } \
      && mvn -f integration-tests/pom.xml test $(jvm_test_args) ) || FAIL=1
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
  #
  # -n: pytest-xdist. Every scenario provisions its own database (see
  # tests/integration/postgres_container.py), so they run side by side. MO_CI_PY_WORKERS
  # overrides the worker count.
  ( cd server/python && uv run --extra dev --extra integration pytest tests/integration -q -n "${MO_CI_PY_WORKERS:-8}" ) || FAIL=1
}

run_cube() {
  echo "==> cube-model live check (Cube + Postgres)"
  # An explicit file path, so no directory-walking `bun test` ever picks the live file up.
  ( cd server/typescript/packages/integration-tests && bun run test:cube ) || FAIL=1
}

run_kotlin() {
  echo "==> Kotlin persistence conformance"
  # See run_java: install the SNAPSHOT module deps to .m2 (serially) before the
  # docker-only integration-tests-kotlin module (also excluded from the reactor).
  ( cd server/java \
      && { [ "${MO_CI_JAVA_INSTALLED:-0}" = "1" ] || mvn -q -DskipTests install -pl metadata,codegen-kotlin -am; } \
      && mvn -f integration-tests-kotlin/pom.xml test $(jvm_test_args) ) || FAIL=1
  # Issue #390 — exposedApi=1 (Exposed 1.x) compile + round-trip check. Same
  # docker-only / excluded-from-the-reactor shape as integration-tests-kotlin
  # above (and the SAME reason: its round-trip test needs a real Postgres), but
  # it is its OWN module because it needs a different Kotlin compiler floor
  # than codegen-kotlin itself (>= 2.2, vs. the project's usual 2.0.21) to read
  # Exposed 1.3.x's metadata — see that module's pom for the full rationale.
  ( cd server/java \
      && mvn -f codegen-kotlin-exposed1x-check/pom.xml test $(jvm_test_args) ) || FAIL=1
}

case "$WHICH" in
  all)    run_ts; run_csharp; run_java; run_python; run_kotlin ;;
  ts)     run_ts ;;
  csharp) run_csharp ;;
  java)   run_java ;;
  python) run_python ;;
  kotlin) run_kotlin ;;
  cube)   run_cube ;;
  *)      echo "unknown runner: $WHICH (expected: all|ts|csharp|java|python|kotlin|cube)" >&2; exit 2 ;;
esac

if [ "$FAIL" -ne 0 ]; then
  echo "FAILED — one or more runners did not pass." >&2
  exit 1
fi

echo "OK — all selected runners passed."
