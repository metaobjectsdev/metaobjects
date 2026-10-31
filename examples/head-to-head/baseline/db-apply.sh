#!/usr/bin/env bash
# Apply the committed migrations to $H2H_DB.
set -euo pipefail
cd "$(dirname "$0")"
./atlas.sh migrate apply --dir file://atlas/migrations \
  --url "postgres://postgres:h2h@127.0.0.1:5432/${H2H_DB}?sslmode=disable&search_path=public"
