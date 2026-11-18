//! Loader behaviour the shared metamodel corpus does not pin, checked against what
//! the TypeScript reference parser does.

use metaobjects::loader::{Loader, metadata_files};
use metaobjects::providers::default_registry;
use metaobjects::serializer::canonical_serialize;

fn load(sources: &[(&str, &str)]) -> metaobjects::LoadResult {
    let registry = default_registry().expect("the built-in providers compose");
    let owned: Vec<(String, String)> = sources
        .iter()
        .map(|(id, text)| (id.to_string(), text.to_string()))
        .collect();
    Loader::new(&registry).load_sources(&owned)
}

fn codes(result: &metaobjects::LoadResult) -> Vec<&'static str> {
    result.errors.iter().map(|e| e.code).collect()
}

#[test]
fn a_schema_key_beside_the_wrapper_is_not_a_wrapper() {
    let r = load(&[(
        "meta.a.json",
        r#"{"$schema": "https://example.invalid/schema.json",
            "metadata.root": {"package": "acme", "children": [
              {"object.entity": {"name": "A"}}]}}"#,
    )]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    assert!(canonical_serialize(&r.tree, r.root).contains("\"A\""));
}

#[test]
fn two_wrapper_keys_are_refused() {
    let r = load(&[(
        "meta.a.json",
        r#"{"metadata.root": {}, "object.entity": {"name": "A"}}"#,
    )]);
    assert_eq!(codes(&r), ["ERR_TOP_LEVEL_NOT_OBJECT"]);
}

#[test]
fn malformed_children_are_errors_not_silent_drops() {
    for children in [
        r#"{"object.entity": {"name": "A"}}"#,
        r#"[5]"#,
        r#"[{}]"#,
        r#"[{"object.entity": {"name": "A"}, "object.value": {"name": "B"}}]"#,
    ] {
        let doc = format!(r#"{{"metadata.root": {{"package": "acme", "children": {children}}}}}"#);
        let r = load(&[("meta.a.json", &doc)]);
        assert_eq!(
            codes(&r),
            ["ERR_TOP_LEVEL_NOT_OBJECT"],
            "children: {children}"
        );
    }
}

#[test]
fn structural_keys_take_exact_json_types() {
    let cases = [
        (r#""abstract": "no""#, "ERR_BAD_ATTR_VALUE"),
        (r#""isArray": 1"#, "ERR_BAD_ATTR_VALUE"),
        (r#""package": 7"#, "ERR_BAD_ATTR_VALUE"),
        (r#""extends": 7"#, "ERR_UNRESOLVED_SUPER"),
    ];
    for (key, code) in cases {
        let doc = format!(
            r#"{{"metadata.root": {{"package": "acme", "children": [
                 {{"object.entity": {{"name": "A", {key}}}}}]}}}}"#
        );
        let r = load(&[("meta.a.json", &doc)]);
        assert!(codes(&r).contains(&code), "{key}: {:?}", r.errors);
    }
}

#[test]
fn only_a_literal_true_makes_an_overlay() {
    // `"overlay": "false"` is a plain declaration, so it needs no merge target.
    let r = load(&[(
        "meta.a.json",
        r#"{"metadata.root": {"package": "acme", "children": [
             {"object.entity": {"name": "A", "overlay": "false"}}]}}"#,
    )]);
    assert!(
        !codes(&r).contains(&"ERR_OVERLAY_NO_TARGET"),
        "{:?}",
        r.errors
    );
}

#[test]
fn same_named_siblings_in_one_file_merge() {
    let r = load(&[(
        "meta.a.json",
        r#"{"metadata.root": {"package": "acme", "children": [
             {"object.entity": {"name": "A", "children": [
               {"field.string": {"name": "x", "@maxLength": 5}},
               {"field.string": {"name": "x", "@required": true}}]}}]}}"#,
    )]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let out = canonical_serialize(&r.tree, r.root);
    assert_eq!(out.matches("\"name\": \"x\"").count(), 1, "{out}");
    assert!(out.contains("\"@maxLength\": 5") && out.contains("\"@required\": true"));
}

#[test]
fn unnamed_nodes_never_merge() {
    let file = |attr: &str| {
        format!(
            r#"{{"metadata.root": {{"package": "acme", "children": [
                 {{"object.entity": {{"name": "A", "children": [
                   {{"field.string": {{"name": "x", "children": [
                     {{"validator.length": {{"@max": {attr}}}}}]}}}}]}}}}]}}}}"#
        )
    };
    let (a, b) = (file("5"), file("9"));
    let r = load(&[("meta.a.json", &a), ("meta.b.json", &b)]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let out = canonical_serialize(&r.tree, r.root);
    assert_eq!(out.matches("validator.length").count(), 2, "{out}");
}

#[test]
fn the_loader_reads_pending_directories() {
    let dir = std::env::temp_dir().join(format!("mo-rust-pending-{}", std::process::id()));
    let pending = dir.join("_pending");
    std::fs::create_dir_all(&pending).expect("temp dir");
    std::fs::write(pending.join("meta.p.json"), "{}").expect("write");
    let all = metadata_files(&dir, false).expect("walk");
    let skipped = metadata_files(&dir, true).expect("walk");
    std::fs::remove_dir_all(&dir).expect("clean up");
    assert_eq!((all.len(), skipped.len()), (1, 0));
}

#[cfg(unix)]
#[test]
fn a_symlink_cycle_is_walked_once() {
    let dir = std::env::temp_dir().join(format!("mo-rust-symlink-{}", std::process::id()));
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).expect("temp dir");
    std::fs::write(sub.join("meta.a.json"), "{}").expect("write");
    // sub/loop -> .. : a cycle back to the walk's own root.
    std::os::unix::fs::symlink("..", sub.join("loop")).expect("symlink");
    let found = metadata_files(&dir, false);
    std::fs::remove_dir_all(&dir).expect("clean up");
    assert_eq!(found.expect("walk").len(), 1);
}

// The TypeScript reference keeps an empty-object placeholder for a YAML child
// that could not be desugared, so a later sibling's error keeps its source
// index (and its no-wrapper complaint is a warning there, not an error).
#[test]
fn a_bad_yaml_child_keeps_later_sibling_indices_stable() {
    let r = load(&[(
        "meta.a.yaml",
        "metadata.root:\n  name: test\n  package: acme\n  children:\n    - object.entity:\n        name: Thing\n        children:\n          - field.string: a\n            field.int: b\n          - field.nonesuch: c\n",
    )]);
    assert_eq!(codes(&r), ["ERR_MALFORMED_YAML", "ERR_UNKNOWN_SUBTYPE"]);
    assert_eq!(r.errors[0].source.json_path(), Some("$"));
    assert_eq!(
        r.errors[1].source.json_path(),
        Some("$['metadata.root'].children[0]['object.entity'].children[1]['field.nonesuch']")
    );
}

// The TypeScript reference reports one ERR_YAML_COERCION per non-string element
// of a string-array value, not just the first.
#[test]
fn string_array_coercion_reports_every_bad_element() {
    let r = load(&[(
        "meta.a.yaml",
        "metadata.root:\n  name: test\n  package: acme\n  children:\n    - object.entity:\n        name: Thing\n        children:\n          - field.enum:\n              name: color\n              values: [true, false]\n",
    )]);
    assert_eq!(codes(&r), ["ERR_YAML_COERCION", "ERR_YAML_COERCION"]);
    for (i, e) in r.errors.iter().enumerate() {
        assert!(e.message.contains(&format!("'@values[{i}]'")), "{i}: {}", e.message);
        assert_eq!(e.source.json_path(), Some("$"), "{i}: {:?}", e.source);
    }
}
