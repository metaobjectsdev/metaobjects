#!/usr/bin/env bash
# Remove stale unpacked copies of this workspace's own crates before `cargo publish --dry-run`.
#
# `cargo publish --workspace` verifies each crate against a temporary overlay registry
# (target/package/tmp-registry) and unpacks the crates it depends on into
# $CARGO_HOME/registry/src/-<hash>/<name>-<version>/. The hash is fixed for a given checkout
# path, and cargo never unpacks again once that directory holds `.cargo-ok`. While the version
# stays the same, the next dry run on that machine therefore compiles the OLD source of the
# dependency, not what it just packaged. On a self-hosted runner that is permanent: main went
# red after a new module landed in `metaobjects`, because `metaobjects-codegen`'s verify step
# compiled a `metaobjects-1.3.0` unpacked before that module existed.
#
# A copy is stale when any file the crate packages differs from (or is missing in) the copy.
# Only stale copies are removed; one matching the tree is left for whoever is using it.
#
# Usage: scripts/rust-clear-stale-publish-sources.sh [workspace-dir]   (default server/rust)
set -euo pipefail

ws="${1:-$(cd "$(dirname "$0")/.." && pwd)/server/rust}"
src_root="${CARGO_HOME:-$HOME/.cargo}/registry/src"
[ -d "$src_root" ] || exit 0

cd "$ws"
# name version crate-dir, one line per workspace member
members=$(cargo metadata --no-deps --format-version 1 --locked | python3 -c '
import json, os, sys
for p in json.load(sys.stdin)["packages"]:
    print(p["name"], p["version"], os.path.dirname(p["manifest_path"]))
')

# Files cargo rewrites or synthesises when packaging; never compared.
generated_re='^(Cargo\.toml|Cargo\.toml\.orig|Cargo\.lock|\.cargo_vcs_info\.json)$'

while read -r name version dir; do
  [ -n "$name" ] || continue
  files=$(cargo package --list --allow-dirty --locked -p "$name" 2>/dev/null)
  # Overlay registries are the unnamed `-<hash>` directories; crates.io's are named.
  for copy in "$src_root"/-*/"$name-$version"; do
    [ -d "$copy" ] || continue
    stale=0
    while IFS= read -r rel; do
      [[ "$rel" =~ $generated_re ]] && continue
      [ -f "$dir/$rel" ] || continue # copied in from outside the crate (a workspace LICENSE)
      if ! cmp -s "$dir/$rel" "$copy/$rel"; then stale=1; break; fi
    done <<< "$files"
    if [ "$stale" -eq 1 ]; then
      echo "removing stale unpacked $name-$version: $copy"
      rm -rf "$copy"
    fi
  done
done <<< "$members"
