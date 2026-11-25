//! Reference sources (`{ "path": …, "reference": true }`): a reference node loads and
//! resolves, and the entity generator emits nothing for it.

mod common;

use common::Scratch;
use metaobjects_codegen::generator::GenContext;
use metaobjects_codegen::project::load_project;
use metaobjects_codegen::{EntityGenerator, Generator};

const CONFIG: &str = r#"{ "schema_version": 1, "sources": [
  { "path": "model" }, { "path": "replies", "reference": true } ] }"#;

const OWN: &str = r#"{ "metadata.root": { "package": "acme", "children": [
  { "object.value": { "name": "Request", "children": [ { "field.string": { "name": "question" } } ] } },
  { "object.entity": { "name": "Ticket", "children": [
    { "field.long": { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } }
  ] } }
] } }"#;

const REPLY: &str = r#"{ "metadata.root": { "package": "acme", "children": [
  { "object.value": { "name": "Answer", "children": [ { "field.string": { "name": "text" } } ] } }
] } }"#;

#[test]
fn a_reference_node_is_loaded_and_not_generated() {
    let project = Scratch::project(
        "reference",
        &[
            (".metaobjects/config.json", CONFIG),
            ("model/meta.own.json", OWN),
            ("replies/meta.replies.json", REPLY),
        ],
    );
    let loaded = load_project(project.path(), None, false).expect("the model loads clean");
    assert_eq!(
        loaded.reference_nodes.iter().cloned().collect::<Vec<_>>(),
        vec!["acme::Answer".to_string()]
    );
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &[],
        collection: &loaded.collection,
        reference_nodes: &loaded.reference_nodes,
    };
    let files = EntityGenerator.generate(&ctx).expect("generates");
    let all: String = files.iter().map(|f| f.content.as_str()).collect();
    assert!(
        all.contains("Ticket"),
        "the project's own entity is emitted"
    );
    assert!(
        all.contains("Request"),
        "the project's own value object is emitted"
    );
    assert!(
        !all.contains("Answer"),
        "the reference value object is not emitted:\n{all}"
    );
}
