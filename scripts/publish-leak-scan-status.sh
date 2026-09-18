#!/usr/bin/env bash
#
# Publish the LOCAL leak scan's real result to GitHub as the `leak-scan` commit status.
#
# WHY THIS EXISTS. `main`'s branch protection requires one status check, `leak-scan`, and
# the only thing that ever published it was `.github/workflows/hygiene.yml`. GitHub Actions
# is disabled on this repository (2026-09-16), so that workflow cannot fire and NOTHING can
# merge. The alternative to this script was weakening the protection rule; publishing the
# check locally keeps the rule intact instead.
#
# WHAT A GREEN `leak-scan` MEANS NOW. It means a human (or their machine) ran
# `.githooks/leak-scan.sh` locally and this script reported that exact result. It does NOT
# mean a hosted scan ran — no hosted scan can run while Actions is off. The published status
# description says so too, so the PR page carries the caveat rather than only this file.
#
# HONESTY RULES, all enforced below rather than trusted:
#   * the published state is the scan's REAL exit code — a failed scan publishes `failure`,
#     never `success`, and the script's own exit code matches what it published;
#   * the status is bound to an exact commit SHA, never a branch name or a moving head;
#   * a dirty worktree REFUSES to publish, because the scan would not describe any commit;
#   * HEAD is re-read after the scan and must be unchanged, so the commit reported is
#     provably the commit scanned;
#   * a missing credential FAILS LOUDLY; it never silently skips and leaves a stale or
#     absent check that someone reads as "not applicable".
#
# Usage:
#   scripts/publish-leak-scan-status.sh [<base-ref>] [--dry-run]
#     <base-ref>   what to diff against; defaults to origin/main (same as ci-local.sh).
#     --dry-run    run the scan and print exactly what WOULD be published, post nothing.
#
# Credential: the GitHub CLI's existing auth (`gh auth token`), or GH_TOKEN / GITHUB_TOKEN.
# No new credential is introduced. Needs `repo:status` scope.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE=""; DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) awk 'NR==1{next} /^set -uo/{exit} {sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    -*) echo "unknown arg: $1 (see --help)" >&2; exit 2 ;;
    *) [ -n "$BASE" ] && { echo "unexpected extra arg: $1" >&2; exit 2; }; BASE="$1" ;;
  esac
  shift
done
[ -z "$BASE" ] && BASE="origin/main"
git rev-parse --verify -q "$BASE" >/dev/null 2>&1 || {
  echo "✖ base ref '$BASE' does not resolve — fetch it first, or pass one that does." >&2
  exit 2
}

# ── Refuse on a dirty tree ────────────────────────────────────────────────────
# The scan reads the working tree's diff. With uncommitted changes present, its verdict
# describes something that is not any commit, so there is no commit it can honestly be
# bound to. Refuse rather than publish a status that means less than it appears to.
if [ -n "$(git status --porcelain)" ]; then
  echo "✖ refusing to publish: the working tree is dirty." >&2
  echo "  The scan would not describe any commit. Commit or stash first." >&2
  exit 2
fi

SHA="$(git rev-parse HEAD)"

# ── Resolve the repository from the origin remote (works on a fork too) ───────
ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
SLUG="$(printf '%s' "$ORIGIN" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')"
case "$SLUG" in
  */*) : ;;
  *) echo "✖ could not derive <owner>/<repo> from origin remote: '${ORIGIN:-<unset>}'" >&2; exit 2 ;;
esac

# ── Credential: reuse the existing one, fail loudly when there is none ────────
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
  TOKEN="$(gh auth token 2>/dev/null || true)"
fi
if [ -z "$TOKEN" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "✖ no GitHub credential available — refusing to skip silently." >&2
  echo "  A missing check reads as 'not applicable'; an absent one blocks the merge." >&2
  echo "  Fix with ONE of:" >&2
  echo "    gh auth login                 # the GitHub CLI's own auth (preferred)" >&2
  echo "    export GH_TOKEN=<token>       # needs the 'repo:status' scope" >&2
  exit 2
fi

# ── Run the REAL scan, and keep its exit code ────────────────────────────────
echo "── leak-scan ─────────────────────────────────────────────"
echo "  repo:   $SLUG"
echo "  commit: $SHA"
echo "  base:   $BASE"
echo ""
bash .githooks/leak-scan.sh "$BASE"
SCAN_RC=$?

# ── The commit reported must be the commit scanned ───────────────────────────
SHA_AFTER="$(git rev-parse HEAD)"
if [ "$SHA_AFTER" != "$SHA" ]; then
  echo "" >&2
  echo "✖ refusing to publish: HEAD moved during the scan." >&2
  echo "    scanned:  $SHA" >&2
  echo "    now:      $SHA_AFTER" >&2
  echo "  Re-run so the status describes the commit it actually scanned." >&2
  exit 2
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "" >&2
  echo "✖ refusing to publish: the working tree became dirty during the scan." >&2
  exit 2
fi

if [ "$SCAN_RC" -eq 0 ]; then
  STATE="success"; DESC="Local leak scan passed (run on a developer machine, not hosted CI)"
else
  STATE="failure"; DESC="Local leak scan FAILED (run on a developer machine, not hosted CI)"
fi

echo ""
echo "── publishing ────────────────────────────────────────────"
echo "  context:     leak-scan"
echo "  state:       $STATE          (scan exit code: $SCAN_RC)"
echo "  commit:      $SHA"
echo "  repository:  $SLUG"
echo "  description: $DESC"

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "  ⊘ --dry-run: nothing was posted."
  exit "$SCAN_RC"
fi

HTTP_BODY="$(mktemp)"; trap 'rm -f "$HTTP_BODY"' EXIT
HTTP_CODE="$(curl -sS -o "$HTTP_BODY" -w '%{http_code}' \
  -X POST "https://api.github.com/repos/$SLUG/statuses/$SHA" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "$(printf '{"state":"%s","context":"leak-scan","description":"%s"}' "$STATE" "$DESC")" \
  2>/dev/null)"

if [ "$HTTP_CODE" != "201" ]; then
  echo "" >&2
  echo "✖ publishing failed (HTTP $HTTP_CODE). The check was NOT posted." >&2
  sed -e 's/^/    /' "$HTTP_BODY" >&2
  echo "  A 403/404 here usually means the token lacks the 'repo:status' scope." >&2
  exit 2
fi

echo ""
echo "  ✓ published leak-scan=$STATE for $SHA"
echo "    https://github.com/$SLUG/commit/$SHA"
exit "$SCAN_RC"
