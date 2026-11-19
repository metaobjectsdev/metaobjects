//! `@intValueMap` content checks (the reference's attr-schema Check 5b): the map is read
//! as `Object.entries` reads it, so an array value is checked by index, and an integral
//! float such as `1.0` is an integer (`Number.isInteger`) that can duplicate another.

use metaobjects::LoadResult;
use metaobjects::loader::Loader;
use metaobjects::providers::default_registry;

fn load(int_value_map: &str) -> LoadResult {
    let doc = format!(
        r#"{{"metadata.root": {{"package": "t", "children": [
          {{"object.entity": {{"name": "Order", "children": [
            {{"source.rdb": {{"@table": "orders"}}}},
            {{"field.long": {{"name": "id"}}}},
            {{"field.enum": {{"name": "status", "@values": ["A", "B"], "@intValueMap": {int_value_map}}}}},
            {{"identity.primary": {{"name": "id", "@fields": "id"}}}}
          ]}}}}
        ]}}}}"#
    );
    Loader::new(&default_registry().unwrap()).load_sources(&[("meta.t.json".to_string(), doc)])
}

fn messages(r: &LoadResult) -> Vec<&str> {
    r.errors.iter().map(|e| e.message.as_str()).collect()
}

#[test]
fn a_well_formed_map_loads_clean() {
    let r = load(r#"{"A": 1, "B": 2}"#);
    assert!(r.errors.is_empty(), "{:?}", messages(&r));
}

#[test]
fn an_array_value_is_checked_by_index_against_the_members() {
    let r = load("[1, 2]");
    assert!(
        messages(&r).iter().any(|m| m.contains(
            "keys must exactly match '@values' members (missing: A, B) (unknown: 0, 1)."
        )),
        "{:?}",
        messages(&r)
    );
}

#[test]
fn integral_floats_that_agree_are_a_duplicate() {
    let r = load(r#"{"A": 1.0, "B": 1.0}"#);
    assert!(
        messages(&r).iter().any(|m| m.contains(
            "members 'A' and 'B' share the same value 1; every member must have a unique int."
        )),
        "{:?}",
        messages(&r)
    );
}
