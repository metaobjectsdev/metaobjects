#!/usr/bin/env bash
# End-to-end probe on a database that already has the committed migrations applied:
# create a customer through the TypeScript API, then render its prompt in the Python worker.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$PWD/.venv/bin:$PATH" PYTHONPATH="$PWD"
export DATABASE_URL="postgresql://postgres:h2h@127.0.0.1:${H2H_PG_PORT}/${H2H_DB}"
id=$(npx tsx api/smoke.ts)
prompt=$(python -m worker.main "$id")
case "$prompt" in
  *"Ada Lovelace"*) ;;
  *) echo "probe: the rendered prompt does not contain the customer's name: $prompt"; exit 1 ;;
esac
