#!/usr/bin/env bash
# Refresh the Python package's committed copy of the shipped agent files from the repo-root
# tree (agent-context-shipped/, built by TypeScript). The wheel carries the copy, so
# `metaobjects agent-docs` needs no Node. Run after rebuilding the tree; the `gates` lane and
# a Python test fail when the copy is stale.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/agent-context-shipped"
dst="$root/server/python/src/metaobjects/agent_context/shipped"
mkdir -p "$dst"
# --delete drops stored files a rebuild renamed away; the README stays at the root only.
rsync -a --delete --exclude README.md "$src/" "$dst/"
