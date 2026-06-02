#!/usr/bin/env bash
#
# sync-doc-templates.sh
#
# Repo-root templates/ is the SINGLE CANONICAL SOURCE OF TRUTH for doc templates.
# Each consumer (npm package, future ports) ships its OWN bundled copy so it can
# resolve templates at runtime without depending on the repo layout. This script
# REPRODUCES every bundled copy from the canonical root source, so the bundled
# copies can never silently fork from canonical.
#
# A byte-identity test gates root == package copy; run this script whenever you
# change the canonical template under templates/docs/.
#
# Idempotent. Safe to run from any directory. Future ports: add their bundled
# templates/docs destination to the DESTS array below.

set -euo pipefail

# Resolve repo root relative to this script (works from anywhere).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_DIR="${REPO_ROOT}/templates/docs"

# Canonical -> bundled-copy destinations (one per consumer).
DESTS=(
  "${REPO_ROOT}/server/typescript/packages/codegen-ts/templates/docs"
)

if [[ ! -d "${SRC_DIR}" ]]; then
  echo "error: canonical source dir not found: ${SRC_DIR}" >&2
  exit 1
fi

shopt -s nullglob
SRC_FILES=("${SRC_DIR}"/*.mustache)
shopt -u nullglob

if [[ ${#SRC_FILES[@]} -eq 0 ]]; then
  echo "error: no *.mustache templates found under ${SRC_DIR}" >&2
  exit 1
fi

for dest in "${DESTS[@]}"; do
  mkdir -p "${dest}"
  for src in "${SRC_FILES[@]}"; do
    cp "${src}" "${dest}/$(basename "${src}")"
    echo "synced: ${src} -> ${dest}/$(basename "${src}")"
  done
done

echo "doc templates synced from canonical root: ${SRC_DIR}"
