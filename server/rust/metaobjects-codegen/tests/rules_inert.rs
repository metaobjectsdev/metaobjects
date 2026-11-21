//! ADR-0066: the business-rules vocabulary is inert in the Rust generators.
//!
//! `api.operational`, `operation.*`, `binding.rest` and `transition.action` are registered
//! and validated at load. The flat generators generate nothing from them: a model that uses
//! them emits exactly what the same model without them emits, byte for byte. The generators of
//! the rules layers (ADR-0067) are the exception, because reading this vocabulary is their job:
//! the names and contract-types layers write nothing for the model without it, and only files
//! of their own for the model with it, so they add files and move none. The data-access layer
//! (`repository`) writes for every stored entity either way; the vocabulary adds to it only the
//! guarded update of each lifecycle, at the end of that entity's file.
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

/// The generators of the rules layers (ADR-0067) that read nothing but this vocabulary, named
/// so a flat generator can never be excused by accident.
const LAYER_GENERATORS: &[&str] = &["rules-names", "contract-types"];

/// The data-access layer (ADR-0067 layer 3): it holds the guarded update of each lifecycle.
const DATA_ACCESS: &[&str] = &["repository"];

/// Which shipped generators a call runs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pick {
    Flat,
    Layers,
    DataAccess,
}

fn pick_of(name: &str) -> Pick {
    if LAYER_GENERATORS.contains(&name) {
        Pick::Layers
    } else if DATA_ACCESS.contains(&name) {
        Pick::DataAccess
    } else {
        Pick::Flat
    }
}

/// Every file the picked shipped generators write for one variant: path to contents.
fn emit(variant: &str, pick: Pick) -> BTreeMap<String, String> {
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
        if pick_of(g.name()) != pick {
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
    let with = emit("with", Pick::Flat);
    let without = emit("without", Pick::Flat);
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
    assert!(emit("without", Pick::Layers).is_empty());
    let layers = emit("with", Pick::Layers);
    assert!(
        !layers.is_empty(),
        "the rules layers generate from the model"
    );
    let flat = emit("with", Pick::Flat);
    for path in layers.keys() {
        assert!(
            !flat.contains_key(path),
            "{path} is also a flat generator's file"
        );
    }
}

#[test]
fn the_data_access_layer_writes_the_same_files_and_adds_only_the_guarded_updates_with_the_vocabulary()
 {
    let with = emit("with", Pick::DataAccess);
    let without = emit("without", Pick::DataAccess);
    assert!(!without.is_empty(), "the stored entity has a store");
    assert_eq!(
        with.keys().collect::<Vec<_>>(),
        without.keys().collect::<Vec<_>>()
    );
    let flat = emit("with", Pick::Flat);
    // The lifecycle is `PurchaseRequest.status` (see the README of the model pair).
    let lifecycle_entity = "acme_purchasing_store/src/purchase_request.rs";
    for (path, text) in &without {
        assert!(
            !flat.contains_key(path),
            "{path} is also a flat generator's file"
        );
        if path != lifecycle_entity {
            assert_eq!(&with[path], text, "{path}");
            continue;
        }
        let added = with[path]
            .strip_prefix(text.as_str())
            .unwrap_or_else(|| panic!("{path} changes, not only grows, with the vocabulary"));
        assert!(
            added.starts_with("\n/// The guarded update of the lifecycle `status`")
                && added.contains("pub async fn transition_status<"),
            "{path} gains more than the guarded update:\n{added}"
        );
    }
}
