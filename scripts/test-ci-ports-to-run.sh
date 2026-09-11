#!/usr/bin/env bash
# Table-driven test for ci-ports-to-run.sh's pure core.
# Sources the script with MO_PORTS_TEST=1 so no network and no git calls happen,
# then feeds verdict tables straight into the functions.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
MO_PORTS_TEST=1 source scripts/ci-ports-to-run.sh

fails=0
check() { # check "<expected>" "<got>" "<what>"
  if [ "$2" != "$1" ]; then
    echo "FAIL: $3 -> '$2' (expected '$1')" >&2; fails=$((fails+1))
  else
    echo "ok:   $3 -> '$2'"
  fi
}

# ── union_ports: canonical order, deduplicated ────────────────────────────────
check "ts java python csharp" "$(union_ports ts java python csharp)" "union all"
check "ts java python csharp" "$(union_ports csharp python java ts)"  "union reorders to canonical"
check "ts java"               "$(union_ports java ts java ts)"        "union deduplicates"
check "python"                "$(union_ports python)"                 "union single"
check ""                      "$(union_ports)"                        "union empty"
check "ts"                    "$(union_ports ts bogus)"               "union drops unknown tokens"

# ── not_green_ports: newest verdict per lane wins ─────────────────────────────
all_green() {
  printf '%s\tsuccess\n' ts-fast ts-unit ts-slow java-fast java-slow python csharp
}

check "" "$(all_green | not_green_ports)" "every lane green -> nothing to re-run"

# The defect this file exists for: a docs-only run SKIPS the code lanes, so the
# newest run says nothing about them and the verdict must come from the run before.
check "java" "$( { printf '%s\tskipped\n' ts-fast ts-unit ts-slow java-fast java-slow python csharp
                   printf '%s\tsuccess\n' ts-fast ts-unit ts-slow python csharp
                   printf '%s\tfailure\n' java-fast java-slow; } | not_green_ports )" \
      "docs-only run skips a red java -> java still not green"

check "ts" "$( { printf '%s\tsuccess\n' ts-fast ts-unit java-fast java-slow python csharp
                 printf 'ts-slow\tfailure\n'; } | not_green_ports )" \
      "one red ts lane selects the whole ts port"

# `skipped` is walked past, never counted as a verdict — it describes the
# selection, not the code.
check "" "$( { printf 'ts-fast\tskipped\n'
               printf '%s\tsuccess\n' ts-fast ts-unit ts-slow java-fast java-slow python csharp; } | not_green_ports )" \
      "skipped is walked past to the real verdict"

# A lane that was cancelled was never verified. cancel-in-progress makes this
# common, so counting it as green would reopen the hole from the other side.
check "csharp" "$( { printf '%s\tsuccess\n' ts-fast ts-unit ts-slow java-fast java-slow python
                     printf 'csharp\tcancelled\n'; } | not_green_ports )" \
      "cancelled is not green"

# No verdict at all in the window is UNKNOWN, and unknown must widen.
check "python" "$(printf '%s\tsuccess\n' ts-fast ts-unit ts-slow java-fast java-slow csharp | not_green_ports)" \
      "a lane with no verdict in the window is not green"

check "ts java python csharp" "$(printf '' | not_green_ports)" "no history at all -> everything"

# ── the lane map must cover every port-testing job in the workflow ────────────
# A new lane absent from lane_port() would be invisible to the known-green check
# and could sit red forever under green runs — the same defect, one level down.
WF=.github/workflows/local-ci.yml
mapped_missing=""
for job in $(awk '/^jobs:$/{j=1;next} j && /^  [a-z][a-z0-9-]*:$/ { gsub(/[ :]/,""); print }' "$WF"); do
  case "$job" in detect|gates|notify) continue ;; esac
  [ -n "$(lane_port "$job")" ] || mapped_missing="$mapped_missing $job"
done
check "" "${mapped_missing# }" "every port-testing job in $WF is mapped by lane_port"

# ...and no mapped lane may name a job the workflow does not define.
stale=""
for lane in $(all_lanes); do
  grep -qE "^  ${lane}:$" "$WF" || stale="$stale $lane"
done
check "" "${stale# }" "every lane in lane_port exists as a job in $WF"

if [ "$fails" -ne 0 ]; then echo "$fails check(s) failed" >&2; exit 1; fi
echo "all checks passed"
