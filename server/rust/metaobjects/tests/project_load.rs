//! A whole project read the way the other ports read it: find the collection,
//! read its config, gather its files (YAML and JSON, plus the opted-in
//! libraries), and hand the text to the loader.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::json;

use metaobjects::collection::resolve_collection;
use metaobjects::loader::Loader;
use metaobjects::naming::NamingRegistry;
use metaobjects::providers::default_registry;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "mo-project-load-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const USERS_YAML: &str = "\
metadata:
  package: shop
  children:
    - object.entity:
        name: User
        children:
          - field.long: id
          - field.string[]: tags
          - field.string:
              name: email
              required: true
";

const ORDERS_JSON: &str = r#"{ "metadata.root": { "package": "shop", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "field.long": { "name": "userId", "@required": true } }
  ] } }
] } }"#;

fn load(dir: &Scratch) -> metaobjects::loader::LoadResult {
    let mut registry = default_registry().expect("the built-in providers compose");
    registry.seal();
    let collection =
        resolve_collection(&dir.0, None, &NamingRegistry::builtin()).expect("the project resolves");
    let (sources, read_errors) = collection.read_sources();
    assert!(read_errors.is_empty(), "{read_errors:?}");
    Loader::new(&registry).load_sources(&sources)
}

#[test]
fn a_project_of_yaml_and_json_files_loads_as_one_model() {
    let s = Scratch::new();
    s.write(
        ".metaobjects/config.json",
        &json!({ "schema_version": 1 }).to_string(),
    );
    s.write("metaobjects/meta.users.yaml", USERS_YAML);
    s.write("metaobjects/meta.orders.json", ORDERS_JSON);
    // A file under `_pending` is not part of the model.
    s.write("metaobjects/_pending/meta.draft.yaml", "not: [valid");
    let result = load(&s);
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    let canonical = metaobjects::serializer::canonical_serialize(&result.tree, result.root);
    assert!(canonical.contains("\"User\""), "{canonical}");
    assert!(canonical.contains("\"Order\""), "{canonical}");
    assert!(
        canonical.contains("\"isArray\": true"),
        "the `[]` key suffix becomes isArray: {canonical}"
    );
}

#[test]
fn a_bad_yaml_file_reports_its_own_path_and_position() {
    let s = Scratch::new();
    s.write(
        ".metaobjects/config.json",
        &json!({ "schema_version": 1 }).to_string(),
    );
    s.write(
        "metaobjects/meta.bad.yaml",
        "metadata:\n  children:\n    - object.entity:\n        name: A\n        children:\n          - field.nonesuch: x\n",
    );
    let result = load(&s);
    let err = result
        .errors
        .first()
        .expect("an unknown subtype is an error");
    assert_eq!(err.source.format(), "yaml");
    assert!(
        err.source.files()[0].ends_with("meta.bad.yaml"),
        "{:?}",
        err.source.files()
    );
    let pos = err.source.yaml_position().expect("a position");
    assert_eq!(
        (pos.line, pos.col),
        (6, 13),
        "the wrapper key's line and column"
    );
}

#[test]
fn the_shipped_libraries_load_clean_from_their_embedded_yaml() {
    let s = Scratch::new();
    s.write(
        ".metaobjects/config.json",
        &json!({ "schema_version": 1, "libraries": ["iam", "iam/db", "ai", "ai/db"] }).to_string(),
    );
    s.write("metaobjects/meta.users.yaml", USERS_YAML);
    let result = load(&s);
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    let canonical = metaobjects::serializer::canonical_serialize(&result.tree, result.root);
    assert!(
        canonical.contains("\"User\""),
        "the project's own entity is there"
    );
    assert!(
        canonical.len() > 20_000,
        "the libraries added their design to the model ({} bytes)",
        canonical.len()
    );
}
