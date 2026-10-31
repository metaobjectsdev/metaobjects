#!/usr/bin/env bash
# Run every drift scenario against both setups and write SCORECARD.md.
# Needs Docker (Postgres, Atlas and oasdiff run as pinned images), Node.js 20+, uv and git.
#   ./run.sh              all scenarios
#   ./run.sh S1 S6        only these (the S0 control always runs)
set -euo pipefail
exec python3 "$(dirname "$0")/harness/run.py" "$@"
