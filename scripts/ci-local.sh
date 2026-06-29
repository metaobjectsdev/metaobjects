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
#   scripts/ci-local.sh --help
#
# Ports whose toolchain (bun / dotnet / uv / mvn) is not installed are SKIPPED
# with a loud warning (not silently passed). A full pre-release run is expected on
# a machine with every toolchain — otherwise rely on the release-tag CI run.
#
# Mirrors: hygiene.yml (leak-scan) · conformance.yml (fixture-lint, typecheck,
# 5-port conformance, kotlin, java-reactor, completeness-gate, doc-template-drift,
# embedded-library-drift) · integration-tests.yml (5-port suite + migrate-ts-pg).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $arg (see --help)" >&2; exit 2 ;;
  esac
done

PASS=(); FAIL=(); SKIP=()
have() { command -v "$1" >/dev/null 2>&1; }

step() {  # step "<name>" <cmd...>
  local name="$1"; shift
  echo ""
  echo "── ▶ $name ──────────────────────────────────────────────"
  if "$@"; then PASS+=("$name"); else FAIL+=("$name"); echo "  ✖ $name FAILED" >&2; fi
}
step_if() {  # step_if <tool> "<name>" <cmd...>  — SKIP (not fail) when tool absent
  local tool="$1"; local name="$2"; shift 2
  if have "$tool"; then step "$name" "$@"; else
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

# ── conformance.yml — fixture lint + workspace typecheck ──────────────────────
gate_fixture_lint() {
  bun install && ( cd server/typescript/packages/conformance && bun bin/conformance.ts lint ../../../../fixtures/conformance )
}
gate_ts_build_typecheck() { bun run --filter '*' build && bun run --filter '*' typecheck; }

# ── conformance.yml — per-port conformance corpora (exact CI commands) ────────
gate_conf_ts() {
  bun install || return 1
  ( cd server/typescript/packages/metadata && bun test test/conformance.test.ts test/yaml-conformance.test.ts test/object-model-conformance.test.ts \
      && bun test test/registry-conformance.test.ts test/registry-coverage.test.ts ) || return 1
  ( cd server/typescript/packages/render && bun test test/render-conformance.test.ts test/verify-conformance.test.ts test/extract/extract-conformance.test.ts test/output-prompt-conformance.test.ts ) || return 1
  ( cd server/typescript/packages/integration-tests && bun test test/validation-conformance.test.ts ) || return 1
  ( cd server/typescript/packages/migrate-ts && bun test ) || return 1
  ( cd server/typescript/packages/codegen-ts && bun test ) || return 1
  ( cd server/typescript/packages/cli && bun test ) || return 1
}
gate_conf_csharp() {
  ( cd server/csharp \
      && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj --nologo --verbosity quiet \
      && dotnet test MetaObjects.Render.Tests/MetaObjects.Render.Tests.csproj --nologo --verbosity quiet \
      && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --filter "FullyQualifiedName~ValidationConformance" --nologo --verbosity quiet \
      && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --filter "FullyQualifiedName~GeneratorRegistryConformance" --nologo --verbosity quiet \
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
  ( cd server/python \
      && uv run pytest tests/conformance -q \
      && uv run pytest tests/render -q \
      && uv run pytest tests/codegen/test_validation_conformance.py -q \
      && uv run pytest tests/codegen/test_cli_registry.py -q )
}
gate_conf_kotlin() {
  ( cd server/java \
      && mvn -pl codegen-kotlin -am install -DskipTests -q \
      && mvn -pl codegen-kotlin test -Dtest='ObjectModelConformanceTest,OutputPromptConformanceTest,ValidationConformanceTest,GeneratorRegistryConformanceTest,RegistryManifestConformanceTest' -q )
}

# ── conformance.yml — full reactor + drift/mutation gates ─────────────────────
gate_java_reactor() { ( cd server/java && mvn -q clean install ); }
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

echo "metaobjects local CI  (mode: $([ "$QUICK" = 1 ] && echo 'quick — TS + drift gates only' || echo 'full — all ports + reactor + docker'))"

# Fast tier — cheap, TS-centric, single-toolchain (bun). Runs in both modes; this is
# the whole of --quick. (The pre-push hook covers ts build+typecheck on its own.)
step    "leak-scan (security)"             gate_leak_scan
step    "pom-version parity"               gate_pom_versions
step_if bun    "fixture-lint"              gate_fixture_lint
step_if bun    "ts build + typecheck"      gate_ts_build_typecheck
step_if bun    "conformance: typescript"   gate_conf_ts
step_if bun    "completeness-gate (mutation)" gate_completeness
step_if bun    "doc-template drift"        gate_doc_template_drift
step_if bun    "embedded-library drift"    gate_embedded_library_drift

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
  step_if dotnet "conformance: csharp"     gate_conf_csharp
  step_if mvn    "conformance: java"       gate_conf_java
  step_if uv     "conformance: python"     gate_conf_python
  step_if mvn    "conformance: kotlin"     gate_conf_kotlin
  step_if mvn    "java-reactor (clean install)" gate_java_reactor
  if docker info >/dev/null 2>&1; then
    step "integration-tests (5-port + docker)" gate_integration
  else
    echo ""; echo "  ✖ docker is DOWN — cannot run the integration suite. Start docker, or use --quick." >&2
    FAIL+=("integration-tests (docker down)")
  fi
fi

echo ""
echo "══════════════════════ SUMMARY ══════════════════════"
for p in "${PASS[@]:-}"; do [ -n "${p:-}" ] && echo "  ✓ $p"; done
for s in "${SKIP[@]:-}"; do [ -n "${s:-}" ] && echo "  ⊘ $s"; done
for f in "${FAIL[@]:-}"; do [ -n "${f:-}" ] && echo "  ✖ $f"; done
echo "══════════════════════════════════════════════════════"

if [ "${#FAIL[@]}" -gt 0 ]; then echo "LOCAL CI FAILED — ${#FAIL[@]} gate(s) red." >&2; exit 1; fi
if [ "${#SKIP[@]}" -gt 0 ]; then echo "LOCAL CI PASSED (with ${#SKIP[@]} skipped — see ⊘ above)."; exit 0; fi
echo "LOCAL CI PASSED"
