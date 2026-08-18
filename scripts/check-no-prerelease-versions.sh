#!/usr/bin/env bash
# Guard: a PRE-RELEASE version must never be committed to this repository.
#
# `scripts/prerelease.mjs` edits every version declaration in place and restores them on
# exit, but a crash, a Ctrl-C at the wrong moment, or a hand-run `sed` can leave an
# `-rc.N` / `rc<N>` / `-SNAPSHOT` behind. Committing one is quietly expensive:
# `scripts/release.mjs` derives the whole lockstep set from the CLI's current version
# (`server/typescript/packages/cli/package.json`), so a stray pre-release version silently
# SHRINKS the set that the next real release publishes.
#
# Offline, toolchain-free, runs in milliseconds. Wired into .githooks/pre-commit and the
# `gates` lane of scripts/ci-local.sh.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
report() { echo "  ✖ $1: $2" >&2; fail=1; }

# npm — every workspace package.json
for f in server/typescript/packages/*/package.json client/web/packages/*/package.json; do
  [ -f "$f" ] || continue
  v=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)
  case "$v" in *-*) report "$f" "version $v is a pre-release";; esac
done

# python
v=$(sed -n 's/^version = "\(.*\)"/\1/p' server/python/pyproject.toml | head -1)
case "$v" in *rc*|*dev*|*a[0-9]*|*b[0-9]*) report "server/python/pyproject.toml" "version $v is a pre-release";; esac

# csharp
v=$(sed -n 's#.*<Version>\(.*\)</Version>.*#\1#p' server/csharp/Directory.Build.props | head -1)
case "$v" in *-*) report "server/csharp/Directory.Build.props" "version $v is a pre-release";; esac

# java/kotlin — the reactor root decides the line for every module
v=$(grep -m1 -oE '<version>[^<]+</version>' server/java/pom.xml | sed -E 's#</?version>##g')
case "$v" in *-*) report "server/java/pom.xml" "version $v is a pre-release";; esac

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

Pre-release version(s) found in committed version declarations.
Fix — restore them (scripts/prerelease.mjs does this automatically; a crashed run may not have).
Version declarations only; unrelated WIP under those trees is not touched:

    git checkout -- 'server/typescript/packages/*/package.json' \
                    'client/web/packages/*/package.json' \
                    'server/java/**/pom.xml' 'server/python/pyproject.toml' \
                    'server/csharp/Directory.Build.props' 'bun.lock'
MSG
  exit 1
fi
echo "check-no-prerelease-versions: ✓ no pre-release version in any version declaration"
