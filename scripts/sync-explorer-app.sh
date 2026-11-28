#!/usr/bin/env bash
# Refresh every port's committed copy of the model explorer app from the repo-root canonical
# copy, explorer-app/ (built by server/typescript/packages/docs-site/scripts/build-app.ts).
# Each port ships the same bytes in its own package, so its docs-site generator writes the app
# with no Node on the path; only the data files (the docs view, the model script and the stamp)
# are the port's own. Run after rebuilding explorer-app/; the `gates` lane fails when a copy is
# stale.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/explorer-app"
# Keep this list in step with gate_explorer_app_drift in scripts/ci-local.sh.
dests=(
  "$root/server/typescript/packages/docs-site/app"
  "$root/server/python/src/metaobjects/documentation/explorer_app"
  "$root/server/java/codegen-base/src/main/resources/metaobjects/explorer-app"
  "$root/server/csharp/MetaObjects.Codegen/ExplorerApp"
)
for dst in "${dests[@]}"; do
  mkdir -p "$dst"
  # --delete drops files a rebuild renamed away; the README stays at the root only.
  rsync -a --delete --exclude README.md "$src/" "$dst/"
  echo "synced: explorer-app/ -> ${dst#"$root"/}"
done
