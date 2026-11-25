#!/usr/bin/env bash
# Run the fixed task set against one arm's installed skill tree, on your own Claude login
# (no API key). One fresh session per task; answers land in <work-dir>/out/<task>/<label>.md.
#
#   run.sh <label> <arm-tree-dir> <work-dir> [task-glob] [parallel]
#
# <label> names the output file (e.g. A-r1, B-r1). <arm-tree-dir> is build-arm.ts output.
# <work-dir> is the directory mk_tasks.py wrote the task set into.
set -uo pipefail
label="$1"; arm="$2"; here="$(cd "$3" && pwd)"; glob="${4:-*}"; par="${5:-4}"
work="$here/runs"
model="${AB_MODEL:-sonnet}"
[ -z "${ANTHROPIC_API_KEY:-}" ] || { echo "refusing: ANTHROPIC_API_KEY is set (metered)"; exit 2; }
[ -d "$here/tasks" ] || { echo "no task set in $here: run mk_tasks.py $here first"; exit 2; }
mkdir -p "$work" "$here/out"

run_one() {
  local task="$1" tdir="$here/tasks/$1"
  local stack; stack="$(cat "$tdir/stack")"
  local run="$work/$label/$task"
  rm -rf "$run"; mkdir -p "$run/.metaobjects" "$here/out/$task"
  cp -r "$arm/$stack/.claude" "$run/.claude"   # a copy, not a symlink: a link out of the run dir makes every references/ read a permission denial
  cp "$arm/$stack/.metaobjects/AGENTS.md" "$run/.metaobjects/AGENTS.md"
  printf '@.metaobjects/AGENTS.md\n' >"$run/CLAUDE.md"
  cp -r "$here/fixture/." "$run/"
  [ -d "$tdir/files" ] && cp -r "$tdir/files/." "$run/"
  local t0; t0=$(date +%s)
  ( cd "$run" && timeout 900 claude -p "$(cat "$tdir/prompt.md")" \
      --model "$model" --setting-sources project --strict-mcp-config \
      --tools "Skill,Read,Glob,Grep,Write" --permission-mode acceptEdits \
      --no-session-persistence --output-format json >"$run/result.json" 2>"$run/stderr.txt" )
  local rc=$?
  if [ -f "$run/ANSWER.md" ]; then cp "$run/ANSWER.md" "$here/out/$task/$label.md"
  else printf '(no ANSWER.md written; rc=%s)\n' "$rc" >"$here/out/$task/$label.md"; fi
  python3 - "$run/result.json" "$task" "$label" "$rc" "$(( $(date +%s) - t0 ))" >>"$here/out/usage.tsv" <<'PY'
import json, sys
p, task, label, rc, secs = sys.argv[1:]
try:
    r = json.load(open(p))
    u = r.get("usage", {})
    print("\t".join(map(str, [task, label, rc, r.get("num_turns"), u.get("input_tokens", 0)
        + u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0),
        u.get("output_tokens"), r.get("duration_api_ms"), secs, r.get("is_error")])))
except Exception as e:
    print("\t".join([task, label, rc, "?", "?", "?", "?", secs, f"unreadable result: {e}"]))
PY
  echo "done $task $label rc=$rc"
}
export -f run_one; export here label arm work model

ls "$here/tasks" | grep -E "^${glob//\*/.*}$" | xargs -P "$par" -I{} bash -c 'run_one {}'
