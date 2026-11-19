#!/usr/bin/env bash
# Every gate for this example, in the order they are cheapest to fail.
#
#   scripts/gates.sh            # all of them
#   scripts/gates.sh --no-node  # skip the ones that need node, bun and the real tasks-axi
#
# Gates:
#   1 drift      the committed generated crate is exactly what the generator emits now
#                (`meta verify --codegen`, with hand edits set to fail in .metaobjects/config.json)
#   2 compile    the emitted crate type-checks (`cargo check`) and is rustfmt-clean
#   3 lint       clippy over the workspace, warnings denied
#   4 tests      cargo test over the workspace (TOON conformance, JS-regex differential,
#                recorded golden outputs of the real tasks-axi)
#   5 behaviour  the differential harness: real tasks-axi vs tasks-axi-rs, byte for byte
#
# Build output goes under $CARGO_TARGET_DIR, else $DEV_SCRATCH/tasks-axi-rust-target (a RAM disk)
# else ./target; it is never left running.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$here"

node_gates=1
[ "${1:-}" = "--no-node" ] && node_gates=0

if [ -z "${CARGO_TARGET_DIR:-}" ] && [ -n "${DEV_SCRATCH:-}" ]; then
  export CARGO_TARGET_DIR="$DEV_SCRATCH/tasks-axi-rust-target"
fi

step() { printf '\n== %s\n' "$*"; }

if [ "$node_gates" = 1 ]; then
  step "1 drift: the generated crate matches the model and the generator"
  (cd "$root/server/typescript" && bun run packages/cli/bin/meta.ts verify --codegen --cwd "$here" >/dev/null)
fi

step "2 compile: the emitted crate type-checks and is rustfmt-clean"
cargo check -p tasks-axi-gen --all-targets
rustfmt --edition 2021 --check crates/tasks-axi-gen/src/*.rs

step "3 lint: clippy, warnings denied"
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check

step "4 tests: workspace"
cargo test --workspace

if [ "$node_gates" = 1 ]; then
  step "5 behaviour: differential against the real tasks-axi"
  command -v tasks-axi >/dev/null || { echo "tasks-axi 0.2.6 is not on PATH (npm install -g tasks-axi@0.2.6)"; exit 2; }
  cargo build -p tasks-axi-rs
  bun harness/differential.ts --seeds "${DIFF_SEEDS:-40}"
fi

printf '\nall gates passed\n'
