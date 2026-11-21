//! ADR-0066: the business-rules vocabulary is inert in the Rust generators.
//!
//! `api.operational`, `operation.*`, `binding.rest` and `transition.action` are registered
//! and validated at load. The flat generators generate nothing from them: a model that uses
//! them emits exactly what the same model without them emits, byte for byte. The generators of
//! the rules layers (ADR-0067) are the exception, because reading this vocabulary is their job:
//! each writes nothing for the model without it, and only files of its own for the model with
//! it, so it adds files and moves none.
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

/// The generators of the rules layers (ADR-0067), named so a flat generator can never be
/// excused by accident.
const LAYER_GENERATORS: &[&str] = &["rules-names", "contract-types"];

/// Every file the shipped generators write for one variant: path to contents. `layers` picks
/// the rules-layer generators (true) or the flat ones (false).
fn emit(variant: &str, layers: bool) -> BTreeMap<String, String> {
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
    };
    let mut files = BTreeMap::new();
    for g in shipped_generators() {
        if LAYER_GENERATORS.contains(&g.name()) != layers {
            continue;
        }
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
    let with = emit("with", false);
    let without = emit("without", false);
    assert!(!without.is_empty(), "the model generates something");
    assert_eq!(
        with.keys().collect::<Vec<_>>(),
        without.keys().collect::<Vec<_>>()
    );
    for (path, text) in &without {
        assert_eq!(&with[path], text, "{path}");
    }
}

#[test]
fn the_rules_layer_generators_write_nothing_without_the_vocabulary_and_only_their_own_files_with_it()
 {
    assert!(emit("without", true).is_empty());
    let layers = emit("with", true);
    assert!(
        !layers.is_empty(),
        "the rules layers generate from the model"
    );
    let flat = emit("with", false);
    for path in layers.keys() {
        assert!(
            !flat.contains_key(path),
            "{path} is also a flat generator's file"
        );
    }
}
