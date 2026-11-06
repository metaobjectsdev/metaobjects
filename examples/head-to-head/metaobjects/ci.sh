#!/usr/bin/env bash
# The pull-request gate: every check runs, one "CHECK <name> <ok|fail>" line each,
# and the script exits 1 if any failed.
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$PATH" PYTHONPATH="$PWD"
CI_DB="postgresql://postgres:h2h@127.0.0.1:${H2H_PG_PORT}/${H2H_DEV_DB}"
mkdir -p .ci-logs
failed=0
check() {
  local name=$1; shift
  if "$@" >".ci-logs/$name.log" 2>&1; then echo "CHECK $name ok"; else echo "CHECK $name fail"; failed=1; fi
}

# Generated code, prompt templates and requirement links, TypeScript side then Python side.
check meta-verify npx meta verify
check metaobjects-verify metaobjects verify
# Provision a CI database from the committed migrations, then compare it with the model.
check meta-verify-db sh -c "npx meta migrate apply-pending --db '$CI_DB' && npx meta verify --db '$CI_DB'"
check tsc npx tsc -p api
check mypy mypy worker
exit $failed
