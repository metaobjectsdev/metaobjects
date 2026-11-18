//! Validation that resolves physical names (column collisions) or collection names
//! (`@via` reverse hops) honours the project's `naming` setting and the reference's
//! own-only `@collectionName` rule. Oracle: the TypeScript `resolveColumnName`,
//! `resolveFlattenedColumnName` and `reverseHopName` behaviour.

use metaobjects::LoadResult;
use metaobjects::loader::Loader;
use metaobjects::naming::PhysicalNaming;
use metaobjects::providers::default_registry;

fn load(doc: &str, naming: PhysicalNaming) -> LoadResult {
    let registry = default_registry().expect("the built-in providers compose");
    Loader::new(&registry)
        .naming(naming)
        .load_sources(&[("meta.t.json".to_string(), doc.to_string())])
}

fn columns(strategy: &str) -> PhysicalNaming {
    PhysicalNaming {
        columns: strategy.to_string(),
        ..PhysicalNaming::default()
    }
}

fn collections(pluralizer: &str) -> PhysicalNaming {
    PhysicalNaming {
        collections: Some(pluralizer.to_string()),
        ..PhysicalNaming::default()
    }
}

fn collides(r: &LoadResult) -> bool {
    r.errors
        .iter()
        .any(|e| e.code == "ERR_COLUMN_NAME_COLLISION")
}

fn entity_with_fields(a: &str, b: &str) -> String {
    format!(
        r#"{{"metadata.root": {{"package": "t", "children": [
          {{"object.entity": {{"name": "User", "children": [
            {{"source.rdb": {{"@table": "users"}}}},
            {{"field.long": {{"name": "id"}}}},
            {{"field.string": {{"name": "{a}"}}}},
            {{"field.string": {{"name": "{b}"}}}},
            {{"identity.primary": {{"name": "id", "@fields": "id"}}}}
          ]}}}}
        ]}}}}"#
    )
}

#[test]
fn camel_and_snake_names_collide_only_under_a_folding_strategy() {
    let doc = entity_with_fields("userId", "user_id");
    assert!(collides(&load(&doc, PhysicalNaming::default())));
    assert!(!collides(&load(&doc, columns("literal"))));
    assert!(!collides(&load(&doc, columns("pascal"))));
}

#[test]
fn pascal_still_collides_names_that_differ_only_in_the_first_letter() {
    let doc = entity_with_fields("userId", "UserId");
    assert!(collides(&load(&doc, columns("pascal"))));
    assert!(!collides(&load(&doc, columns("literal"))));
}

#[test]
fn a_flattened_prefix_follows_the_column_strategy() {
    let doc = r#"{"metadata.root": {"package": "t", "children": [
      {"object.value": {"name": "Address", "children": [
        {"field.string": {"name": "street"}}]}},
      {"object.entity": {"name": "Order", "children": [
        {"source.rdb": {"@table": "orders"}},
        {"field.long": {"name": "id"}},
        {"field.string": {"name": "home_address_street"}},
        {"field.object": {"name": "homeAddress", "@objectRef": "t::Address", "@storage": "flattened"}},
        {"identity.primary": {"name": "id", "@fields": "id"}}
      ]}}
    ]}}"#;
    assert!(collides(&load(doc, PhysicalNaming::default())));
    assert!(!collides(&load(doc, columns("literal"))));
}

fn hop_doc(holder_extra: &str, holder_name: &str, holder_super: &str, via: &str) -> String {
    format!(
        r#"{{"metadata.root": {{"package": "acme", "children": [
          {{"object.entity": {{"name": "Patient", "children": [
            {{"source.rdb": {{"@table": "patients"}}}},
            {{"field.long": {{"name": "id"}}}},
            {{"identity.primary": {{"name": "id", "@fields": "id"}}}}
          ]}}}},
          {{"object.entity": {{"name": "Base", "abstract": true{holder_extra}}}}},
          {{"object.entity": {{"name": "{holder_name}"{holder_super}, "children": [
            {{"source.rdb": {{"@table": "holders"}}}},
            {{"field.long": {{"name": "id"}}}},
            {{"field.long": {{"name": "patientId"}}}},
            {{"field.boolean": {{"name": "onFile"}}}},
            {{"identity.primary": {{"name": "id", "@fields": "id"}}}},
            {{"identity.reference": {{"name": "patient", "@fields": "patientId", "@references": "acme::Patient"}}}}
          ]}}}},
          {{"object.projection": {{"name": "Row", "children": [
            {{"source.rdb": {{"@kind": "view", "@view": "v_row"}}}},
            {{"field.long": {{"name": "id", "extends": "acme::Patient.id"}}}},
            {{"field.boolean": {{"name": "onFile", "children": [
              {{"origin.passthrough": {{"@from": "acme::{holder_name}.onFile", "@via": "acme::Patient.{via}"}}}}]}}}},
            {{"identity.primary": {{"name": "id", "extends": "acme::Patient.id"}}}}
          ]}}}}
        ]}}}}"#
    )
}

fn hop_resolved(r: &LoadResult, hop: &str) -> bool {
    r.errors.iter().any(|e| {
        e.code == "ERR_ORIGIN_CARDINALITY" && e.message.contains(&format!("@via hop \"{hop}\""))
    })
}

#[test]
fn an_already_plural_holder_name_is_its_own_hop_name() {
    let doc = hop_doc("", "Settings", "", "settings");
    let r = load(&doc, PhysicalNaming::default());
    assert!(hop_resolved(&r, "settings"), "{:?}", r.errors);
}

#[test]
fn an_abstract_bases_collection_name_does_not_name_its_subtypes_hop() {
    let extra = r#", "@collectionName": "things""#;
    let sup = r#", "extends": "acme::Base""#;
    let own = load(
        &hop_doc(extra, "Consent", sup, "consents"),
        PhysicalNaming::default(),
    );
    assert!(hop_resolved(&own, "consents"), "{:?}", own.errors);
    let leaked = load(
        &hop_doc(extra, "Consent", sup, "things"),
        PhysicalNaming::default(),
    );
    assert!(!hop_resolved(&leaked, "things"), "{:?}", leaked.errors);
}

#[test]
fn the_project_pluralizer_names_the_hop() {
    let none = load(&hop_doc("", "Consent", "", "consent"), collections("none"));
    assert!(hop_resolved(&none, "consent"), "{:?}", none.errors);
    let standard = load(
        &hop_doc("", "Consent", "", "consent"),
        PhysicalNaming::default(),
    );
    assert!(!hop_resolved(&standard, "consent"), "{:?}", standard.errors);
}
