//! The reference-source gate: every case of the shared
//! `fixtures/reference-source-conformance/cases.json` must load (or fail) as every other
//! port does, and the set of reference nodes must match EXACTLY.
//!
//! A reference source's files load into the same root as every other source, so
//! `@responseRef` resolves against them; the top-level nodes only reference files declare
//! are the reference nodes. A `template.*` declared only in reference files is refused.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use metaobjects::collection::resolve_collection;
use metaobjects::loader::Loader;
use metaobjects::naming::NamingRegistry;
use metaobjects::providers::default_registry;
use metaobjects::reference::reference_nodes_of;
use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/reference-source-conformance/cases.json")
}

/// A fresh directory under `$DEV_SCRATCH` (RAM) or the system temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "mo-reference-source-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Load one case; `Ok` is the reference-node set, `Err` the first error code and message.
fn load(case: &Value) -> Result<BTreeSet<String>, (String, String)> {
    let scratch = Scratch::new();
    let root = &scratch.0;
    for (rel, content) in case["tree"].as_object().unwrap() {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content.as_str().unwrap()).unwrap();
    }
    std::fs::create_dir_all(root.join(".metaobjects")).unwrap();
    std::fs::write(
        root.join(".metaobjects/config.json"),
        serde_json::to_string(&case["config"]).unwrap(),
    )
    .unwrap();

    let fail = |e: metaobjects::MetaError| (e.code.to_string(), e.message);
    let collection =
        resolve_collection(root, Some(root), &NamingRegistry::builtin()).map_err(fail)?;
    let (sources, read_errors) = collection.read_sources();
    if let Some(e) = read_errors.into_iter().next() {
        return Err(fail(e));
    }
    let mut registry = default_registry().expect("the built-in providers compose");
    registry.seal();
    let result = Loader::new(&registry).load_sources(&sources);
    if let Some(e) = result.errors.into_iter().next() {
        return Err(fail(e));
    }
    reference_nodes_of(&result.tree, result.root, &collection.reference_ids).map_err(fail)
}

#[test]
fn every_case_loads_as_pinned() {
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(corpus()).unwrap()).unwrap();
    let cases = cases["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 6,
        "the corpus shrank to {} cases",
        cases.len()
    );
    let mut failed = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let outcome = load(case);
        let verdict = match (case.get("expectLoadError"), outcome) {
            (Some(Value::String(code)), Err((got, _))) if &got == code => Ok(()),
            (Some(code), Err((got, msg))) => Err(format!("failed with {got} not {code}: {msg}")),
            (Some(code), Ok(_)) => Err(format!("loaded, expected {code}")),
            (None, Err((got, msg))) => Err(format!("unexpected {got}: {msg}")),
            (None, Ok(got)) => {
                let want: BTreeSet<String> = case["expectReference"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                if got == want {
                    Ok(())
                } else {
                    Err(format!("reference nodes {got:?} != expected {want:?}"))
                }
            }
        };
        if let Err(why) = verdict {
            failed.push(format!("{name}: {why}"));
        }
    }
    assert!(failed.is_empty(), "cases failed:\n{}", failed.join("\n"));
}
