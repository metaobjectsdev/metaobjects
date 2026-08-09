#!/usr/bin/env bash
#
# Local CI — run the same gates as .github/workflows/ on your machine.
#
# As of the cost-reduction change, the heavy correctness gates (the 5-port
# conformance matrix, the full Java reactor, the drift/mutation gates, and the
# whole integration-tests testcontainers matrix) NO LONGER run automatically on
# every push/PR — they are `workflow_dispatch` + release-tag (`v*`) only. This
# script is how you run them locally before opening/merging a PR, so nothing red
# leaves your machine. The cheap public-repo SECURITY backstop (leak-scan) still
# runs automatically in CI on every PR; it is included here too.
#
# Usage:
#   scripts/ci-local.sh              # FULL parity: all-port conformance + full Java
#                                    #   reactor + drift/mutation gates + docker
#                                    #   integration suite. Run before a PR or tag.
#   scripts/ci-local.sh --quick      # FAST inner-loop tier: the cheap TS-centric
#                                    #   gates only (leak-scan, pom parity, fixture-
#                                    #   lint, ts build+typecheck, ts conformance,
#                                    #   completeness, drift). Skips the other-
#                                    #   language ports, the reactor, and docker.
#   scripts/ci-local.sh --only <section> [--only <section> ...]
#                                    # Run one or more named sections. Mutually
#                                    #   exclusive with --quick (exit 2 if combined).
#                                    #   gates  → leak-scan, pom parity, fixture-lint,
#                                    #            doc-template drift, embedded-library drift
#                                    #   ts     → ts build+typecheck, ts conformance,
#                                    #            completeness-gate, full unit suites
#                                    #            (ts-unit), integration-tests ts
#                                    #   ts-fast → build+typecheck, conformance,
#                                    #            completeness (the pure-code signal)
#                                    #   ts-unit → full per-package unit suites for
#                                    #            metadata/render/runtime-ts + the
#                                    #            client/web packages — runs in
#                                    #            parallel with ts-fast in CI
#                                    #   ts-slow → build + integration-tests ts
#                                    #            (docker); CI runs the three lanes as
#                                    #            separate parallel jobs
#                                    #   java   → java+kotlin conformance, reactor,
#                                    #            integration-tests java+kotlin
#                                    #   java-fast → java+kotlin conformance only
#                                    #            (the quick correctness signal)
#                                    #   java-slow → reactor + integration-tests
#                                    #            (java+kotlin); CI runs the two
#                                    #            lanes as separate parallel jobs
#                                    #   python → full python test suite + integration-tests
#                                    #   csharp → full csharp codegen suite + conformance
#                                    #            + integration-tests
#   scripts/ci-local.sh --strict-toolchains
#                                    # Promote missing-toolchain and docker-down SKIPs
#                                    #   to FAILs; useful in CI or a full-toolchain
#                                    #   machine where skips indicate real problems.
#   scripts/ci-local.sh --help
#
# Set MO_CI_LIST_ONLY=1 to print the steps that would run (given the current
# flags) and exit 0 without running anything — useful for verifying section
# selection without waiting for tests to complete.
#
# Ports whose toolchain (bun / dotnet / uv / mvn) is not installed are SKIPPED
# with a loud warning (not silently passed). A full pre-release run is expected on
# a machine with every toolchain — otherwise rely on the release-tag CI run.
# Use --strict-toolchains to promote all SKIPs to FAILs (e.g. in CI itself).
#
# Mirrors: hygiene.yml (leak-scan) · conformance.yml (fixture-lint, typecheck,
# 5-port conformance, kotlin, java-reactor, completeness-gate, doc-template-drift,
# embedded-library-drift) · integration-tests.yml (5-port suite + migrate-ts-pg).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

QUICK=0; STRICT=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --strict-toolchains) STRICT=1 ;;
    --only) shift; case "${1:-}" in
        gates|ts|ts-fast|ts-unit|ts-slow|java|java-fast|java-slow|python|csharp) ONLY="$ONLY ${1}" ;;
        *) echo "--only expects gates|ts|ts-fast|ts-unit|ts-slow|java|java-fast|java-slow|python|csharp, got '${1:-}'" >&2; exit 2 ;;
      esac ;;
    -h|--help) awk 'NR==1{next} /^set -uo/{exit} {sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$ONLY" ] && [ "$QUICK" -eq 1 ] && { echo "--only and --quick are mutually exclusive" >&2; exit 2; }

want() { # want <section> — true when the section should run
  [ -z "$ONLY" ] && return 0
  case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
want_any() { # want_any <section...> — true when ANY listed section should run
  local s; for s in "$@"; do want "$s" && return 0; done; return 1
}

PASS=(); FAIL=(); SKIP=()
have() { command -v "$1" >/dev/null 2>&1; }

# bun exits 1 when an OPTIONAL native dep fails its install script (the
# ssh2/cpu-features chain needs node-gyp on the machine — `npm i -g node-gyp`
# fixes it for good). Retry once as defense-in-depth for transient installer
# flakes; a genuinely broken install still fails both attempts.
bun_install() { bun install || bun install; }

step() {  # step "<name>" <cmd...>
  local name="$1"; shift
  echo ""
  echo "── ▶ $name ──────────────────────────────────────────────"
  if "$@"; then PASS+=("$name"); else FAIL+=("$name"); echo "  ✖ $name FAILED" >&2; fi
}
step_if() {  # step_if <tool> "<name>" <cmd...>  — SKIP (or FAIL under --strict-toolchains) when tool absent
  local tool="$1"; local name="$2"; shift 2
  if have "$tool"; then step "$name" "$@"; elif [ "$STRICT" -eq 1 ]; then
    echo ""; echo "  ✖ $name — '$tool' not installed (strict-toolchains)" >&2
    FAIL+=("$name (no $tool, strict)")
  else
    echo ""; echo "── ⊘ $name — SKIPPED ('$tool' not installed) ──" >&2
    SKIP+=("$name (no $tool)")
  fi
}

# ── hygiene.yml: public-repo leak scan (the SECURITY gate kept in CI) ──────────
gate_leak_scan() {
  local base="origin/main"
  git rev-parse --verify -q "$base" >/dev/null 2>&1 || base="HEAD~1"
  bash .githooks/leak-scan.sh "$base"
}

# ── release hygiene: reactor-excluded pom version parity (drift guard) ─────────
gate_pom_versions() { scripts/check-pom-versions.sh; }

# ── toolchain drift: local bun must not lag the hosted workflows' pin ─────────
# The self-hosted lanes use the runner-PATH bun while hosted workflows pin one via
# setup-bun; nothing keeps them in sync, and a stale bun has crashed/stalled these
# lanes with no failing test name. See scripts/check-bun-version.sh.
gate_bun_version() { scripts/check-bun-version.sh; }

# ── conformance.yml — fixture lint + workspace typecheck ──────────────────────
gate_fixture_lint() {
  bun_install && ( cd server/typescript/packages/conformance && bun bin/conformance.ts lint ../../../../fixtures/conformance )
}
# bun_install first: under `--only ts` this gate runs without fixture-lint
# (whose install it historically piggybacked on), so it must install itself.
gate_ts_build_typecheck() { bun_install && bun run --filter '*' build && bun run --filter '*' typecheck; }
# Build only (no typecheck) — the ts-slow lane needs the workspace dist/ to run the
# integration tests, but the typecheck already runs in ts-fast, so don't repeat it.
gate_ts_build() { bun_install && bun run --filter '*' build; }

# migrate-ts real-Postgres suites — apply / lifecycle / rollback / introspection against a
# real engine. ADR-0015 makes migrate-ts the project's ONLY migrate engine, so this is the
# ONLY real-engine gate on migration correctness. The CI ts-slow job supplies
# MIGRATE_TS_PG_URL (its Postgres sidecar) plus MIGRATE_TS_PG_EXPECT=1, which arms an
# in-suite sentinel that fails loudly if that URL ever stops being set. Without those env
# vars (a local run with no Postgres) the PG describes self-skip exactly as before.
gate_migrate_ts_pg() { bun_install && ( cd server/typescript/packages/migrate-ts && bun test ); }

# runtime-ts real-Postgres dialect matrix — the generated CRUD helpers exercised through
# BOTH the Fastify and Hono adapters against a real engine. runtime-ts's own suite runs in
# the ts-unit lane, which has no database, and every adapter test there uses libsql — where
# Drizzle's libsql-only `.all()`/`.get()` work. That is why Hono shipped 500ing on Postgres
# while Fastify (fixed for the same thing) stayed green (#286). Runs here because ts-slow is
# the lane with the sidecar; METAOBJECTS_TEST_PG_URL + RUNTIME_TS_PG_EXPECT=1 come from the
# CI job, and without them the suite self-skips exactly as before.
gate_runtime_ts_pg() {
  bun_install && ( cd server/typescript/packages/runtime-ts && bun test test/dialect-matrix-pg.test.ts )
}

# ── conformance.yml — per-port conformance corpora (exact CI commands) ────────
gate_conf_ts() {
  bun_install || return 1
  ( cd server/typescript/packages/metadata && bun test test/conformance.test.ts test/yaml-conformance.test.ts test/object-model-conformance.test.ts \
      && bun test test/registry-conformance.test.ts test/registry-coverage.test.ts ) || return 1
  ( cd server/typescript/packages/render && bun test test/render-conformance.test.ts test/verify-conformance.test.ts test/extract/extract-conformance.test.ts test/output-prompt-conformance.test.ts ) || return 1
  ( cd server/typescript/packages/integration-tests && bun test test/validation-conformance.test.ts ) || return 1
  ( cd server/typescript/packages/migrate-ts && bun test ) || return 1
  ( cd server/typescript/packages/codegen-ts && bun test ) || return 1
  # --timeout 30000: the cli suite invokes full `meta`/run() dispatch, which lazily
  # imports each command's (sometimes heavy: codegen, migrate-ts) module on first
  # use. On a cold/contended self-hosted runner that first cold-start import can
  # exceed bun's default 5s per-test timeout, flaking otherwise-instant exit-code /
  # --format tests (bunfig.toml `[test] timeout` is NOT honored by bun, so it must
  # be the CLI flag). 30s keeps a real hang loud while removing the timing flake.
  ( cd server/typescript/packages/cli && bun test --timeout 30000 ) || return 1
}
# The per-package TS unit suites that no lane gated until 2026-07-19: the ts-fast
# conformance gate runs only NAMED conformance files in metadata/render, so the rest
# of those suites (and runtime-ts + the client/web packages) ran nowhere — which is
# how a @formExclude regression sat red on `main`. Deliberately its OWN lane rather
# than folded into ts-fast: ts-fast carries the 30-min mutation gate, which flakes
# under runner contention, and a mutation flake must not mask a unit-test failure.
# Measured ~5s total, so the independent signal is nearly free.
# NOTE: per-package `bun test` only — a bare root `bun test` walks java/python/
# csharp/fixtures and takes many minutes.
# --timeout 30000 (same reasoning as gate_cli above; bunfig.toml `[test] timeout`
# is NOT honored by bun, so it must be the CLI flag): this lane has repeatedly
# stalled on the self-hosted runner until the job's 20-minute cap, at a DIFFERENT
# file each time (metadata/index.test.ts, react/currency-input.test.tsx,
# tanstack/grid-from-metadata.test.ts) and never with a failing assertion — so the
# stall is environmental, not one bad test. The whole lane measures ~5s, so any
# single test past 30s is a hang by definition.
#
# SCOPE — do not over-read this mitigation. It converts an IN-TEST hang into a
# named 30s failure. It does NOT interrupt a process-level bun crash or stall,
# which is what was actually observed afterwards: the runner's bun died with
# `Illegal instruction (core dumped)` on one run and wedged past the 20-minute
# job cap on others. A per-test timer cannot fire when the runtime itself is
# gone. If a lane is cancelled at the job timeout with no named test, this flag
# is not the thing that failed — look at the bun runtime on the runner.
gate_ts_unit() {
  bun_install || return 1
  # The client/web browser-bundleability gates (#287) bundle each package's BUILT
  # dist/ for target:browser — testing src/ would not reproduce the bug, because Bun's
  # TEST runner resolves the `bun` export condition to TypeScript source and never
  # bundles. This lane checks out clean, so it must produce that dist/ itself: the
  # workspace build lives in ts-fast, which is a SEPARATE parallel job with its own
  # workspace, so nothing else in this lane's checkout ever creates it. Without this
  # the gates fail their own existsSync precondition on every CI run while passing on
  # any warm developer box — which is exactly what happened the first time they ran.
  # Scoped, not `--filter '*'`: metadata (its `constants` subpath is the fix under test)
  # plus every published browser package. ~3s cold, so the lane stays cheap.
  bun run --filter '@metaobjectsdev/metadata' \
          --filter '@metaobjectsdev/runtime-web' \
          --filter '@metaobjectsdev/react' \
          --filter '@metaobjectsdev/tanstack' \
          --filter '@metaobjectsdev/angular' build || return 1
  # Every server-side TS package whose suite no other lane runs in full. The three
  # originals (metadata/render/runtime-ts) plus, from 2026-08-09, the seven that were
  # gated by NOTHING AT ALL: gate_conf_ts covers migrate-ts / codegen-ts / cli in full
  # and only NAMED conformance files elsewhere, so the tanstack + react + angular
  # codegen packages, sdk (which owns the agent-context conformance corpus), ai-runtime,
  # conformance and docs-site never ran in CI. That is how a red agent-context corpus
  # could reach `main` — and how this very lane's own new tests would have been ungated.
  # ~2s for all seven. `forge` has no tests; `integration-tests` has its own ts-slow lane.
  for p in metadata render runtime-ts \
           codegen-ts-tanstack codegen-ts-react codegen-ts-angular \
           sdk ai-runtime conformance docs-site; do
    ( cd "server/typescript/packages/$p" && bun test --timeout 30000 ) || return 1
  done
  for p in runtime-web react tanstack; do
    ( cd "client/web/packages/$p" && bun test --timeout 30000 ) || return 1
  done
  # @metaobjectsdev/angular is a published browser package with the same runtime-web
  # dependency, so it needs the same #287 bundle gate — but its OTHER test cannot run
  # under Bun at all (`Standard Angular field decorators are not supported in JIT mode`),
  # which is why the package is absent from the loop above. Running the gate BY NAME
  # covers the browser package without pretending the rest of its suite is green; the
  # decorator/JIT problem is a separate, pre-existing gap in Angular test tooling.
  ( cd client/web/packages/angular && bun test --timeout 30000 test/browser-bundleable.test.ts ) || return 1
}
gate_conf_csharp() {
  ( cd server/csharp \
      && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo --verbosity quiet \
      && dotnet test MetaObjects.Render.Tests/MetaObjects.Render.Tests.csproj --nologo --verbosity quiet \
      && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --nologo --verbosity quiet \
      && dotnet test MetaObjects.Cli.Tests/MetaObjects.Cli.Tests.csproj --nologo --verbosity quiet )
}
gate_conf_java() {
  ( cd server/java \
      && mvn -pl metadata,render,codegen-spring -am install -DskipTests -q \
      && mvn -pl metadata test -Dtest='ConformanceTest,YamlConformanceTest,ObjectModelConformanceTest,RegistryManifestConformanceTest' -q \
      && mvn -pl render test -Dtest='RenderCrossPortReportTest,VerifyConformanceTest,ExtractConformanceTest,OutputPromptConformanceTest' -q \
      && mvn -pl codegen-spring test -Dtest='ValidationConformanceTest,GeneratorRegistryConformanceTest' -q )
}
gate_conf_python() {
  # FULL suite, not cherry-picked paths. Until 2026-07-19 this ran only
  # tests/conformance, tests/render and two named codegen files — ~1400 tests
  # (tests/codegen/*, tests/integration/, tests/unit/, …) ran in NO lane, not even
  # nightly, so a red test could sit on `main` under a green `python` lane. Measured
  # cost of the full suite is ~5 min, which buys the port a real gate.
  #
  # --extra integration is REQUIRED: tests/integration/*.py import fastapi/pg8000/
  # httpx at module top-level, which live in [project.optional-dependencies]
  # integration — NOT the default [dependency-groups] dev that `uv run` installs.
  # Without it a fresh-venv `uv run pytest tests/` fails collection with
  # ModuleNotFoundError on 9 modules (it only passed locally where the venv had
  # been synced with the extra by a prior run). This matches every other
  # tests/integration invocation in the repo (scripts/integration-test.sh,
  # docs/CONFORMANCE.md). The PG-backed scenarios connect to the lane's Postgres
  # sidecar via METAOBJECTS_TEST_PG_URL (set in local-ci.yml).
  ( cd server/python && uv run --extra integration pytest tests/ -q )
}
gate_conf_kotlin() {
  ( cd server/java \
      && mvn -pl codegen-kotlin -am install -DskipTests -q \
      && mvn -pl codegen-kotlin test -Dtest='ObjectModelConformanceTest,OutputPromptConformanceTest,ValidationConformanceTest,GeneratorRegistryConformanceTest,RegistryManifestConformanceTest' -q )
}

# ── conformance.yml — full reactor + drift/mutation gates ─────────────────────
# JaCoCo is skipped here: its coverage gate is haltOnFailure=false (pom.xml), so it
# never fails the build — it is pure instrumentation overhead for a pass/fail CI
# signal. `clean` stays: self-hosted workspaces persist and actions/checkout wipes
# only git-tracked state, so a stale target/ can otherwise leak between runs.
gate_java_reactor() { ( cd server/java && mvn -q clean install -Djacoco.skip=true ); }
gate_completeness() { ( cd server/typescript/packages/metadata && bun run conformance:mutation ); }
gate_doc_template_drift() {
  bash scripts/sync-doc-templates.sh \
    && git diff --exit-code -- \
        server/typescript/packages/codegen-ts/templates \
        server/typescript/packages/codegen-ts/src/render-engine/embedded-templates.generated.ts
}
gate_embedded_library_drift() {
  bun run scripts/generate-embedded-library.ts \
    && git diff --exit-code -- server/typescript/packages/metadata/src/library/embedded-library.generated.ts
}

# ── integration-tests.yml (docker) ────────────────────────────────────────────
gate_integration() { scripts/integration-test.sh all; }
gate_integration_port() { scripts/integration-test.sh "$1"; }

run_integration_for() { # run_integration_for "<label>" <runner...>
  local label="$1"; shift
  if docker info >/dev/null 2>&1; then
    local r; for r in "$@"; do step "integration-tests ($r)" gate_integration_port "$r"; done
  elif [ "$STRICT" -eq 1 ]; then
    FAIL+=("integration-tests $label (docker down, strict)")
    echo "  ✖ docker is DOWN — integration ($label) FAILED (strict-toolchains)." >&2
  else
    SKIP+=("integration-tests $label (docker down)")
    echo "  ⊘ docker is DOWN — integration ($label) skipped." >&2
  fi
}

# ── Banner ────────────────────────────────────────────────────────────────────
if [ -n "$ONLY" ]; then
  _mode="only:$(echo "${ONLY# }" | tr ' ' ',')"
elif [ "$QUICK" -eq 1 ]; then
  _mode="quick — TS + drift gates only"
else
  _mode="full — all ports + reactor + docker"
fi
echo "metaobjects local CI  (mode: $_mode)"

# ── Optional dry-run listing ──────────────────────────────────────────────────
# MO_CI_LIST_ONLY=1: print the steps that would run (want + toolchain checks)
# without running them, then exit 0.  Useful for verifying section selection.
if [ "${MO_CI_LIST_ONLY:-0}" = "1" ]; then
  step()    { echo "  + $1"; }
  step_if() { local t="$1" n="$2"; have "$t" && echo "  + $n" || echo "  ⊘ $n (no $t, would skip)"; }
  run_integration_for() { local label="$1"; shift; local r; for r in "$@"; do echo "  + integration-tests ($r)"; done; }
  echo "Steps that would run:"
fi

# ── Step invocations ──────────────────────────────────────────────────────────
# Fast tier: shared gates and TS checks, interleaved in the original order so
# that no-flags execution is byte-equivalent to the pre-refactor script.
if want gates; then step    "leak-scan (security)"             gate_leak_scan;             fi
if want gates; then step    "pom-version parity"               gate_pom_versions;           fi
if want gates; then step    "bun-version parity"               gate_bun_version;            fi
if want gates; then step_if bun "fixture-lint"                 gate_fixture_lint;           fi
# The ts port is split into two lanes so CI can run them as separate jobs (see
# .github/workflows/local-ci.yml): a FAST lane (build+typecheck, conformance,
# completeness — the pure-code correctness signal, no docker) and a SLOW lane
# (docker/sidecar integration). Isolating integration means a docker/sidecar
# hiccup no longer fails the code signal, and vice versa. `--only ts` (and a plain
# local run) still runs both lanes, so it stays byte-equivalent to before.
if want_any ts ts-fast; then step_if bun "ts build + typecheck"         gate_ts_build_typecheck;     fi
if want_any ts ts-fast; then step_if bun "conformance: typescript"      gate_conf_ts;                fi
if want_any ts ts-unit; then step_if bun "ts unit suites"               gate_ts_unit;                fi
if want_any ts ts-fast; then step_if bun "completeness-gate (mutation)" gate_completeness;           fi
if want gates; then step_if bun "doc-template drift"           gate_doc_template_drift;     fi
if want gates; then step_if bun "embedded-library drift"       gate_embedded_library_drift; fi

if [ "$QUICK" -eq 1 ]; then
  echo ""
  echo "── ⊘ --quick: SKIPPING the other-language ports (csharp/java/python/kotlin),"
  echo "        the full Java reactor, and the docker integration suite. Run the full"
  echo "        \`scripts/ci-local.sh\` (no flag) before opening/merging a PR or tagging."
  SKIP+=("csharp/java/python/kotlin conformance (--quick)")
  SKIP+=("java-reactor (--quick)")
  SKIP+=("integration-tests (--quick)")
else
  # Heavy tier — other-language ports + full reactor + docker integration suite.
  #
  # The Java port is split into two lanes so CI can run them as separate jobs
  # (see .github/workflows/local-ci.yml): a FAST lane (java+kotlin conformance,
  # ~2-3m — the correctness signal) and a SLOW lane (full reactor + docker
  # integration). Running them as parallel jobs surfaces the conformance verdict
  # quickly and means a cancel/OOM mid-integration no longer kills the fast
  # signal. `--only java` (local, unqualified) still runs BOTH lanes, in order,
  # so a plain local run is byte-equivalent to before.
  if want csharp;               then step_if dotnet "conformance: csharp"        gate_conf_csharp;  fi
  if want_any java java-fast;   then step_if mvn "conformance: java"             gate_conf_java;    fi
  if want python;               then step_if uv "conformance: python"            gate_conf_python;  fi
  if want_any java java-fast;   then step_if mvn "conformance: kotlin"           gate_conf_kotlin;  fi
  if want_any java java-slow;   then step_if mvn "java-reactor (install)"        gate_java_reactor; fi
  # Docker integration — full suite when no --only, per-port otherwise.
  if [ -z "$ONLY" ]; then
    if docker info >/dev/null 2>&1; then
      step "integration-tests (5-port + docker)" gate_integration
    else
      echo ""; echo "  ✖ docker is DOWN — cannot run the integration suite. Start docker, or use --quick." >&2
      FAIL+=("integration-tests (docker down)")
    fi
  else
    # ts-slow needs the workspace dist/ to run integration. When the fast lane also
    # runs (umbrella `ts` / local full), its build already produced it — only build
    # here when ts-slow runs in isolation (the CI ts-slow job).
    if want_any ts ts-slow && ! want_any ts ts-fast; then step_if bun "ts build (for integration)" gate_ts_build; fi
    # Ordered BEFORE the docker integration step so a container-readiness flake there
    # can never prevent the migrate verdict from being produced.
    want_any ts ts-slow        && step_if bun "migrate-ts real-PG suite" gate_migrate_ts_pg
    want_any ts ts-slow        && step_if bun "runtime-ts real-PG dialect matrix" gate_runtime_ts_pg
    want_any ts ts-slow        && run_integration_for ts     ts
    want_any java java-slow    && run_integration_for java   java kotlin
    want python                && run_integration_for python python
    want csharp                && run_integration_for csharp csharp
  fi
fi

# ── Dry-run listing exits before summary ──────────────────────────────────────
if [ "${MO_CI_LIST_ONLY:-0}" = "1" ]; then exit 0; fi

echo ""
echo "══════════════════════ SUMMARY ══════════════════════"
for p in "${PASS[@]:-}"; do [ -n "${p:-}" ] && echo "  ✓ $p"; done
for s in "${SKIP[@]:-}"; do [ -n "${s:-}" ] && echo "  ⊘ $s"; done
for f in "${FAIL[@]:-}"; do [ -n "${f:-}" ] && echo "  ✖ $f"; done
echo "══════════════════════════════════════════════════════"

if [ "${#FAIL[@]}" -gt 0 ]; then echo "LOCAL CI FAILED — ${#FAIL[@]} gate(s) red." >&2; exit 1; fi
if [ "${#SKIP[@]}" -gt 0 ]; then echo "LOCAL CI PASSED (with ${#SKIP[@]} skipped — see ⊘ above)."; exit 0; fi
echo "LOCAL CI PASSED"
