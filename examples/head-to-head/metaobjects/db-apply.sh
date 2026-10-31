#!/usr/bin/env bash
# Apply the committed migrations to $H2H_DB.
set -euo pipefail
cd "$(dirname "$0")"
npx meta migrate apply-pending --db "postgresql://postgres:h2h@127.0.0.1:${H2H_PG_PORT}/${H2H_DB}"
