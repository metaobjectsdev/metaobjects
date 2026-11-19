//! `validateExtenderSubtypeScope`: the legacy warning the corpus does not pin.

use metaobjects::loader::Loader;
use metaobjects::providers::default_registry;

fn warnings(extra: &str, extends_abstract: bool, filter: &str, own_identity: &str) -> Vec<String> {
    let abs = if extends_abstract {
        r#""abstract": true,"#
    } else {
        ""
    };
    let doc = format!(
        r#"{{"metadata.root": {{"package": "acme", "children": [
        {{"object.entity": {{"name": "Vehicle", "@discriminator": "kind", "children": [
          {{"source.rdb": {{"@table": "vehicles"}}}}, {{"field.long": {{"name": "id"}}}},
          {{"field.string": {{"name": "kind", "@maxLength": 10}}}},
          {{"identity.primary": {{"@fields": "id"}}}}]}}}},
        {{"object.entity": {{"name": "Truck", "extends": "Vehicle", "@discriminatorValue": "TRUCK", "children": [
          {{"field.string": {{"name": "payloadClass"}}}}]}}}},
        {{"object.projection": {{"name": "VehicleBase", "abstract": true, "children": [
          {{"field.long": {{"name": "vehicleId", "extends": "Vehicle.id"}}}},
          {{"identity.primary": {{"name": "id", "extends": "Vehicle.primary"}}}}]}}}},
        {{"object.projection": {{"name": "TruckRow", "extends": "VehicleBase", {abs} {filter}
          "children": [
          {{"source.rdb": {{"@kind": "view", "@view": "v_trucks"}}}},
          {{"field.string": {{"name": "payload", "extends": "Truck.payloadClass"}}}}{own_identity}{extra}]}}}}
        ]}}}}"#
    );
    let registry = default_registry().expect("the built-in providers compose");
    let r = Loader::new(&registry).load_sources(&[("meta.a.json".to_string(), doc)]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    r.warnings
        .iter()
        .map(|w| w.message.clone())
        .filter(|m| m.contains("TruckRow"))
        .collect()
}

#[test]
fn warns_with_the_reference_message() {
    let w = warnings("", false, "", "");
    assert_eq!(w.len(), 1, "{w:?}");
    assert_eq!(
        w[0],
        "object.projection TruckRow: \"payload\" (Truck.payloadClass) read columns only a subtype carries, over the TPH base Vehicle with no @filter on its discriminator \"kind\", so the view returns every Vehicle row (rc.21: an extender keeps its super's identity anchor; before, its base was the subtype). To keep a subtype-scoped view, add @filter { kind: <value> } or declare identity.primary { extends: Truck.primary }."
    );
}

#[test]
fn an_abstract_extender_does_not_warn() {
    assert!(warnings("", true, "", "").is_empty());
}

#[test]
fn a_discriminator_filter_scopes_it() {
    assert!(warnings("", false, r#""@filter": {"kind": "TRUCK"},"#, "").is_empty());
}

#[test]
fn its_own_identity_scopes_it() {
    let own = r#", {"field.long": {"name": "vehicleId", "extends": "Truck.id"}},
        {"identity.primary": {"name": "id", "extends": "Truck.primary"}}"#;
    assert!(warnings("", false, "", own).is_empty());
}
