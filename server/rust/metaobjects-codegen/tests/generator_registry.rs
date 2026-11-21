//! The Rust port against the shared generator registry
//! (`fixtures/generator-registry-conformance/registry.json`, ADR-0021 D3) and the eject
//! contract (ADR-0034 Amendment 8).
//!
//! The registry is the one cross-port list of generator names. Each port checks itself
//! against it: no name the registry does not list, presence both ways, and the same `tier`
//! and `layer`. The eject contract adds three assertions: census, completeness and depth.
//! The half of depth that needs a build (each generator ejected alone compiles and writes
//! what the shipped one writes) is the `cargo-meta` binary's own test,
//! `an_ejected_generator_builds_and_writes_what_the_shipped_one_writes`; the reference scan
//! is here.

use std::collections::{BTreeMap, BTreeSet};

use metaobjects_codegen::eject::REFERENCES;
use metaobjects_codegen::shipped_generators;
use serde_json::Value;

const REGISTRY: &str =
    include_str!("../../../../fixtures/generator-registry-conformance/registry.json");
const PORT: &str = "rust";
/// How the crate is spelled in a path.
const CRATE: &str = "metaobjects_codegen";

fn registry() -> Value {
    serde_json::from_str(REGISTRY).expect("the registry is JSON")
}

/// The registry's entries this port is listed on, by name.
fn expected(registry: &Value) -> BTreeMap<String, Value> {
    registry["generators"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry["ports"].as_array().unwrap().iter().any(|p| p == PORT))
        .map(|(name, entry)| (name.clone(), entry.clone()))
        .collect()
}

#[test]
fn the_port_is_listed() {
    let ports = registry()["ports"].clone();
    assert!(
        ports.as_array().unwrap().iter().any(|p| p == PORT),
        "{ports}"
    );
}

#[test]
fn census_what_ships_is_what_the_registry_names_for_rust() {
    let registry = registry();
    let expected: BTreeSet<String> = expected(&registry).into_keys().collect();
    let generators = shipped_generators();
    let shipped: Vec<&str> = generators.iter().map(|g| g.name()).collect();
    let unique: BTreeSet<String> = shipped.iter().map(ToString::to_string).collect();
    assert_eq!(
        unique.len(),
        shipped.len(),
        "a generator ships twice: {shipped:?}"
    );
    assert_eq!(
        unique, expected,
        "the shipped generators and the registry's rust entries differ; edit both together"
    );
}

#[test]
fn completeness_every_generator_ships_eject_source_in_run_order() {
    let registry = registry();
    let generators = shipped_generators();
    let shipped: Vec<&str> = generators.iter().map(|g| g.name()).collect();
    let ejectable: Vec<&str> = REFERENCES.iter().map(|r| r.name).collect();
    assert_eq!(
        ejectable, shipped,
        "`eject` offers exactly the shipped generators, in run order"
    );
    for (name, entry) in expected(&registry) {
        assert_eq!(
            entry["eject"], "full",
            "{name}: the Rust port has no eject exemption"
        );
    }
    let pending = registry["eject"]["pending"].as_array().unwrap();
    assert!(
        pending.iter().all(|entry| entry["port"] != PORT),
        "the Rust port has no pending eject gap"
    );
}

#[test]
fn tier_and_layer_are_the_registrys() {
    let expected = expected(&registry());
    for r in REFERENCES {
        let entry = &expected[r.name];
        assert_eq!(entry["tier"], r.tier, "{}: tier", r.name);
        assert_eq!(entry["layer"], r.layer, "{}: layer", r.name);
    }
}

/// The module a `metaobjects_codegen::<module>` path names, for every such path on a line.
fn modules_named(line: &str) -> Vec<&str> {
    let prefix = format!("{CRATE}::");
    let mut found = Vec::new();
    let mut rest = line;
    while let Some(at) = rest.find(&prefix) {
        let after = &rest[at + prefix.len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        found.push(&after[..end]);
        rest = &after[end..];
    }
    found
}

/// The engine modules the crate exports. Each `use` is a compile-time probe: a module the crate
/// does not export fails the build of this test.
fn exported_engine_modules() -> BTreeSet<&'static str> {
    macro_rules! exported {
        ($($module:ident),* $(,)?) => {{
            $(
                #[allow(unused_imports)]
                use metaobjects_codegen::$module;
            )*
            BTreeSet::from([$(stringify!($module)),*])
        }};
    }
    exported!(emitted, generator, inbound, names, plan, render, writer)
}

#[test]
fn depth_an_owned_copy_names_nothing_outside_the_engine_surface() {
    let registry = registry();
    let surface = &registry["eject"]["engineSurface"][PORT];
    assert_eq!(
        surface["codegenPackages"],
        serde_json::json!([format!("{CRATE}::**")])
    );
    let engine: BTreeSet<&str> = surface["engine"]
        .as_array()
        .unwrap()
        .iter()
        .map(|path| {
            let path = path.as_str().unwrap();
            path.strip_prefix(&format!("{CRATE}::"))
                .unwrap_or_else(|| panic!("{path} is not a module of {CRATE}"))
        })
        .collect();
    assert_eq!(
        engine,
        exported_engine_modules(),
        "the registry's engine surface and the modules the crate exports differ; edit both together"
    );
    for r in REFERENCES {
        assert!(
            !engine.contains(r.module),
            "{}: a generator's own module is not engine",
            r.name
        );
        let mut scanned = 0;
        for (number, line) in r.source.lines().enumerate() {
            // A path in a comment is prose, not a reference.
            if line.trim_start().starts_with("//") {
                continue;
            }
            for module in modules_named(line) {
                scanned += 1;
                assert!(
                    engine.contains(module),
                    "{}.rs:{}: names {CRATE}::{module}, which is outside the engine surface {engine:?}",
                    r.module,
                    number + 1
                );
            }
        }
        assert!(
            scanned > 0,
            "{}: the scan found no engine import at all",
            r.name
        );
        // What an owned copy would lose: a path into the crate it was copied out of.
        for outside in ["use crate::", "use super::"] {
            assert!(
                !r.source
                    .lines()
                    .any(|l| l.trim_start().starts_with(outside)),
                "{}: `{outside}` does not survive being copied into another crate",
                r.name
            );
        }
    }
}

#[test]
fn the_scan_reads_every_path_on_a_line() {
    assert_eq!(
        modules_named("use metaobjects_codegen::plan::Plan; metaobjects_codegen::writer::item(x)"),
        vec!["plan", "writer"]
    );
    assert!(modules_named("let x = crate_name::plan();").is_empty());
}
