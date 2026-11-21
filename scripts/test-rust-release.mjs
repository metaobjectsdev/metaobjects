#!/usr/bin/env node
// Tests for scripts/lib/rust-release.mjs — whether a release publishes the Rust crates, in
// what order, and the version edit that puts them on the shared line.
//
//   node scripts/test-rust-release.mjs
//
// The oracles are the release rules in docs/RELEASING.md (publish what changed; a change to
// expected-registry.json publishes every registry) and crates.io's own: a crate publishes
// after its dependencies, and a version once taken is taken.

import {
  isRustProductPath, newestRustTag, rustPublishDecision, rustPublishOrder, bumpRustManifest,
  crateVersionTaken, EXPECTED_REGISTRY,
} from "./lib/rust-release.mjs";

let fails = 0;
const check = (cond, label) => (cond ? console.log(`ok:   ${label}`) : (console.error(`FAIL: ${label}`), fails++));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// What the crates ship.
check(isRustProductPath("server/rust/metaobjects/src/loader.rs"), "a crate's source is shipped");
check(isRustProductPath("server/rust/metaobjects/data/library/iam/meta.iam.yaml"), "a crate's embedded data is shipped");
check(isRustProductPath("server/rust/metaobjects-codegen/build.rs"), "a build script is shipped");
check(isRustProductPath("server/rust/metaobjects-cli/Cargo.toml"), "a crate manifest is shipped");
check(isRustProductPath("server/rust/Cargo.toml"), "the workspace manifest is shipped (it sets every crate's version)");
check(isRustProductPath("server/rust/Cargo.lock"), "the lockfile is shipped (the binary is built from it)");
check(!isRustProductPath("server/rust/metaobjects-codegen/tests/compile.rs"), "a crate's tests are not shipped");
check(!isRustProductPath("server/rust/metaobjects/examples/load_bench.rs"), "a crate's examples are not shipped");
check(!isRustProductPath("server/rust/metaobjects/baselines/load.json"), "benchmark baselines are not shipped");
check(!isRustProductPath("server/rust/rustfmt.toml"), "a workspace file other than the manifest and lock is not shipped");
check(!isRustProductPath("server/rustacean/src/x.rs"), "a sibling directory that merely starts with the name is not the workspace");
check(!isRustProductPath("docs/ports/rust.md"), "the port's docs are not shipped");

// The newest tag.
check(newestRustTag([]) === null, "no tag: the crates never shipped");
check(newestRustTag(["v1.3.0", "python-v1.3.0"]) === null, "other ports' tags are not the crates'");
check(newestRustTag(["rust-v1.3.0", "rust-v1.10.0", "rust-v1.9.2"]) === "rust-v1.10.0", "versions compare as numbers, not text");
check(newestRustTag(["rust-v1.3.0-rc.2", "rust-v1.3.0"]) === "rust-v1.3.0", "a final release is newer than its candidates");
check(newestRustTag(["rust-v1.3.0-rc.2", "rust-v1.3.0-rc.10"]) === "rust-v1.3.0-rc.10", "candidates compare by number");
check(newestRustTag(["rust-vnext", "rust-v1.3.0"]) === "rust-v1.3.0", "a tag that is not a version is ignored");

// Whether the cut publishes.
const decide = (lastTag, changedPaths, mode) => rustPublishDecision({ lastTag, changedPaths, mode });
check(decide(null, []).publish, "never published: the first cut publishes, changed or not");
check(!decide("rust-v1.3.0", ["docs/ports/rust.md", "server/rust/metaobjects/tests/x.rs"]).publish,
  "only docs and tests changed: the crates sit the release out");
check(decide("rust-v1.3.0", ["server/rust/metaobjects-render/src/render.rs"]).publish, "a shipped file changed: publish");
check(decide("rust-v1.3.0", [EXPECTED_REGISTRY]).publish, "expected-registry.json changed: every registry publishes");
check(decide("rust-v1.3.0", ["server/rust/metaobjects/src/a.rs"]).reason.includes("server/rust/metaobjects/src/a.rs"),
  "the reason names the file that changed");
check(decide("rust-v1.3.0", []).reason.includes("rust-v1.3.0"), "a skip names the tag it compared against");
check(decide(null, [], "skip").publish === false, "--crates=skip overrides a first publish");
check(decide("rust-v1.3.0", [], "publish").publish, "--crates=publish overrides an unchanged tree");
check(throws(() => decide(null, [], "maybe")), "an unknown --crates mode is refused, not read as auto");

// The publish order, from what `cargo metadata --no-deps` prints.
const pkg = (name, deps, extra = {}) => ({
  id: `path+file:///ws/${name}#${name}@1.3.0`, name,
  dependencies: deps.map(([n, kind]) => ({ name: n, kind: kind ?? null })), ...extra,
});
const meta = (packages) => ({ packages, workspace_members: packages.map((p) => p.id) });
const workspace = meta([
  pkg("metaobjects-cli", [["metaobjects"], ["metaobjects-codegen"], ["clap"]]),
  pkg("metaobjects-codegen", [["metaobjects"], ["metaobjects-render"], ["serde"]]),
  pkg("metaobjects-render", [["mustache-ng"], ["serde_json"]]),
  pkg("metaobjects", [["serde_json"], ["indexmap"]]),
]);
check(JSON.stringify(rustPublishOrder(workspace))
  === JSON.stringify(["metaobjects", "metaobjects-render", "metaobjects-codegen", "metaobjects-cli"]),
  "each crate after the crates it depends on, ties by name");
check(JSON.stringify(rustPublishOrder(meta([pkg("b", []), pkg("a", [["b", "dev"]])]))) === JSON.stringify(["a", "b"]),
  "a dev-dependency does not order anything");
check(JSON.stringify(rustPublishOrder(meta([pkg("a", []), pkg("x", [], { publish: [] })]))) === JSON.stringify(["a"]),
  "a crate marked publish = false is left out");
check(JSON.stringify(rustPublishOrder(meta([pkg("a", [["b", "build"]]), pkg("b", [])]))) === JSON.stringify(["b", "a"]),
  "a build-dependency orders like a normal one");
check(throws(() => rustPublishOrder(meta([pkg("a", [["b"]]), pkg("b", [["a"]])]))), "a cycle is refused");

// The version edit.
const root = `[workspace]
members = ["metaobjects"]

[workspace.package]
version = "1.2.0"
edition = "2024"

[workspace.dependencies]
serde = { version = "1.0" }
`;
const bumpedRoot = bumpRustManifest(root, "1.3.0");
check(bumpedRoot.includes('[workspace.package]\nversion = "1.3.0"'), "the workspace version moves");
check(bumpedRoot.includes('serde = { version = "1.0" }'), "a registry dependency's requirement does not");
check(bumpedRoot.replace('version = "1.3.0"', 'version = "1.2.0"') === root, "nothing else changes");
const member = `[package]
name = "metaobjects-cli"
version.workspace = true

[dependencies]
metaobjects = { path = "../metaobjects", version = "1.2.0" }
metaobjects-codegen = { path = "../metaobjects-codegen", version = "1.2.0" }
clap = { version = "4.5", features = ["derive"] }
`;
const bumpedMember = bumpRustManifest(member, "1.3.0-rc.1");
check(bumpedMember.includes('metaobjects = { path = "../metaobjects", version = "1.3.0-rc.1" }')
  && bumpedMember.includes('metaobjects-codegen = { path = "../metaobjects-codegen", version = "1.3.0-rc.1" }'),
  "each sibling crate's requirement moves");
check(bumpedMember.includes('clap = { version = "4.5", features = ["derive"] }'), "a registry dependency is left alone");
check(bumpedMember.includes("version.workspace = true"), "an inherited version stays inherited");

// What crates.io answers.
check(crateVersionTaken({ versions: [{ num: "1.3.0" }, { num: "1.2.0" }] }, "1.3.0"), "a published version is taken");
check(!crateVersionTaken({ versions: [{ num: "1.3.0-rc.1" }] }, "1.3.0"), "a candidate does not take the final number");
check(!crateVersionTaken({}, "1.3.0"), "an answer with no versions takes nothing");

if (fails) { console.error(`\n${fails} failing`); process.exit(1); }
console.log("\nall rust-release checks pass");
