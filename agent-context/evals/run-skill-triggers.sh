#!/usr/bin/env bash
# Run the skill trigger evaluation (agent-context/evals/skill-triggers) with `claude plugin eval`.
# Manual, not CI: it drives real model sessions on your own Claude login (subscription quota).
#
# usage: agent-context/evals/run-skill-triggers.sh [OUT_DIR] [extra `claude plugin eval` flags]
#   OUT_DIR defaults to a fresh temp dir; the scored result is written to OUT_DIR/result.json.
#   e.g. agent-context/evals/run-skill-triggers.sh /tmp/triggers --case 'metaobjects-codegen/*'
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skills="$here/../skills"
out="${1:-$(mktemp -d)}"; [ $# -gt 0 ] && shift
mkdir -p "$out"
plugin="$out/plugin"
rm -rf "$plugin"
mkdir -p "$plugin/.claude-plugin"
# `claude plugin eval` refuses an evals/ link that points outside the plugin, so copy.
echo '{"name":"mo-skills","version":"0.0.0","description":"MetaObjects skills, wrapped for trigger evaluation"}' >"$plugin/.claude-plugin/plugin.json"
cp -R "$skills" "$plugin/skills"
cp -R "$here/skill-triggers" "$plugin/evals"
cd "$plugin"
# --ablation none: one arm, so the `tool_used: Skill` graders count toward the score.
exec claude plugin eval . --ablation none --no-publish --trust-plugin -j 4 --threshold 0 \
  --output-dir "$out/runs" --json "$out/result.json" "$@"
