//! Edge cases of the entity generator: names Rust reserves, names the prelude owns, models
//! with no package, and references the generator refuses to guess at.

mod common;

use std::collections::BTreeMap;

use common::Scratch;
use metaobjects_codegen::generator::{GenContext, GenError};
use metaobjects_codegen::project::load_project;
use metaobjects_codegen::{EntityGenerator, Generator};

fn generate(files: &[(&str, &str)]) -> Result<BTreeMap<String, String>, GenError> {
    generate_named(files, &[])
}

fn generate_named(
    files: &[(&str, &str)],
    entities: &[&str],
) -> Result<BTreeMap<String, String>, GenError> {
    let project = Scratch::project("edges", files);
    let loaded = load_project(project.path(), None, false).expect("the model loads clean");
    let names: Vec<String> = entities.iter().map(|e| e.to_string()).collect();
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &names,
    };
    EntityGenerator
        .generate(&ctx)
        .map(|f| f.into_iter().map(|f| (f.path, f.content)).collect())
}

fn model(package: &str, body: &str) -> String {
    let pkg = if package.is_empty() {
        String::new()
    } else {
        format!("\"package\": \"{package}\", ")
    };
    format!(r#"{{ "metadata.root": {{ {pkg}"children": [ {body} ] }} }}"#)
}

#[test]
fn reserved_words_become_raw_identifiers_and_self_gets_a_suffix() {
    let m = model(
        "kw",
        r#"{ "object.entity": { "name": "Thing", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.string": { "name": "type" } },
          { "field.string": { "name": "gen" } },
          { "field.string": { "name": "self" } },
          { "field.string": { "name": "match_" } }
        ] } }"#,
    );
    let out = generate(&[("metaobjects/meta.kw.json", &m)]).unwrap();
    let text = &out["kw/src/thing.rs"];
    assert!(text.contains("pub r#type: Option<String>"), "{text}");
    assert!(text.contains("pub r#gen: Option<String>"), "{text}");
    assert!(
        text.contains("#[serde(rename = \"self\")]\n    pub self_: Option<String>"),
        "{text}"
    );
}

#[test]
fn an_object_named_like_a_prelude_type_makes_the_crate_spell_std_paths_in_full() {
    let m = model(
        "pre",
        r#"{ "object.entity": { "name": "Option", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.string": { "name": "label" } },
          { "field.string": { "name": "tags", "isArray": true } }
        ] } },
        { "object.value": { "name": "Vec", "children": [ { "field.string": { "name": "x" } } ] } },
        { "object.value": { "name": "String", "children": [ { "field.string": { "name": "y" } } ] } }"#,
    );
    let out = generate(&[("metaobjects/meta.pre.json", &m)]).unwrap();
    let text = &out["pre/src/option.rs"];
    assert!(
        text.contains("pub label: std::option::Option<std::string::String>"),
        "{text}"
    );
    assert!(
        text.contains("pub tags: std::option::Option<std::vec::Vec<std::string::String>>"),
        "{text}"
    );
}

#[test]
fn a_model_with_no_package_becomes_the_model_crate() {
    let m = model(
        "",
        r#"{ "object.entity": { "name": "Solo", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }"#,
    );
    let out = generate(&[("metaobjects/meta.solo.json", &m)]).unwrap();
    assert!(out.contains_key("model/Cargo.toml"), "{:?}", out.keys());
    assert!(out["model/src/lib.rs"].contains("pub use solo::Solo;"));
}

#[test]
fn a_packaged_object_may_refer_to_a_package_less_one() {
    let root = model(
        "",
        r#"{ "object.value": { "name": "Money", "children": [ { "field.long": { "name": "cents" } } ] } }"#,
    );
    let app = model(
        "app",
        r#"{ "object.entity": { "name": "Bill", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.object": { "name": "due", "@objectRef": "Money" } }
        ] } }"#,
    );
    let out = generate(&[
        ("metaobjects/meta.root.json", &root),
        ("metaobjects/meta.app.json", &app),
    ])
    .unwrap();
    assert!(
        out["app/src/bill.rs"].contains("pub due: Option<model::Money>"),
        "{}",
        out["app/src/bill.rs"]
    );
    assert!(out["app/Cargo.toml"].contains("model = { path = \"../model\" }"));
}

#[test]
fn a_bare_object_ref_binds_the_own_package_first_like_the_loader() {
    // The loader's candidate order (ADR-0059 R2): from `app`, a bare `Foo` is `app::Foo`
    // first and the package-less `Foo` second. The oracle is the loader itself: it
    // validates the ref against `app::Foo`, so the generator must emit the same struct.
    let root = model(
        "",
        r#"{ "object.value": { "name": "Foo", "children": [ { "field.long": { "name": "cents" } } ] } }"#,
    );
    let app = model(
        "app",
        r#"{ "object.value": { "name": "Foo", "children": [ { "field.string": { "name": "label" } } ] } },
        { "object.entity": { "name": "Bill", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.object": { "name": "due", "@objectRef": "Foo" } }
        ] } }"#,
    );
    let out = generate(&[
        ("metaobjects/meta.root.json", &root),
        ("metaobjects/meta.app.json", &app),
    ])
    .unwrap();
    assert!(
        out["app/src/bill.rs"].contains("pub due: Option<crate::Foo>"),
        "{}",
        out["app/src/bill.rs"]
    );
    assert!(
        !out["app/Cargo.toml"].contains("model = { path"),
        "the ref stays in the app crate: {}",
        out["app/Cargo.toml"]
    );
    assert!(
        out["app/src/foo.rs"].contains("pub label"),
        "the app crate's Foo is app::Foo, not the package-less one: {}",
        out["app/src/foo.rs"]
    );
}

#[test]
fn an_inherited_object_ref_binds_from_the_package_that_declared_it() {
    // ADR-0059 R3: `Base.addr` was declared in `base`, so its bare `Address` is `base::Address`
    // for every struct that inherits the field, whatever package that struct lives in.
    let base = model(
        "base",
        r#"{ "object.value": { "name": "Address", "children": [ { "field.string": { "name": "street" } } ] } },
        { "object.value": { "name": "Base", "abstract": true, "children": [
          { "field.object": { "name": "addr", "@objectRef": "Address" } } ] } }"#,
    );
    let app = model(
        "app",
        r#"{ "object.value": { "name": "Address", "children": [ { "field.string": { "name": "label" } } ] } },
        { "object.value": { "name": "Thing", "extends": "base::Base" } }"#,
    );
    let out = generate(&[
        ("metaobjects/meta.base.json", &base),
        ("metaobjects/meta.app.json", &app),
    ])
    .unwrap();
    assert!(
        out["app/src/thing.rs"].contains("base::Address"),
        "{}",
        out["app/src/thing.rs"]
    );
    assert!(
        out["app/Cargo.toml"].contains("base = { path"),
        "{}",
        out["app/Cargo.toml"]
    );
}

#[test]
fn an_object_ref_the_loader_binds_to_an_abstract_object_is_refused_not_redirected() {
    // From `app`, a bare `Foo` is `app::Foo` first. That one is abstract, so nothing is
    // emitted for it, and the generator must say so instead of falling through to the
    // package-less `Foo` the loader did not choose.
    let root = model(
        "",
        r#"{ "object.value": { "name": "Foo", "children": [ { "field.long": { "name": "cents" } } ] } }"#,
    );
    let app = model(
        "app",
        r#"{ "object.value": { "name": "Foo", "abstract": true, "children": [ { "field.string": { "name": "label" } } ] } },
        { "object.value": { "name": "Bill", "children": [
          { "field.object": { "name": "due", "@objectRef": "Foo" } } ] } }"#,
    );
    let e = generate(&[
        ("metaobjects/meta.root.json", &root),
        ("metaobjects/meta.app.json", &app),
    ])
    .unwrap_err();
    assert!(e.message.contains("app::Bill.due"), "{}", e.message);
    assert!(e.message.contains("not a concrete"), "{}", e.message);
}

#[test]
fn a_parent_relative_object_ref_resolves_like_the_loader() {
    // `..::Foo` from `a::b` is `a::Foo` in the loader (`ObjectIndex::resolve`); the
    // generator must accept the same spelling, not refuse it.
    let a = model(
        "a",
        r#"{ "object.value": { "name": "Foo", "children": [ { "field.string": { "name": "label" } } ] } }"#,
    );
    let b = model(
        "a::b",
        r#"{ "object.entity": { "name": "Bill", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.object": { "name": "due", "@objectRef": "..::Foo" } }
        ] } }"#,
    );
    let out = generate(&[
        ("metaobjects/meta.a.json", &a),
        ("metaobjects/meta.b.json", &b),
    ])
    .unwrap();
    assert!(
        out["a_b/src/bill.rs"].contains("pub due: Option<a::Foo>"),
        "{}",
        out["a_b/src/bill.rs"]
    );
    assert!(out["a_b/Cargo.toml"].contains("a = { path = \"../a\" }"));
}

#[test]
fn a_bare_entity_name_that_matches_two_objects_is_an_error_not_a_guess() {
    let root = model(
        "",
        r#"{ "object.value": { "name": "Foo", "children": [ { "field.long": { "name": "cents" } } ] } }"#,
    );
    let app = model(
        "app",
        r#"{ "object.value": { "name": "Foo", "children": [ { "field.string": { "name": "label" } } ] } }"#,
    );
    let files: &[(&str, &str)] = &[
        ("metaobjects/meta.root.json", &root),
        ("metaobjects/meta.app.json", &app),
    ];
    let e = generate_named(files, &["Foo"]).unwrap_err();
    assert_eq!(e.code, "ERR_NAME_COLLISION");
    assert!(e.message.contains("app::Foo"), "{}", e.message);
    assert!(e.message.contains("more than one"), "{}", e.message);
    assert!(e.message.contains("::Name"), "{}", e.message);

    let package_less =
        generate_named(files, &["::Foo"]).expect("::Foo selects the package-less Foo");
    let packaged = generate_named(files, &["app::Foo"]).expect("app::Foo selects the packaged Foo");
    assert!(package_less.values().any(|c| c.contains("pub cents:")));
    assert!(!package_less.values().any(|c| c.contains("pub label:")));
    assert!(packaged.values().any(|c| c.contains("pub label:")));
    assert!(!packaged.values().any(|c| c.contains("pub cents:")));
}

#[test]
fn a_shared_enum_in_another_package_cannot_join_a_struct_crate() {
    let ab = model(
        "a::b",
        r#"{ "object.entity": { "name": "Thing", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.enum": { "name": "color", "extends": "a_b::Color" } }
        ] } }"#,
    );
    let a_b = model(
        "a_b",
        r#"{ "field.enum": { "name": "Color", "abstract": true, "@values": ["red", "blue"] } }"#,
    );
    let e = generate(&[
        ("metaobjects/meta.ab.json", &ab),
        ("metaobjects/meta.a_b.json", &a_b),
    ])
    .unwrap_err();
    assert_eq!(e.code, "ERR_NAME_COLLISION");
    assert!(
        e.message.contains("a::b") && e.message.contains("a_b"),
        "{}",
        e.message
    );
}

#[test]
fn two_packages_that_only_own_shared_enums_cannot_share_a_crate() {
    let ab = model(
        "a::b",
        r#"{ "field.enum": { "name": "Color", "abstract": true, "@values": ["red", "blue"] } }"#,
    );
    let a_b = model(
        "a_b",
        r#"{ "field.enum": { "name": "Shade", "abstract": true, "@values": ["dark", "light"] } }"#,
    );
    let user = model(
        "app",
        r#"{ "object.entity": { "name": "Thing", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.enum": { "name": "color", "extends": "a::b::Color" } },
          { "field.enum": { "name": "shade", "extends": "a_b::Shade" } }
        ] } }"#,
    );
    let e = generate(&[
        ("metaobjects/meta.ab.json", &ab),
        ("metaobjects/meta.a_b.json", &a_b),
        ("metaobjects/meta.app.json", &user),
    ])
    .unwrap_err();
    assert_eq!(e.code, "ERR_NAME_COLLISION");
}

#[test]
fn two_enum_members_that_become_one_variant_are_an_error() {
    let m = model(
        "en",
        r#"{ "object.entity": { "name": "Thing", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.enum": { "name": "kind", "@normalize": "none", "@values": ["in_flight", "IN_FLIGHT"] } }
        ] } }"#,
    );
    let e = generate(&[("metaobjects/meta.en.json", &m)]).unwrap_err();
    assert_eq!(e.code, "ERR_NAME_COLLISION");
}

#[test]
fn a_reference_to_something_that_is_not_a_struct_is_refused_by_name() {
    let m = model(
        "pr",
        r#"{ "object.entity": { "name": "Base", "abstract": true, "children": [
          { "field.string": { "name": "x" } } ] } },
        { "object.entity": { "name": "Thing", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.object": { "name": "view", "@objectRef": "Base" } }
        ] } }"#,
    );
    let e = generate(&[("metaobjects/meta.pr.json", &m)]).unwrap_err();
    assert_eq!(e.code, "ERR_RUST_UNSUPPORTED");
    assert!(e.message.contains("pr::Thing.view"), "{}", e.message);
}

#[test]
fn a_long_field_line_keeps_rustfmt_from_reflowing_the_struct() {
    let m = model(
        "wide",
        r#"{ "object.entity": { "name": "Thing", "children": [
          { "field.long": { "name": "id" } },
          { "identity.primary": { "name": "pk", "@fields": ["id"] } },
          { "field.map": { "name": "aVeryLongFieldNameThatKeepsGoingAndGoingForNoGoodReasonAtAll", "@valueType": "string" } }
        ] } }"#,
    );
    let out = generate(&[("metaobjects/meta.wide.json", &m)]).unwrap();
    assert!(out["wide/src/thing.rs"].contains("#[rustfmt::skip]"));
}
