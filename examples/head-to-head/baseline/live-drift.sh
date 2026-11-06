#!/usr/bin/env bash
# Compare the live database $H2H_DB with the committed migrations; non-empty plan = drift.
set -euo pipefail
cd "$(dirname "$0")"
plan=$(./atlas.sh schema diff --exclude atlas_schema_revisions \
  --from "postgres://postgres:h2h@127.0.0.1:5432/${H2H_DB}?sslmode=disable&search_path=public" \
  --to file://atlas/migrations \
  --dev-url "postgres://postgres:h2h@127.0.0.1:5432/${H2H_DEV_DB}?sslmode=disable&search_path=public" 2>/dev/null)
case "$plan" in *"synced"*) exit 0 ;; *) echo "$plan"; exit 1 ;; esac
