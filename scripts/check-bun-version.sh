#!/usr/bin/env bash
#
# Guard: the bun on THIS machine must not lag the version the hosted workflows pin.
#
# Why this exists: the self-hosted runners execute `scripts/ci-local.sh` with the
# bun on the runner's PATH snapshot (`~/.bun/bin/bun`), while every hosted workflow
# installs a PINNED bun via `oven-sh/setup-bun` (`bun-version: 'X.Y.Z'`). Those two
# paths share no source of truth, so the local bun can silently fall behind for
# months — and on 2026-08-05 it had: the box sat on 1.3.8 while the workflows
# pinned 1.3.14.
#
# That drift was NOT cosmetic. The stale bun CRASHED and HUNG on the runner:
# `Illegal instruction (core dumped) bun test` on one run, a 20-30 minute job-cap
# stall on others, and a 464ms test consuming 60s on another — 6+ red lanes in a
# single day, each costing a full re-run to learn nothing, because a crashed
# runtime produces no failing test name. Upgrading to the pinned version cleared
# it first try. Note a per-test `--timeout` does NOT mitigate this: a test-level
# cap cannot interrupt a wedged or dead runtime.
#
# This guard turns that silent drift into a loud, instant, toolchain-free failure.
# Being AHEAD of the pin is fine (reported, not failed) — only lagging is the
# dangerous direction.
#
# Usage:  scripts/check-bun-version.sh        # exit 1 + diagnostic when local < pinned
#
set -uo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "check-bun-version: bun not installed — nothing to compare (skipping)."
  exit 0
fi

local_ver="$(bun --version 2>/dev/null | tr -d '[:space:]')"
if [ -z "$local_ver" ]; then
  echo "check-bun-version: could not read \`bun --version\` (skipping)." >&2
  exit 0
fi

# Highest version pinned by any hosted workflow (setup-bun's `bun-version:`).
pinned_ver="$(grep -rhoE "bun-version:[[:space:]]*['\"]?[0-9]+\.[0-9]+\.[0-9]+" .github/workflows/ 2>/dev/null \
  | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" \
  | sort -V | tail -1)"

if [ -z "$pinned_ver" ]; then
  echo "check-bun-version: no \`bun-version:\` pin found in .github/workflows/ (skipping)."
  exit 0
fi

# sort -V puts the older version first; if that is the local one, we lag.
oldest="$(printf '%s\n%s\n' "$local_ver" "$pinned_ver" | sort -V | head -1)"

if [ "$local_ver" = "$pinned_ver" ]; then
  echo "check-bun-version: bun $local_ver matches the workflow pin."
  exit 0
fi

if [ "$oldest" = "$local_ver" ]; then
  cat >&2 <<EOF

  ✖ bun on this machine LAGS the version the hosted workflows pin.

      local  (runner PATH): $local_ver
      pinned (setup-bun)  : $pinned_ver

  A stale bun has crashed and stalled the self-hosted lanes before —
  'Illegal instruction (core dumped)' and job-cap timeouts with no failing
  test name, which look like flakes and cost a re-run each. Fix with:

      bun upgrade

  then re-run. (Being AHEAD of the pin is fine; only lagging is guarded.)

EOF
  exit 1
fi

echo "check-bun-version: bun $local_ver is ahead of the workflow pin ($pinned_ver) — OK."
exit 0
