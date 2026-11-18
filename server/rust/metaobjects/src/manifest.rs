//! The registry manifest: the registry written as the canonical JSON every port
//! must produce byte for byte (`fixtures/registry-conformance/expected-registry.json`).

use serde_json::{Map, Value, json};

use crate::json::{js_display, to_js_pretty};
use crate::registry::{AttrSchema, ChildRule, ChildSubType, TypeDefinition, TypeRegistry};

/// The metamodel version this build implements.
pub const METAMODEL_VERSION: &str = "1.3";

/// Per-type attrs that are structural keywords or common-attr duplicates, so they
/// stay out of the manifest's per-type rows.
const EXCLUDED_PER_TYPE_ATTRS: &[&str] = &[
    "isArray",
    "isAbstract",
    "extends",
    "implements",
    "isInterface",
    "description",
];

fn sorted(list: &[String]) -> Value {
    let mut l = list.to_vec();
    l.sort();
    json!(l)
}

fn manifest_attr(attr: &AttrSchema) -> Value {
    let legacy = attr.value_type.as_deref() == Some("stringarray");
    let mut m = Map::new();
    m.insert("name".into(), json!(attr.name));
    let value_type = if legacy {
        json!("string")
    } else {
        attr.value_type.as_ref().map_or(Value::Null, |v| json!(v))
    };
    m.insert("valueType".into(), value_type);
    m.insert(
        "isArray".into(),
        json!(attr.is_array == Some(true) || legacy),
    );
    m.insert("required".into(), json!(attr.required));
    if let Some(values) = attr.allowed_values.as_ref().filter(|v| !v.is_empty()) {
        m.insert(
            "allowedValues".into(),
            Value::Array(values.iter().map(|v| json!(js_display(v))).collect()),
        );
    }
    if let Some(list) = attr.implemented_in.as_ref().filter(|v| !v.is_empty()) {
        m.insert("implementedIn".into(), sorted(list));
    }
    if let Some(list) = attr.ports.as_ref().filter(|v| !v.is_empty()) {
        m.insert("ports".into(), sorted(list));
    }
    m.insert("description".into(), json!(attr.description));
    for (key, val) in [
        ("rules", &attr.rules),
        ("example", &attr.example),
        ("whenToUse", &attr.when_to_use),
    ] {
        if let Some(v) = val {
            m.insert(key.into(), json!(v));
        }
    }
    Value::Object(m)
}

fn sub_type_key(sub: &ChildSubType) -> String {
    match sub {
        ChildSubType::One(s) => s.clone(),
        ChildSubType::Many(list) => list.join(","),
    }
}

fn manifest_child(rule: &ChildRule) -> Value {
    let mut m = Map::new();
    m.insert("childType".into(), json!(rule.child_type));
    let sub = match &rule.child_sub_type {
        ChildSubType::One(s) => json!(s),
        ChildSubType::Many(list) => json!(list),
    };
    m.insert("childSubType".into(), sub);
    m.insert("childName".into(), json!(rule.child_name));
    if let Some(min) = rule.min {
        m.insert("min".into(), json!(min));
    }
    if let Some(max) = rule.max {
        m.insert("max".into(), max.map_or(Value::Null, |v| json!(v)));
    }
    if let Some(named) = rule.named {
        m.insert("named".into(), json!(named));
    }
    Value::Object(m)
}

fn sorted_attrs<'a>(attrs: impl Iterator<Item = &'a AttrSchema>) -> Vec<Value> {
    let mut list: Vec<&AttrSchema> = attrs.collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list.into_iter().map(manifest_attr).collect()
}

fn manifest_type(def: &TypeDefinition) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!(def.type_name));
    m.insert("subType".into(), json!(def.sub_type));
    if let Some(list) = def.implemented_in.as_ref().filter(|v| !v.is_empty()) {
        m.insert("implementedIn".into(), sorted(list));
    }
    m.insert("description".into(), json!(def.description));
    for (key, val) in [
        ("rules", &def.rules),
        ("example", &def.example),
        ("whenToUse", &def.when_to_use),
    ] {
        if let Some(v) = val {
            m.insert(key.into(), json!(v));
        }
    }
    let attrs = sorted_attrs(
        def.attributes
            .iter()
            .filter(|a| !EXCLUDED_PER_TYPE_ATTRS.contains(&a.name.as_str())),
    );
    m.insert("attrs".into(), Value::Array(attrs));
    let mut rules: Vec<&ChildRule> = def.child_rules.iter().collect();
    rules.sort_by(|a, b| {
        a.child_type
            .cmp(&b.child_type)
            .then_with(|| sub_type_key(&a.child_sub_type).cmp(&sub_type_key(&b.child_sub_type)))
            .then_with(|| a.child_name.cmp(&b.child_name))
    });
    m.insert(
        "children".into(),
        Value::Array(rules.into_iter().map(manifest_child).collect()),
    );
    if let Some(parents) = def.parents.as_ref().filter(|p| !p.is_empty()) {
        m.insert("parents".into(), sorted(parents));
    }
    Value::Object(m)
}

/// Build the manifest as a JSON value.
pub fn build_manifest(registry: &TypeRegistry) -> Value {
    let mut defs: Vec<&TypeDefinition> = registry
        .all()
        .filter(|d| !(d.type_name == "metadata" && d.sub_type == "base"))
        .collect();
    defs.sort_by_key(|a| a.key());
    let mut type_names: Vec<&str> = defs.iter().map(|d| d.type_name.as_str()).collect();
    type_names.sort();
    type_names.dedup();
    let mut defaults = Map::new();
    for name in type_names {
        if let Some(sub) = registry.default_sub_type_of(name) {
            defaults.insert(name.to_string(), json!(sub));
        }
    }
    let mut m = Map::new();
    m.insert("metamodelVersion".into(), json!(METAMODEL_VERSION));
    m.insert(
        "types".into(),
        Value::Array(defs.into_iter().map(manifest_type).collect()),
    );
    m.insert(
        "commonAttrs".into(),
        Value::Array(sorted_attrs(registry.common_attrs().iter())),
    );
    m.insert("defaultSubTypes".into(), Value::Object(defaults));
    Value::Object(m)
}

/// The manifest as text, exactly as the shared fixture holds it.
pub fn emit_manifest(registry: &TypeRegistry) -> String {
    let mut out = to_js_pretty(&build_manifest(registry));
    out.push('\n');
    out
}
