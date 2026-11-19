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
check "rust"                  "server/rust/metaobjects/src/loader.rs"
check "ts java python csharp rust" "fixtures/conformance/foo/meta.json"
check "ts java python csharp rust" "spec/metamodel.md"
check "ts java python csharp rust" "scripts/ci-local.sh"
check "ts java python csharp rust" ".github/workflows/local-ci.yml"
check "ts java python csharp rust" "agent-context/skills/x.md"
check "ts java python csharp rust" "weird-new-toplevel/file.txt"     # unmapped -> fail open
check "ts java python csharp rust" "docs/recipes/generators/python/json_schema.py"  # executed by port tests -> not docs
check "ts java python csharp rust" "docs/features/cli.md"             # port tests read docs/ -> all
check ""                      "README.md" "CHANGELOG.md"         # md-only -> gates only
check "ts python"             "server/typescript/a.ts" "server/python/b.py"
check "ts java python csharp rust" "docs/x.md" "fixtures/y.json"      # mixed: fixtures wins

[ "$fails" -eq 0 ] && echo "ALL PASS" || { echo "$fails failure(s)"; exit 1; }
