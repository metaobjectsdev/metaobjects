#!/usr/bin/env bash
# Every container a test starts through the docker CLI must carry its reaper label, because the
# label is the only thing that gets a container removed when its run is killed. A helper that
# forgets it still passes every test and leaks one container per killed run, so nothing but this
# gate would notice. Offline: it reads tracked files and never talks to docker.
#
# Sanctioned forms: Java and Kotlin build the command with ReaperLabels.dockerRun, TypeScript
# spreads reaperLabelArgs() or the `labels` it returned, and Python spreads reaper_label_args().
# The C# suite starts containers through Testcontainers itself, which labels them.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
while IFS=: read -r file line text; do
  case "$file" in
    */ReaperLabels.java|*/ReaperLabels.kt) continue ;;
  esac
  case "$text" in
    *reaperLabelArgs*|*reaper_label_args*|*'...labels'*) continue ;;
  esac
  echo "::error file=$file,line=$line::docker container or network started without a reaper label: ${text#"${text%%[![:space:]]*}"}"
  fail=1
done < <(git grep -nE '"run", "-d"|"network", "create"' -- 'server/*' 'client/*' 'examples/*')

if [ "$fail" -ne 0 ]; then
  echo "A killed run leaves these behind. Add the label (see src/test-reaper.ts and its ports)." >&2
  exit 1
fi
echo "every docker-CLI test container carries a reaper label"
