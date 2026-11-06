#!/usr/bin/env bash
# The pull-request gate: every check runs, one "CHECK <name> <ok|fail>" line each,
# and the script exits 1 if any failed.
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$PATH" PYTHONPATH="$PWD"
DEV_URL="postgres://postgres:h2h@127.0.0.1:5432/${H2H_DEV_DB}?sslmode=disable&search_path=public"
mkdir -p .ci-logs
failed=0
check() {
  local name=$1; shift
  if "$@" >".ci-logs/$name.log" 2>&1; then echo "CHECK $name ok"; else echo "CHECK $name fail"; failed=1; fi
}

generated_in_sync() { ./gen.sh && git diff --exit-code -- generated && [ -z "$(git status --porcelain -- generated)" ]; }
api_compat() {
  docker run --rm -v "$PWD":/w -w /w tufin/oasdiff:v1.35.0 breaking \
    contract/released/openapi.yaml generated/openapi.yaml --fail-on ERR
}
atlas_in_sync() {
  ./atlas.sh migrate validate --env ci --var dev_url="$DEV_URL" &&
    ./atlas.sh migrate diff ci_sync_check --env ci --var dev_url="$DEV_URL" &&
    [ -z "$(git status --porcelain -- atlas/migrations)" ]
}
atlas_lint() { ./atlas.sh migrate lint --env ci --latest 1 --var dev_url="$DEV_URL"; }

check generated-in-sync generated_in_sync
check api-compat api_compat
check atlas-migrations atlas_in_sync
check atlas-lint atlas_lint
check tsc npx tsc -p api
check mypy mypy worker tests
check prompt-render pytest -q tests
exit $failed
