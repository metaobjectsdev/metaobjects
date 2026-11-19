#!/usr/bin/env bash
# Compare the live database $H2H_DB with the model.
set -euo pipefail
cd "$(dirname "$0")"
npx meta verify --db "postgresql://postgres:h2h@127.0.0.1:${H2H_PG_PORT}/${H2H_DB}"
