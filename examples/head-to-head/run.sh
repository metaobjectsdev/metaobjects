#!/usr/bin/env bash
# Run the drift scenarios against both setups. A full run writes SCORECARD.md.
# Needs Docker (Postgres, Atlas and oasdiff run as pinned images), Node.js 20+, uv and git.
#   ./run.sh              all scenarios, rewrites SCORECARD.md
#   ./run.sh S1 S6        only these (the S0 control always runs); prints, does not write SCORECARD.md
set -euo pipefail
exec python3 "$(dirname "$0")/harness/run.py" "$@"
