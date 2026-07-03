# Local CI via Self-Hosted Runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every push to `main` triggers, within seconds and at zero Actions cost, a parallel affected-ports test run on a repo-scoped self-hosted runner, with a nightly/dispatch full matrix and a desktop notification on failure.

**Architecture:** A `detect` job maps the pushed paths to a port set via a new `scripts/ci-affected-ports.sh`; per-port jobs each call the existing `scripts/ci-local.sh` through new `--only <port>` / `--strict-toolchains` flags (single source of truth for gate content); N side-by-side runner instances provide job-level parallelism. No `pull_request` trigger ever targets the runner (public-repo safety).

**Tech Stack:** GitHub Actions self-hosted runners (systemd services), bash, existing `ci-local.sh` / `integration-test.sh`.

**Spec:** `docs/superpowers/specs/2026-07-02-local-ci-self-hosted-runner-design.md`

## Global Constraints

- **Public repo:** nothing committed may contain personal names, machine hostnames, or absolute home paths (`.githooks/pre-commit` enforces; use `$HOME`/placeholders in docs).
- **No `pull_request` trigger** on any workflow with `runs-on: [self-hosted, ...]` — push-to-`main`, `schedule`, `workflow_dispatch` only.
- `actions/checkout` in self-hosted jobs sets `persist-credentials: false`.
- Existing `ci-local.sh` behavior with no new flags must be byte-for-byte unchanged (it is documented in workflow comments and CLAUDE.md).
- Untrusted text (`github.event.head_commit.message`) reaches `run:` blocks only via `env:`, never by direct `${{ }}` interpolation.
- The shared checkout may be on another session's branch — do all work in an isolated worktree based on `origin/main` and push via `git push origin HEAD:main`.

---

### Task 1: Fix the two red cli tests on `main`

`main` currently fails 2 tests (verified in a fresh worktree after `bun install && bun run --filter '*' build`):

- `packages/cli/test/docs-command.test.ts:274` — `meta docs — standalone neutral metadata docs > loads metaobjects.config.ts providers so custom types resolve` — the command exits non-zero, test expects 0.
- `packages/cli/test/migrate-ux.test.ts:260` — `detectPackageManager > returns bun as default when no lockfile is found` — returns something other than `"bun"`.

**Files:**
- Modify: whatever the diagnosis implicates under `server/typescript/packages/cli/` (implementation `src/` or the tests themselves if the tests embed a wrong environmental assumption).
- Test: `server/typescript/packages/cli/test/docs-command.test.ts`, `server/typescript/packages/cli/test/migrate-ux.test.ts`

**Interfaces:**
- Produces: a green `cd server/typescript && bun test` (excluding docker-dependent integration tests if docker is down) — required before the runner gate goes live.

- [ ] **Step 1: Reproduce both failures in isolation**

```bash
cd server/typescript/packages/cli
bun test test/docs-command.test.ts -t "loads metaobjects.config.ts providers"
bun test test/migrate-ux.test.ts -t "returns bun as default"
```
Expected: both FAIL. Capture the full error output (the docs-command test prints the CLI's stderr on failure; if it doesn't, temporarily add `console.error` of the captured stderr in the test to see the real error).

- [ ] **Step 2: Diagnose using superpowers:systematic-debugging**

For `detectPackageManager`: read its implementation (grep `detectPackageManager` under `packages/cli/src/`), determine what it returns for an empty temp dir and why (environment variable? lockfile discovered in an ancestor of the tmp dir? `npm_config_user_agent`?). For `docs-command`: run the same invocation the test makes by hand against the test fixture dir and read the actual stderr.

- [ ] **Step 3: Decide root-cause class and fix**

Two legitimate outcomes, either is acceptable:
- Product bug → fix the implementation (TDD: the failing test already exists).
- Environmental assumption in the test (e.g. it inherits `npm_config_user_agent` from the invoking shell, or resolves lockfiles above the tmp dir) → harden the test to control that input explicitly, AND note it — the self-hosted runner is exactly the kind of "different environment" these assumptions break in.

Check `git log --oneline -5 -- <implicated file>` first: if a recent commit broke it, prefer fixing forward with that context.

- [ ] **Step 4: Verify both tests pass, then the full cli + sdk packages**

```bash
cd server/typescript/packages/cli && bun test
cd ../sdk && bun test
```
Expected: PASS (0 fail).

- [ ] **Step 5: Run the whole server suite to confirm no collateral**

```bash
cd server/typescript && bun test
```
Expected: 0 fail (docker-dependent tests may skip if docker is down — skips are fine, fails are not).

- [ ] **Step 6: Commit**

```bash
git add -A server/typescript/packages/cli server/typescript/packages/sdk
git commit -m "fix(cli): repair the two red tests on main (docs-command provider load, detectPackageManager default)"
```
(Adjust message to the actual root cause found.)

---

### Task 2: `scripts/ci-affected-ports.sh` — path→port mapping

**Files:**
- Create: `scripts/ci-affected-ports.sh`
- Create: `scripts/test-ci-affected-ports.sh` (table-driven test, runs in seconds, no network)

**Interfaces:**
- Produces: `scripts/ci-affected-ports.sh <base-sha> <head-sha>` → prints a single line, a space-separated subset of `ts java python csharp` (empty line = gates-only/docs-only push). Unknown base (all-zero SHA from a force-push) or any unmapped path → all four ports (fail open).

- [ ] **Step 1: Write the table-driven test**

```bash
cat > scripts/test-ci-affected-ports.sh <<'EOF'
#!/usr/bin/env bash
# Table-driven test for ci-affected-ports.sh's mapping function.
# Sources the script with MO_AFFECTED_TEST=1 so no git calls happen, then
# feeds path lists straight into map_paths_to_ports.
set -euo pipefail
cd "$(dirname "$0")/.."
MO_AFFECTED_TEST=1 source scripts/ci-affected-ports.sh

fails=0
check() { # check "<expected ports>" <path...>
  local expected="$1"; shift
  local got; got="$(map_paths_to_ports "$@")"
  if [ "$got" != "$expected" ]; then
    echo "FAIL: [$*] -> '$got' (expected '$expected')" >&2; fails=$((fails+1))
  else
    echo "ok:   [$*] -> '$got'"
  fi
}

check "ts"                    "server/typescript/packages/cli/src/x.ts"
check "ts"                    "client/web/packages/react/src/y.tsx"
check "java"                  "server/java/metadata/src/main/java/A.java"
check "java"                  "server/java/codegen-kotlin/src/main/kotlin/B.kt"
check "python"                "server/python/src/metaobjects/loader.py"
check "csharp"                "server/csharp/MetaObjects/Loader.cs"
check "ts java python csharp" "fixtures/conformance/foo/meta.json"
check "ts java python csharp" "spec/metamodel.md"
check "ts java python csharp" "scripts/ci-local.sh"
check "ts java python csharp" ".github/workflows/local-ci.yml"
check "ts java python csharp" "agent-context/skills/x.md"
check "ts java python csharp" "weird-new-toplevel/file.txt"     # unmapped -> fail open
check ""                      "docs/features/cli.md"             # docs-only -> gates only
check ""                      "README.md" "CHANGELOG.md"         # md-only -> gates only
check "ts python"             "server/typescript/a.ts" "server/python/b.py"
check "ts java python csharp" "docs/x.md" "fixtures/y.json"      # mixed: fixtures wins

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails failure(s)"; exit 1; }
EOF
chmod +x scripts/test-ci-affected-ports.sh
```

- [ ] **Step 2: Run it to verify it fails**

```bash
scripts/test-ci-affected-ports.sh
```
Expected: FAIL — `ci-affected-ports.sh` doesn't exist yet.

- [ ] **Step 3: Implement the script**

```bash
cat > scripts/ci-affected-ports.sh <<'EOF'
#!/usr/bin/env bash
# Map a pushed commit range to the set of language ports local-ci must test.
#
# Usage: scripts/ci-affected-ports.sh <base-sha> <head-sha>
# Prints a space-separated subset of: ts java python csharp
# (empty output = docs-only push: run only the cheap shared gates).
#
# Fail-open policy: an unknown base (force-push zeros), an unresolvable
# range, or ANY path not matched by a rule selects ALL ports — this script
# may only ever shrink coverage when it is certain.
set -uo pipefail

ALL="ts java python csharp"

map_paths_to_ports() { # args: changed paths; echoes the port set
  local p sel_ts=0 sel_java=0 sel_python=0 sel_csharp=0
  for p in "$@"; do
    case "$p" in
      server/typescript/*|client/web/*)   sel_ts=1 ;;
      server/java/*)                      sel_java=1 ;;
      server/python/*)                    sel_python=1 ;;
      server/csharp/*)                    sel_csharp=1 ;;
      fixtures/*|spec/*|scripts/*|.github/*|agent-context/*)
                                          echo "$ALL"; return 0 ;;
      docs/*|*.md)                        : ;;   # gates only
      *)                                  echo "$ALL"; return 0 ;;  # fail open
    esac
  done
  local out=""
  [ "$sel_ts" -eq 1 ]     && out="$out ts"
  [ "$sel_java" -eq 1 ]   && out="$out java"
  [ "$sel_python" -eq 1 ] && out="$out python"
  [ "$sel_csharp" -eq 1 ] && out="$out csharp"
  echo "${out# }"
}

# Test seam: `MO_AFFECTED_TEST=1 source` exposes map_paths_to_ports only.
[ "${MO_AFFECTED_TEST:-0}" = "1" ] && return 0

BASE="${1:-}"; HEAD="${2:-HEAD}"
if [ -z "$BASE" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ] \
   || ! git rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1; then
  echo "$ALL"; exit 0
fi
CHANGED="$(git diff --name-only "$BASE" "$HEAD")" || { echo "$ALL"; exit 0; }
[ -z "$CHANGED" ] && { echo ""; exit 0; }
# shellcheck disable=SC2086
mapfile -t paths <<<"$CHANGED"
map_paths_to_ports "${paths[@]}"
EOF
chmod +x scripts/ci-affected-ports.sh
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
scripts/test-ci-affected-ports.sh
```
Expected: `ALL PASS`. Also sanity-check the git path: `scripts/ci-affected-ports.sh HEAD~1 HEAD` prints a plausible set for the latest commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-affected-ports.sh scripts/test-ci-affected-ports.sh
git commit -m "feat(ci): affected-port mapping script for local-ci (fail-open, table-tested)"
```

---

### Task 3: `ci-local.sh` — `--only <port|gates>` and `--strict-toolchains`

**Files:**
- Modify: `scripts/ci-local.sh`

**Interfaces:**
- Consumes: `scripts/integration-test.sh <ts|csharp|java|python|kotlin>` (already exists).
- Produces: `scripts/ci-local.sh --only <gates|ts|java|python|csharp> [--only ...] [--strict-toolchains]`. No flags → identical behavior to today (including `--quick`). `--only` may repeat; `--only` + `--quick` is an error (exit 2). Section mapping:
  - `gates` → leak-scan, pom-version parity, fixture-lint, doc-template drift, embedded-library drift
  - `ts` → ts build+typecheck, conformance:ts, completeness-gate, `integration-test.sh ts`
  - `java` → conformance:java, conformance:kotlin, java-reactor, `integration-test.sh java` + `kotlin`
  - `python` → conformance:python, `integration-test.sh python`
  - `csharp` → conformance:csharp, `integration-test.sh csharp`
  - `--strict-toolchains` → a missing toolchain (or docker down) is a FAIL, not a SKIP.

- [ ] **Step 1: Extend arg parsing and helpers**

In the `for arg` loop, `--only` needs a value, so switch to a `while` loop over `"$@"`:

```bash
QUICK=0; STRICT=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --strict-toolchains) STRICT=1 ;;
    --only) shift; case "${1:-}" in
        gates|ts|java|python|csharp) ONLY="$ONLY ${1}" ;;
        *) echo "--only expects gates|ts|java|python|csharp, got '${1:-}'" >&2; exit 2 ;;
      esac ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$ONLY" ] && [ "$QUICK" -eq 1 ] && { echo "--only and --quick are mutually exclusive" >&2; exit 2; }

want() { # want <section> — true when the section should run
  [ -z "$ONLY" ] && return 0
  case " $ONLY " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
```

And make `step_if` honor strict mode:

```bash
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
```

- [ ] **Step 2: Add a per-port integration gate and guard every step with `want`**

```bash
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
```

Then restructure the invocation section (existing gate functions unchanged):

```bash
if want gates; then
  step    "leak-scan (security)"        gate_leak_scan
  step    "pom-version parity"          gate_pom_versions
  step_if bun "fixture-lint"            gate_fixture_lint
  step_if bun "doc-template drift"      gate_doc_template_drift
  step_if bun "embedded-library drift"  gate_embedded_library_drift
fi
if want ts; then
  step_if bun "ts build + typecheck"       gate_ts_build_typecheck
  step_if bun "conformance: typescript"    gate_conf_ts
  step_if bun "completeness-gate (mutation)" gate_completeness
fi
if [ "$QUICK" -eq 1 ]; then
  ... existing --quick skip block unchanged ...
else
  if want csharp; then step_if dotnet "conformance: csharp" gate_conf_csharp; fi
  if want java;   then
    step_if mvn "conformance: java"   gate_conf_java
    step_if mvn "conformance: kotlin" gate_conf_kotlin
    step_if mvn "java-reactor (clean install)" gate_java_reactor
  fi
  if want python; then step_if uv "conformance: python" gate_conf_python; fi
  # docker integration — per selected port when --only, the full suite otherwise
  if [ -z "$ONLY" ]; then
    ... existing gate_integration block unchanged (docker check + `integration-test.sh all`) ...
  else
    want ts     && run_integration_for ts ts
    want java   && run_integration_for java java kotlin
    want python && run_integration_for python python
    want csharp && run_integration_for csharp csharp
  fi
fi
```

IMPORTANT preservation notes: keep the original `--quick` early-tier semantics (the fast tier runs unguarded today in both modes — under `--only` it must NOT run unless its section is selected); keep the summary block untouched; keep the leak-scan/pom steps exactly as-is inside `want gates`. Update the header usage comment (lines 12–27) to document the two new flags.

- [ ] **Step 3: Verify default behavior is unchanged**

```bash
bash -n scripts/ci-local.sh                    # syntax
scripts/ci-local.sh --help                     # shows new flags
scripts/ci-local.sh --quick                    # full fast tier, same steps as before this change
```
Expected: `--quick` output lists the same PASS/SKIP step names as on `origin/main` before this task (compare by eye or diff the SUMMARY block).

- [ ] **Step 4: Verify the new flags**

```bash
scripts/ci-local.sh --only gates               # only the 5 shared gates run
scripts/ci-local.sh --only python              # python conformance + python integration only
PATH="/usr/bin:/bin" scripts/ci-local.sh --only python --strict-toolchains; echo "exit=$?"
```
Expected: first two run exactly the mapped sections; third FAILS (exit 1) with `(no uv, strict)` in the summary rather than skipping. Also `scripts/ci-local.sh --only ts --quick` → exit 2 with the mutual-exclusion message.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci-local.sh
git commit -m "feat(ci): ci-local.sh --only <port|gates> + --strict-toolchains for the self-hosted gate"
```

---

### Task 4: `.github/workflows/local-ci.yml`

**Files:**
- Create: `.github/workflows/local-ci.yml`

**Interfaces:**
- Consumes: `scripts/ci-affected-ports.sh` (Task 2), `scripts/ci-local.sh --only ... --strict-toolchains` (Task 3).
- Produces: the workflow; inert until runners with labels `[self-hosted, linux]` are registered (Task 5).

- [ ] **Step 1: Write the workflow**

```yaml
# Local CI — runs on the maintainer's self-hosted runner at ZERO Actions cost.
#
# SECURITY (public repo + self-hosted runner): this workflow must NEVER gain a
# `pull_request` trigger. Push events to main can only come from users with
# write access, so fork-submitted code cannot reach the runner. Keep it that way.
#
# Tiers:
#   push to main        -> affected ports only (scripts/ci-affected-ports.sh)
#   nightly + dispatch  -> full matrix
name: local-ci
on:
  push:
    branches: [main]
  schedule:
    - cron: '17 8 * * *'
  workflow_dispatch:
    inputs:
      tier:
        description: 'full = all ports; affected = ports touched by HEAD~1..HEAD'
        type: choice
        options: [full, affected]
        default: full

concurrency:
  group: local-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  detect:
    runs-on: [self-hosted, linux]
    outputs:
      ports: ${{ steps.sel.outputs.ports }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - id: sel
        env:
          BASE: ${{ github.event.before }}
        run: |
          if [ "${{ github.event_name }}" = "push" ]; then
            ports="$(scripts/ci-affected-ports.sh "$BASE" "$GITHUB_SHA")"
          elif [ "${{ github.event_name }}" = "workflow_dispatch" ] && [ "${{ inputs.tier }}" = "affected" ]; then
            ports="$(scripts/ci-affected-ports.sh "$GITHUB_SHA~1" "$GITHUB_SHA")"
          else
            ports="ts java python csharp"
          fi
          echo "selected ports: '$ports'"
          echo "ports=$ports" >> "$GITHUB_OUTPUT"

  gates:
    needs: detect
    runs-on: [self-hosted, linux]
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # leak-scan diffs against origin/main
          persist-credentials: false
      - run: scripts/ci-local.sh --only gates --strict-toolchains

  ts:
    needs: detect
    if: contains(needs.detect.outputs.ports, 'ts')
    runs-on: [self-hosted, linux]
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: scripts/ci-local.sh --only ts --strict-toolchains

  java:
    needs: detect
    if: contains(needs.detect.outputs.ports, 'java')
    runs-on: [self-hosted, linux]
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: scripts/ci-local.sh --only java --strict-toolchains

  python:
    needs: detect
    if: contains(needs.detect.outputs.ports, 'python')
    runs-on: [self-hosted, linux]
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: scripts/ci-local.sh --only python --strict-toolchains

  csharp:
    needs: detect
    if: contains(needs.detect.outputs.ports, 'csharp')
    runs-on: [self-hosted, linux]
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - run: scripts/ci-local.sh --only csharp --strict-toolchains

  notify:
    needs: [detect, gates, ts, java, python, csharp]
    if: always() && contains(needs.*.result, 'failure')
    runs-on: [self-hosted, linux]
    steps:
      - env:
          # env-indirection: head_commit.message is untrusted text — never
          # interpolate ${{ }} directly into the script body.
          HEAD_MSG: ${{ github.event.head_commit.message }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
          notify-send -u critical "local-ci FAILED: metaobjects" \
            "$(printf '%s' "$HEAD_MSG" | head -n1)
          $RUN_URL" || echo "notify-send unavailable; GitHub email still fires"
```

- [ ] **Step 2: Validate**

```bash
command -v actionlint >/dev/null && actionlint .github/workflows/local-ci.yml || bun x yaml-lint .github/workflows/local-ci.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/local-ci.yml')); print('yaml ok')"
```
Expected: no errors (at minimum the YAML parses; actionlint if available catches expression mistakes).

- [ ] **Step 3: Commit** (workflow is inert until runners exist — safe to land)

```bash
git add .github/workflows/local-ci.yml
git commit -m "ci: local-ci workflow — affected-port push gate + nightly full matrix on self-hosted runner"
```

---

### Task 5: Register runner instances + repo policy (machine-local, nothing committed)

**Files:** none in the repo. Everything here lives under `$HOME/actions-runners/` on the runner machine.

**Interfaces:**
- Consumes: `gh` CLI authenticated with admin on the repo.
- Produces: 4 online runners labeled `self-hosted, linux` scoped to this repo, running as systemd services; Actions fork-PR approval policy tightened.

- [ ] **Step 1: Verify toolchains available to a login shell**

```bash
for t in bun mvn dotnet uv git; do command -v $t || echo "MISSING: $t"; done
docker info >/dev/null && echo docker-ok
```
Expected: all found. If any binary lives in a shell-profile-only PATH (e.g. `~/.bun/bin`), note it — the runner snapshots PATH at `config.sh` time into its `.path` file, so run registration from a shell where every toolchain resolves.

- [ ] **Step 2: Download and register 4 runner instances**

```bash
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
VER="$(gh api repos/actions/runner/releases/latest -q .tag_name | sed 's/^v//')"
mkdir -p "$HOME/actions-runners" && cd "$HOME/actions-runners"
curl -sL -o runner.tgz "https://github.com/actions/runner/releases/download/v${VER}/actions-runner-linux-x64-${VER}.tar.gz"
for i in 1 2 3 4; do
  mkdir -p "runner-$i" && tar xzf runner.tgz -C "runner-$i"
  TOKEN="$(gh api -X POST "repos/$REPO/actions/runners/registration-token" -q .token)"
  ( cd "runner-$i" && ./config.sh --url "https://github.com/$REPO" --token "$TOKEN" \
      --name "local-$i" --labels linux --unattended )
done
```
Expected: each `config.sh` prints "Runner successfully added". (`self-hosted` label is applied automatically; we add `linux` explicitly to match `runs-on`.)

- [ ] **Step 3: Install as systemd services**

```bash
for i in 1 2 3 4; do
  ( cd "$HOME/actions-runners/runner-$i" && sudo ./svc.sh install "$USER" && sudo ./svc.sh start )
done
gh api repos/$REPO/actions/runners -q '.runners[] | "\(.name) \(.status)"'
```
Expected: 4 runners, all `online`.

- [ ] **Step 4: Tighten the fork-PR approval policy (defense-in-depth)**

```bash
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors \
  || echo "endpoint unavailable — set it in the web UI: Settings > Actions > General > 'Require approval for all outside collaborators'"
```
Expected: 204, or fall back to the UI instruction.

- [ ] **Step 5: Smoke-test with a dispatch**

```bash
gh workflow run local-ci -f tier=affected
sleep 20 && gh run list --workflow=local-ci --limit 1
```
Expected: a run appears and jobs get picked up by the `local-*` runners (visible via `gh run view <id>`). `tier=affected` on the current docs-heavy HEAD keeps this smoke run short.

---

### Task 6: End-to-end verification, timing measurement, deliberate-red notify test

**Files:**
- Modify: `.github/workflows/local-ci.yml` (record real measured timings in the header comment)

- [ ] **Step 1: Full-tier run + record timings**

```bash
gh workflow run local-ci -f tier=full
# wait for completion:
gh run watch "$(gh run list --workflow=local-ci --limit 1 --json databaseId -q '.[0].databaseId')"
gh run view "$(gh run list --workflow=local-ci --limit 1 --json databaseId -q '.[0].databaseId')" --json jobs -q '.jobs[] | "\(.name): \(.startedAt) -> \(.completedAt)"'
```
Expected: all jobs green. Compute per-job wall-clock; append a comment line to the workflow header, e.g. `# Measured 2026-07-XX: gates 2m · ts 9m · java 14m · python 6m · csharp 7m (full tier, warm caches)`. Commit that one-line change (`ci: record measured local-ci timings`).

- [ ] **Step 2: Verify the desktop notification fires on red**

Cheapest honest test — run the notify step's exact command by hand first, then force a real red run: dispatch `tier=affected` from a commit... a real red requires a failing gate, so instead temporarily stop runner acceptance is NOT valid (that queues, not fails). Do this: on the runner machine run the notify command manually to prove the popup path works:

```bash
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
notify-send -u critical "local-ci FAILED: metaobjects" "manual plumbing test"
```
Expected: popup appears. THEN rely on the first genuine red push to confirm end-to-end (the workflow path is identical; only the trigger differs). If a synthetic end-to-end red is wanted anyway: `gh workflow run local-ci -f tier=full` while docker is stopped — `--strict-toolchains` turns docker-down into a FAIL, the notify job must fire; restart docker afterwards and re-dispatch green.

- [ ] **Step 3: Probe a real push (affected tier)**

Land the Task 6 timing-comment commit (a `.github/**` path → maps to ALL ports — good full-coverage probe); confirm in `gh run list` that the push-triggered run selected all ports. Then observe the next docs-only or single-port push from normal work and confirm the selection narrows.

---

### Task 7: Documentation — CLAUDE.md gate topology + workflow cross-references

**Files:**
- Modify: `CLAUDE.md` (the stale "still required on PRs via branch protection" claim in the pre-push-hook section)
- Modify: `.github/workflows/conformance.yml` + `integration-tests.yml` (header comments: mention local-ci now covers push-to-main)
- Modify: `scripts/ci-local.sh` header usage comment (if not already done in Task 3)

- [ ] **Step 1: Fix CLAUDE.md**

Replace the sentence in the pre-push section: `The Java/C#/Python compile+conformance gates stay CI-only (still required on PRs via branch protection).` with:

```
The Java/C#/Python compile+conformance gates do NOT run on PRs (hosted CI runs
them on release tags + manual dispatch only, for cost). Instead, every push to
`main` triggers `local-ci.yml` on the maintainer's self-hosted runner: affected
ports only (via `scripts/ci-affected-ports.sh`), parallel per-port jobs, each
running `scripts/ci-local.sh --only <port> --strict-toolchains`; a nightly
dispatch runs the full matrix. PRs get the leak-scan only — run
`scripts/ci-local.sh --quick` locally before opening one.
```

- [ ] **Step 2: Update the two hosted workflow header comments**

In `conformance.yml` and `integration-tests.yml`, extend the existing COST comment with one line: `# Push-to-main coverage now comes from local-ci.yml on the self-hosted runner.`

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md .github/workflows/conformance.yml .github/workflows/integration-tests.yml
git commit -m "docs: describe the actual CI gate topology (local-ci on push, hosted on tags)"
```

---

## Self-Review

- **Spec coverage:** runner topology → T5; workflow triggers/concurrency/detect/per-port/notify → T4; change→port mapping (incl. fail-open + docs-only) → T2; `--only`/`--strict-toolchains` → T3; security (no PR trigger, persist-credentials, fork policy, env-indirection) → T4/T5; timing measurement → T6; CLAUDE.md rollout step → T7; green-main precondition → T1. No gaps.
- **Placeholder scan:** none — every code step carries the code; T1 is a diagnosis task with explicit repro commands and acceptance criteria.
- **Type consistency:** port tokens are `ts java python csharp` (+`gates`) everywhere: mapping script output, `--only` values, workflow job names/`contains()` checks.
