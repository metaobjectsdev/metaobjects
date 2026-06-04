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
# change a canonical template under templates/<group>/ (docs, api, …).
#
# Idempotent. Safe to run from any directory. Future ports: add their bundled
# templates root to the DEST_ROOTS array; add a new template group to
# TEMPLATE_GROUPS.

set -euo pipefail

# Resolve repo root relative to this script (works from anywhere).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Canonical template GROUPS under templates/ (docs, api, …). Each group is a
# subdir; every consumer mirrors the SAME group subdir so provider refs
# (`<group>/<file>`) resolve identically from the bundled copy. Adding a new
# group here is the ONLY edit needed — the byte-identity gate + embed generator
# discover groups by globbing templates/*/, so they stay in lockstep.
TEMPLATE_GROUPS=(docs api)

# Per-consumer bundled-copy ROOT (the consumer's own templates/ dir). Each group
# is copied under <root>/<group>.
DEST_ROOTS=(
  "${REPO_ROOT}/server/typescript/packages/codegen-ts/templates"
)

for group in "${TEMPLATE_GROUPS[@]}"; do
  src_dir="${REPO_ROOT}/templates/${group}"
  if [[ ! -d "${src_dir}" ]]; then
    echo "error: canonical source dir not found: ${src_dir}" >&2
    exit 1
  fi

  shopt -s nullglob
  src_files=("${src_dir}"/*.mustache)
  shopt -u nullglob

  if [[ ${#src_files[@]} -eq 0 ]]; then
    echo "error: no *.mustache templates found under ${src_dir}" >&2
    exit 1
  fi

  for dest_root in "${DEST_ROOTS[@]}"; do
    dest="${dest_root}/${group}"
    mkdir -p "${dest}"
    for src in "${src_files[@]}"; do
      cp "${src}" "${dest}/$(basename "${src}")"
      echo "synced: ${src} -> ${dest}/$(basename "${src}")"
    done
  done
done

# Regenerate the embedded-string TS module so the framework doc templates also
# resolve inside the `bun build --compile` standalone `meta` binary (where the
# on-disk templates/ dir is unavailable). Keeps the bundled package copy AND the
# embedded module in sync with canonical from a single command. Idempotent.
bun run "${SCRIPT_DIR}/generate-embedded-templates.ts"

echo "doc templates synced from canonical root: ${REPO_ROOT}/templates (${TEMPLATE_GROUPS[*]})"
