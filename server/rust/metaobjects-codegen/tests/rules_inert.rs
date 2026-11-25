//! ADR-0066: the business-rules vocabulary is inert in the Rust generators.
//!
//! `api.operational`, `operation.*`, `binding.rest` and `transition.action` are registered
//! and validated at load; nothing generates from them yet. A model that uses them emits
//! exactly what the same model without them emits, byte for byte.
//!
//! The model pair is `fixtures/codegen-noop/rules/{with,without}`, shared with the other
//! ports (the table in that directory's README lists each port's test).

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use common::Scratch;
use metaobjects_codegen::generator::GenContext;
use metaobjects_codegen::project::load_project;
use metaobjects_codegen::shipped_generators;

const MODEL_FILE: &str = "meta.purchasing.json";

/// Every file the shipped generators write for one variant: path to contents.
fn emit(variant: &str) -> BTreeMap<String, String> {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/codegen-noop/rules")
        .join(variant)
        .join(MODEL_FILE);
    let model =
        std::fs::read_to_string(&fixture).unwrap_or_else(|e| panic!("{}: {e}", fixture.display()));
    // One project name for both variants, so nothing that stamps it into output can differ.
    let project = Scratch::project(
        "rules-inert",
        &[(&format!("metaobjects/{MODEL_FILE}"), &model)],
    );
    let loaded = load_project(project.path(), None, false).expect("the model loads clean");
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &[],
        collection: &loaded.collection,
        reference_nodes: &loaded.reference_nodes,
    };
    let mut files = BTreeMap::new();
    for g in shipped_generators() {
        let emitted = g
            .generate(&ctx)
            .unwrap_or_else(|e| panic!("the {} generator runs: {e:?}", g.name()));
        for f in emitted {
            // Two generators that both write a shared crate write the same bytes.
            if let Some(prev) = files.insert(f.path.clone(), f.content.clone()) {
                assert_eq!(prev, f.content, "{} is written twice, differently", f.path);
            }
        }
    }
    files
}

#[test]
fn a_model_with_operations_and_transitions_generates_what_it_does_without_them() {
    let with = emit("with");
    let without = emit("without");
    assert!(!without.is_empty(), "the model generates something");
    assert_eq!(
        with.keys().collect::<Vec<_>>(),
        without.keys().collect::<Vec<_>>()
    );
    for (path, text) in &without {
        assert_eq!(&with[path], text, "{path}");
    }
}
