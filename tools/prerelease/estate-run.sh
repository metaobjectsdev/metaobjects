#!/usr/bin/env bash
# Run one adopter estate against a staged candidate: the mechanical part of the estate run
# sheet (tools/prerelease/estate-run.md). It does steps 1 to 4 and 6 of "every candidate, every
# estate" and prints a report; booting the app and comparing API answers stays a person's (or an
# agent's) step, and the report says so.
#
#   tools/prerelease/estate-run.sh --project <dir> --port ts|python|csharp|java \
#       --version 1.3.0-rc.N [--build-cmd <cmd>] [--test-cmd <cmd>] [--db-cmd <cmd>]... \
#       [--install-cmd <cmd>] [--gen-cmd <cmd>] [--verify-cmd <cmd>] [--versions-cmd <cmd>] \
#       [--report <file>] [--keep-linked] [--no-link]
#
# What it does, in order:
#   1. Refuses a project whose git tree is not clean: "files changed" is only a number
#      when it starts from nothing.
#   2. Links the candidate (prerelease-link.sh link), installs clean, and reads the installed
#      versions back. A declared range is not proof of the version that ran, so the run fails
#      when the read-back does not contain the candidate.
#   3. Regenerates, and lists every file that changed (each one must be explained by an item in
#      the CHANGELOG upgrade list). Then regenerates AGAIN: the second run must write zero files,
#      checked by content and by modification time. Both checks see only files git reports:
#      a gitignored path (ignored generated output, .gen-state snapshots) is not looked at.
#   4. Runs the drift gate (verify --codegen), the build, the tests and any --db-cmd. A command
#      you do not pass is reported as skipped, never as passed.
#   5. Puts the estate back as it found it (unless --keep-linked), however the run ended, also
#      when link failed partway or --no-link was given: unlink, then `git reset --hard` to the commit it started on and `git clean -fd`. That is safe only
#      because step 1 required a clean tree, and it is why a dirty tree is refused. Ignored files
#      (node_modules, .venv, bin, obj) stay as the candidate installed them: reinstall afterwards.
#
# Each estate passes its own build, test and database commands; the generation and install
# defaults below are the port's documented ones. Rust has no estate path: pin a commit
# (docs/features/prerelease.md, "Rust").
#
# Exit status: 0 when every step that ran passed, 1 when one failed, 2 on bad usage.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="$PWD"; PORT=""; VERSION=""; REPORT=""; KEEP=0; NOLINK=0
INSTALL_CMD=""; GEN_CMD=""; VERIFY_CMD=""; VERSIONS_CMD=""; BUILD_CMD=""; TEST_CMD=""
DB_CMDS=()

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="$(cd "$2" && pwd)" || die "no such project: $2"; shift 2 ;;
    --port)         PORT="$2"; shift 2 ;;
    --version)      VERSION="$2"; shift 2 ;;
    --report)       REPORT="$2"; shift 2 ;;
    --install-cmd)  INSTALL_CMD="$2"; shift 2 ;;
    --gen-cmd)      GEN_CMD="$2"; shift 2 ;;
    --verify-cmd)   VERIFY_CMD="$2"; shift 2 ;;
    --versions-cmd) VERSIONS_CMD="$2"; shift 2 ;;
    --build-cmd)    BUILD_CMD="$2"; shift 2 ;;
    --test-cmd)     TEST_CMD="$2"; shift 2 ;;
    --db-cmd)       DB_CMDS+=("$2"); shift 2 ;;
    --keep-linked)  KEEP=1; shift ;;
    --no-link)      NOLINK=1; shift ;;
    -h|--help)      sed -n '2,33p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

[[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([0-9]+)$ ]] || die "--version must be a candidate such as 1.3.0-rc.1, got '$VERSION'"
MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"; PATCH="${BASH_REMATCH[3]}"; ITER="${BASH_REMATCH[4]}"
# The version each registry spells (scripts/prerelease.mjs, `V`): npm and NuGet verbatim, PyPI
# in PEP 440 form, Maven with its major at npm's plus 7.
case "$PORT" in
  ts|csharp) EXPECT="$VERSION" ;;
  python)    EXPECT="$MAJOR.$MINOR.${PATCH}rc$ITER" ;;
  java)      EXPECT="$((MAJOR + 7)).$MINOR.$PATCH-rc.$ITER" ;;
  *) die "--port must be ts, python, csharp or java, got '$PORT'" ;;
esac

git -C "$PROJECT" rev-parse --show-toplevel >/dev/null 2>&1 || die "$PROJECT is not a git repository"
[ -z "$(git -C "$PROJECT" status --porcelain --untracked-files=all)" ] \
  || die "$PROJECT has uncommitted changes — commit or stash them first, so 'files changed' means what the candidate changed"

# ── the port's documented commands; an estate overrides any of them ───────────────────
case "$PORT" in
  ts)
    if   ls "$PROJECT"/bun.lock* >/dev/null 2>&1; then PM="bun install"
    elif [ -f "$PROJECT/pnpm-lock.yaml" ];         then PM="pnpm install"
    elif [ -f "$PROJECT/yarn.lock" ];              then PM="yarn install"
    else PM="npm install"; fi
    : "${INSTALL_CMD:=rm -rf node_modules && $PM}"
    : "${GEN_CMD:=npx --no-install meta gen}"
    : "${VERIFY_CMD:=npx --no-install meta verify --codegen}"
    : "${VERSIONS_CMD:=for d in node_modules/@metaobjectsdev/*/; do node -p \"require('./\${d}package.json').name + '@' + require('./\${d}package.json').version\"; done}" ;;
  python)
    if [ -f "$PROJECT/uv.lock" ]; then INST="uv sync"; else INST="python3 -m venv .venv && .venv/bin/pip install -e ."; fi
    : "${INSTALL_CMD:=rm -rf .venv && $INST}"
    : "${GEN_CMD:=.venv/bin/metaobjects gen}"
    : "${VERIFY_CMD:=.venv/bin/metaobjects verify --codegen}"
    : "${VERSIONS_CMD:=.venv/bin/python -c \"import importlib.metadata as m; print('metaobjects@' + m.version('metaobjects'))\"}" ;;
  csharp)
    : "${INSTALL_CMD:=dotnet tool restore && dotnet restore --force}"
    : "${GEN_CMD:=dotnet meta gen}"
    : "${VERIFY_CMD:=dotnet meta verify --codegen}"
    : "${VERSIONS_CMD:=dotnet list package | grep -i metaobjects; dotnet tool list | grep -i meta}" ;;
  java)
    : "${INSTALL_CMD:=mvn -B -q -U dependency:resolve}"
    : "${GEN_CMD:=mvn -B -q metaobjects:generate}"
    : "${VERIFY_CMD:=mvn -B -q metaobjects:verify}"
    : "${VERSIONS_CMD:=mvn -B dependency:list -DincludeGroupIds=com.metaobjects | grep 'com.metaobjects'}" ;;
esac

if [ -n "$REPORT" ]; then
  [ -d "$(dirname "$REPORT")" ] || die "--report directory does not exist: $(dirname "$REPORT")"
  REPORT="$(cd "$(dirname "$REPORT")" && pwd)/$(basename "$REPORT")"
  case "$REPORT" in "$PROJECT"/*) die "--report $REPORT is inside the estate, and the restore at the end deletes untracked files there: write it outside" ;; esac
fi

# ── bookkeeping ───────────────────────────────────────────────────────────────────────
WORK="$(mktemp -d "${DEV_SCRATCH:-${TMPDIR:-/tmp}}/estate-run.XXXXXX")"
ROWS="$WORK/rows"; DETAIL="$WORK/detail"; : > "$ROWS"; : > "$DETAIL"
FAILED=0; STARTED="$(date +%s)"
START_HEAD="$(git -C "$PROJECT" rev-parse HEAD)"

cleanup() {
  local code=$?
  if [ "$KEEP" = 0 ]; then
    if [ "$NOLINK" = 0 ]; then
      "$HERE/prerelease-link.sh" unlink --project "$PROJECT" >"$WORK/unlink.log" 2>&1 \
        || { echo "! unlink failed:" >&2; cat "$WORK/unlink.log" >&2; }
    fi
    # unlink repins to the public latest; the estate goes back to the commit it started on instead.
    git -C "$PROJECT" reset -q --hard "$START_HEAD" && git -C "$PROJECT" clean -qfd \
      && echo "restored $PROJECT to ${START_HEAD:0:12}" >&2 || echo "! could not restore $PROJECT to $START_HEAD" >&2
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

row() { printf '| %s | %s | %ss |\n' "$1" "$2" "$3" >> "$ROWS"; }
fail_detail() { # name, log
  { printf '\n### Failure: %s\n\n```\n' "$1"; tail -n 40 "$2"; printf '```\n'; } >> "$DETAIL"
}

# step <name> <command>; returns the command's status, records the row and, on failure, the log tail.
step() {
  local name="$1" cmd="$2" log="$WORK/${1//[^A-Za-z0-9]/_}.log" t0 rc
  t0="$(date +%s)"
  ( cd "$PROJECT" && bash -c "$cmd" ) >"$log" 2>&1; rc=$?
  if [ "$rc" = 0 ]; then row "$name" "passed" "$(( $(date +%s) - t0 ))"
  else row "$name" "**FAILED** (exit $rc)" "$(( $(date +%s) - t0 ))"; fail_detail "$name" "$log"; FAILED=1; fi
  return "$rc"
}
skipped() { row "$1" "skipped (no command given)" 0; }

finish() {
  local out; out="${REPORT:-$WORK/report.md}"
  {
    printf '# Estate run: %s, %s, %s\n\n' "$(basename "$PROJECT")" "$PORT" "$VERSION"
    printf 'Started %s UTC, %ss in all. Estate commit `%s`.\n\n' \
      "$(date -u -d "@$STARTED" '+%Y-%m-%d %H:%M' 2>/dev/null || date -u '+%Y-%m-%d %H:%M')" \
      "$(( $(date +%s) - STARTED ))" "$(git -C "$PROJECT" rev-parse --short=12 HEAD)"
    printf '| Step | Result | Time |\n|---|---|---|\n'; cat "$ROWS"
    [ -s "$WORK/changed.txt" ] && { printf '\n## Files changed by regeneration (%s)\n\nEach one needs an item in the CHANGELOG upgrade list.\n\n```\n' "$(wc -l < "$WORK/changed.txt")"; cat "$WORK/changed.txt"; printf '```\n'; }
    [ -s "$WORK/versions.txt" ] && { printf '\n## Installed versions (read back)\n\n```\n'; cat "$WORK/versions.txt"; printf '```\n'; }
    cat "$DETAIL"
    printf '\n## Not done by this script\n\nBoot the app and compare a few API answers with the released version; on an estate with a\ndatabase, also `meta migrate --dry-run` and, on Postgres, `meta verify --db` if you passed no\n`--db-cmd`. Record the result next to this report.\n'
  } > "$out"
  cat "$out"; [ -n "$REPORT" ] && { echo; echo "report: $out"; }
  [ "$FAILED" = 0 ] || exit 1
  exit 0
}

# ── 1. link, install clean, read the versions back ────────────────────────────────────
if [ "$NOLINK" = 0 ]; then
  if ( cd "$PROJECT" && "$HERE/prerelease-link.sh" link --project "$PROJECT" --version "$VERSION" ) >"$WORK/link.log" 2>&1
  then row "link $VERSION" "passed" 0
  else row "link $VERSION" "**FAILED**" 0; fail_detail "link $VERSION" "$WORK/link.log"; FAILED=1; finish; fi
else
  row "link $VERSION" "skipped (--no-link: the read-back below is the only proof)" 0
fi

step "install (clean)" "$INSTALL_CMD" || finish
( cd "$PROJECT" && bash -c "$VERSIONS_CMD" ) > "$WORK/versions.txt" 2>&1
# Every line that names a MetaObjects package must carry exactly the candidate (not rc.10 for rc.1,
# not a package left on the release), and at least one must.
VCOUNT="$(grep -ci 'metaobjects' "$WORK/versions.txt")"
STALE="$(grep -i 'metaobjects' "$WORK/versions.txt" | grep -vE -- "(^|[^0-9A-Za-z.+-])${EXPECT//./\\.}([^0-9A-Za-z.+-]|$)")"
if [ "$VCOUNT" -gt 0 ] && [ -z "$STALE" ]; then row "installed version is $EXPECT" "passed ($VCOUNT lines)" 0
else
  row "installed version is $EXPECT" "**FAILED** (${VCOUNT} package lines, $(printf '%s' "$STALE" | grep -c .) not on the candidate)" 0
  fail_detail "installed version" "$WORK/versions.txt"; FAILED=1; finish
fi

# ── 2. regenerate; list what changed; regenerate again and expect nothing ─────────────
# "Changed by regeneration" is what the first gen changed beyond what link and install already
# did (the repinned manifests, the lockfile): each dirty path with a hash of its content.
dirtymap() {
  git -C "$PROJECT" status --porcelain --untracked-files=all | while IFS= read -r l; do
    f="${l:3}"; f="${f##* -> }"
    printf '%s %s\n' "$l" "$( [ -f "$PROJECT/$f" ] && sha256sum < "$PROJECT/$f" | cut -c1-16 || echo gone)"
  done
}
dirtymap | sort > "$WORK/base.txt"
step "gen (first run)" "$GEN_CMD" || finish
dirtymap | sort > "$WORK/after.txt"
comm -13 "$WORK/base.txt" "$WORK/after.txt" | sed 's/ [0-9a-f]\{16\}$//; s/ gone$//' > "$WORK/changed.txt"
row "files changed by the first gen" "$(wc -l < "$WORK/changed.txt")" 0

snapshot() { dirtymap | sha256sum; }
INSTALLED='(^|/)(node_modules|\.venv|bin|obj|target)/'
BEFORE="$(snapshot)"; MARK="$WORK/mark"; touch "$MARK"; sleep 1
step "gen (second run)" "$GEN_CMD" || finish
REWRITTEN="$(cd "$PROJECT" && git ls-files -co --exclude-standard | grep -vE "$INSTALLED" | while IFS= read -r f; do [ "$f" -nt "$MARK" ] && echo "$f"; done)"
if [ "$(snapshot)" = "$BEFORE" ] && [ -z "$REWRITTEN" ]; then row "second gen writes zero files" "passed" 0
else
  row "second gen writes zero files" "**FAILED**" 0
  { printf '\n### Failure: second gen wrote files\n\n```\n'; printf '%s\n' "$REWRITTEN"; printf '```\n'; } >> "$DETAIL"; FAILED=1
fi

# ── 3. gates ──────────────────────────────────────────────────────────────────────────
step "verify --codegen (drift gate)" "$VERIFY_CMD"
if [ -n "$BUILD_CMD" ]; then step "build" "$BUILD_CMD"; else skipped "build"; fi
if [ -n "$TEST_CMD" ];  then step "tests" "$TEST_CMD";  else skipped "tests"; fi
if [ "${#DB_CMDS[@]}" -gt 0 ]; then
  i=0; for c in "${DB_CMDS[@]}"; do i=$((i + 1)); step "database check $i" "$c"; done
else skipped "database checks"; fi

finish
