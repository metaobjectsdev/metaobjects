//! `validateAttrSchema`: each node's `@`-attributes against its registered
//! `(type, subType)` schema, plus the strict-load provenance and child-placement
//! checks (ADR-0023, FR-033) and the `field.enum` / `@dbColumnType` content rules the
//! reference keeps in the same pass.
//!
//! Not ported: the reference's retired-vocabulary hints (`retired-vocabulary.ts`)
//! append a migration note to the `ERR_UNKNOWN_ATTR` / bad-value message and attach
//! suggestions. They change no load outcome, only message text.

use std::collections::HashMap;

use serde_json::{Map, Value};

use crate::errors::{
    ERR_BAD_ATTR_VALUE, ERR_MISSING_REQUIRED_ATTR, ERR_PROVIDER_ATTR_CONFLICT, ERR_UNKNOWN_ATTR,
};
use crate::json::{js_display, js_number};
use crate::node::{NodeId, Tree};
use crate::registry::{AttrSchema, TypeDefinition};
use crate::validate::structure::preorder;
use crate::validate::util::error_at;
use crate::validate::{Ctx, Findings};

pub const ERR_CHILD_NOT_ALLOWED: &str = "ERR_CHILD_NOT_ALLOWED";
pub const ERR_ENUM_EXTENDS_VALUES_CONFLICT: &str = "ERR_ENUM_EXTENDS_VALUES_CONFLICT";

const TYPE_FIELD: &str = "field";
const TYPE_METADATA: &str = "metadata";
const SUB_ENUM: &str = "enum";
const SUB_STRING: &str = "string";
const ATTR_SUBTYPE_PROPERTIES: &str = "properties";
const ATTR_SUBTYPE_STRINGARRAY: &str = "stringarray";
const A_VALUES: &str = "values";
const A_COERCE_DEFAULT: &str = "coerceDefault";
const A_DEFAULT: &str = "default";
const A_INT_VALUE_MAP: &str = "intValueMap";
const A_STRING_VALUE_MAP: &str = "stringValueMap";
const A_DB_COLUMN_TYPE: &str = "dbColumnType";
const A_MAX_LENGTH: &str = "maxLength";
const INT32_MIN: f64 = -2_147_483_648.0;
const INT32_MAX: f64 = 2_147_483_647.0;

/// What one `(type, subType)` accepts, built once per type: its own attributes, then
/// the common attributes it does not already declare.
struct Effective<'r> {
    by_name: HashMap<&'r str, &'r AttrSchema>,
    required: Vec<&'r AttrSchema>,
    /// The first common attribute that collides with a per-type one, until reported.
    pending_conflict: Option<&'r str>,
    def: Option<&'r TypeDefinition>,
}

fn label(tree: &Tree, id: NodeId) -> String {
    let n = tree.node(id);
    if n.name.is_empty() {
        format!("{}.{}", n.type_name, n.sub_type)
    } else {
        format!("{}.{} '{}'", n.type_name, n.sub_type, n.name)
    }
}

fn runtime_type_name(v: &Value) -> &'static str {
    match v {
        Value::Array(_) => "array",
        Value::Object(_) | Value::Null => "object",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
    }
}

fn is_integer(v: &Value) -> bool {
    match v {
        Value::Number(n) => {
            n.is_i64() || n.is_u64() || n.as_f64().is_some_and(crate::json::is_js_integer)
        }
        _ => false,
    }
}

/// A MetaAttr's `validateValue`, dispatched on the attr subtype.
fn validate_value(sub_type: &str, name: &str, value: &Value) -> Vec<String> {
    let type_error = |sub: &str| {
        vec![format!(
            "attribute '@{name}' must be of type '{sub}' but got {}",
            runtime_type_name(value)
        )]
    };
    let object_shape = matches!(value, Value::Object(_));
    match sub_type {
        ATTR_SUBTYPE_STRINGARRAY => match value {
            Value::Array(a) if a.iter().all(Value::is_string) => Vec::new(),
            _ => vec![format!(
                "attribute '@{name}' must be a string[] but got {}",
                runtime_type_name(value)
            )],
        },
        "filter" | ATTR_SUBTYPE_PROPERTIES | "expression" => {
            if object_shape {
                Vec::new()
            } else {
                type_error(sub_type)
            }
        }
        "intMap" => {
            let Value::Object(map) = value else {
                return type_error("intMap");
            };
            let mut errors = Vec::new();
            for (key, member) in map {
                if !is_integer(member) {
                    errors.push(format!(
                        "attribute '@{name}' member '{key}' has value '{}' which is not an integer",
                        js_display(member)
                    ));
                } else if let Some(x) = member
                    .as_f64()
                    .filter(|x| !(INT32_MIN..=INT32_MAX).contains(x))
                {
                    errors.push(format!(
                        "attribute '@{name}' member '{key}' has value '{}' which is outside the 32-bit signed integer range",
                        js_display(&Value::from(x as i64))
                    ));
                }
            }
            errors
        }
        "int" | "long" => match value {
            Value::Number(n) if is_integer(value) => {
                let _ = n;
                Vec::new()
            }
            Value::Number(n) => vec![format!(
                "attribute '@{name}' must be of type '{sub_type}' but got the fraction {}; this attribute is integral, so write an integer (for a validator @min/@max, use an integer bound)",
                js_number(n)
            )],
            _ => type_error(sub_type),
        },
        "double" => {
            if value.is_number() {
                Vec::new()
            } else {
                type_error(sub_type)
            }
        }
        "boolean" => {
            if value.is_boolean() {
                Vec::new()
            } else {
                type_error(sub_type)
            }
        }
        // string, class, base and anything unmapped read as a string attr.
        _ => {
            if value.is_string() {
                Vec::new()
            } else {
                type_error(sub_type)
            }
        }
    }
}

/// `Array.prototype.includes` equality: numbers by value, everything else structural.
fn js_same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn is_enum_member(m: &str) -> bool {
    let mut chars = m.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A `@dbColumnType` value parsed: `Some(None)` unsized, `Some(Some(n))` sized.
fn parse_db_column_type(v: &str) -> Option<Option<u64>> {
    match v {
        "uuid" | "jsonb" | "text" | "varchar" | "character varying" => return Some(None),
        _ => {}
    }
    let (head, rest) = v.split_once('(')?;
    if !matches!(head, "varchar" | "character varying" | "character") {
        return None;
    }
    let digits = rest.strip_suffix(')')?;
    let ok = (1..=9).contains(&digits.len())
        && !digits.starts_with('0')
        && digits.bytes().all(|b| b.is_ascii_digit());
    if !ok {
        return None;
    }
    let n = digits.parse().ok()?;
    Some(Some(n))
}

const DB_COLUMN_TYPE_PAIRINGS: &str = "uuid (field.string), jsonb (field.string), text (field.string), varchar (field.string), character varying (field.string), varchar(n) (field.string), character varying(n) (field.string), character(n) (field.string)";

fn enum_members(tree: &Tree, id: NodeId) -> Vec<String> {
    match tree.attr(id, A_VALUES) {
        Some(Value::Array(a)) => a.iter().map(js_display).collect(),
        _ => Vec::new(),
    }
}

fn is_shared_enum_declaration(tree: &Tree, id: Option<NodeId>) -> bool {
    id.is_some_and(|s| {
        let n = tree.node(s);
        n.type_name == TYPE_FIELD
            && n.sub_type == SUB_ENUM
            && n.is_abstract
            && n.parent
                .is_some_and(|p| tree.node(p).type_name == TYPE_METADATA)
    })
}

fn own_value<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a Value> {
    tree.own_attr(id, name).map(|a| &a.value)
}

fn check_enum(tree: &Tree, id: NodeId, out: &mut Findings) {
    let lbl = label(tree, id);
    let super_node = tree.node(id).super_node;
    let shared = is_shared_enum_declaration(tree, super_node);
    let shared_label = || super_node.map(|s| label(tree, s)).unwrap_or_default();
    let mut push = |code: &'static str, msg: String| out.errors.push(error_at(tree, id, code, msg));

    // Check 4: @values content.
    if let Some(Value::Array(raw)) = own_value(tree, id, A_VALUES) {
        if raw.is_empty() {
            push(
                ERR_BAD_ATTR_VALUE,
                format!("{lbl} must declare at least one value in '@{A_VALUES}'."),
            );
        } else {
            let mut seen: Vec<String> = Vec::new();
            for m in raw {
                let m = js_display(m);
                if !is_enum_member(&m) {
                    push(
                        ERR_BAD_ATTR_VALUE,
                        format!(
                            "{lbl} attribute '@{A_VALUES}' member '{m}' is not a valid identifier (must match ^[A-Za-z_][A-Za-z0-9_]*$). Non-identifier-safe member strings require a symbol↔value mapping (deferred)."
                        ),
                    );
                } else if seen.contains(&m) {
                    push(
                        ERR_BAD_ATTR_VALUE,
                        format!("{lbl} attribute '@{A_VALUES}' has duplicate member '{m}'."),
                    );
                } else {
                    seen.push(m);
                }
            }
        }
        if shared {
            push(
                ERR_ENUM_EXTENDS_VALUES_CONFLICT,
                format!(
                    "{lbl} extends shared abstract enum '{}' AND declares its own '@{A_VALUES}' — a shared enum's member set is owned by the shared declaration; remove the own '@{A_VALUES}' to inherit it, or extend a non-shared enum instead.",
                    shared_label()
                ),
            );
        }
    }

    // Check 5: enum fallback attrs name a member.
    let members = enum_members(tree, id);
    for attr in [A_COERCE_DEFAULT, A_DEFAULT] {
        if let Some(Value::String(v)) = own_value(tree, id, attr)
            && !members.contains(v)
        {
            push(
                ERR_BAD_ATTR_VALUE,
                format!(
                    "{lbl} attribute '@{attr}' value '{v}' is not one of '@{A_VALUES}': {}.",
                    members.join(", ")
                ),
            );
        }
    }

    // Check 5b: @intValueMap content.
    if let Some(Value::Object(map)) = own_value(tree, id, A_INT_VALUE_MAP) {
        if shared {
            push(
                ERR_ENUM_EXTENDS_VALUES_CONFLICT,
                format!(
                    "{lbl} extends shared abstract enum '{}' AND declares its own '@{A_INT_VALUE_MAP}' — a shared enum's integer backing is owned by the shared declaration; move '@{A_INT_VALUE_MAP}' onto '{}' to inherit it, or extend a non-shared enum instead.",
                    shared_label(),
                    shared_label()
                ),
            );
        }
        let (missing, extra) = key_diff(&members, map);
        if !missing.is_empty() || !extra.is_empty() {
            push(
                ERR_BAD_ATTR_VALUE,
                format!(
                    "{lbl} attribute '@{A_INT_VALUE_MAP}' keys must exactly match '@{A_VALUES}' members{}{}.",
                    list_note(" (missing: ", &missing),
                    list_note(" (unknown: ", &extra)
                ),
            );
        }
        let mut seen: Vec<(i64, &str)> = Vec::new();
        for (member, value) in map {
            let Some(n) = value.as_i64().filter(|_| is_integer(value)) else {
                continue; // reported by the attr's own shape check
            };
            match seen.iter().find(|(v, _)| *v == n) {
                Some((_, owner)) => push(
                    ERR_BAD_ATTR_VALUE,
                    format!(
                        "{lbl} attribute '@{A_INT_VALUE_MAP}' members '{owner}' and '{member}' share the same value {n}; every member must have a unique int."
                    ),
                ),
                None => seen.push((n, member)),
            }
        }
    }

    // Check 5c: @stringValueMap content.
    if let Some(raw) = own_value(tree, id, A_STRING_VALUE_MAP) {
        let mut bad = |code: &'static str, msg: String| {
            push(
                code,
                format!("{lbl} attribute '@{A_STRING_VALUE_MAP}' {msg}"),
            );
        };
        if shared {
            bad(
                ERR_ENUM_EXTENDS_VALUES_CONFLICT,
                format!(
                    "is declared on a field extending shared abstract enum '{}' — a shared enum's stored strings are owned by the shared declaration; move it onto '{}' to inherit it.",
                    shared_label(),
                    shared_label()
                ),
            );
        } else if tree.attr(id, A_INT_VALUE_MAP).is_some() {
            bad(
                ERR_BAD_ATTR_VALUE,
                format!(
                    "is refused beside '@{A_INT_VALUE_MAP}': an @intValueMap enum is stored as integers, not strings. Keep one."
                ),
            );
        } else if tree.resolved_is_array(id) {
            bad(
                ERR_BAD_ATTR_VALUE,
                format!(
                    "is refused on an array enum: its column holds the members as text[] elements, which no port maps through @{A_STRING_VALUE_MAP}."
                ),
            );
        } else if let Value::Object(map) = raw {
            let (missing, extra) = key_diff(&members, map);
            if !missing.is_empty() || !extra.is_empty() {
                bad(
                    ERR_BAD_ATTR_VALUE,
                    format!(
                        "keys must exactly match '@{A_VALUES}' members{}{}.",
                        list_note(" (missing: ", &missing),
                        list_note(" (unknown: ", &extra)
                    ),
                );
            }
            let mut seen: Vec<(&str, &str)> = Vec::new();
            for (member, value) in map {
                match value.as_str().filter(|s| !s.is_empty()) {
                    None => bad(
                        ERR_BAD_ATTR_VALUE,
                        format!("member '{member}' must map to a non-empty string."),
                    ),
                    Some(s) => match seen.iter().find(|(v, _)| *v == s) {
                        Some((_, owner)) => bad(
                            ERR_BAD_ATTR_VALUE,
                            format!(
                                "members '{owner}' and '{member}' share the stored string '{s}'; every member must have a unique one."
                            ),
                        ),
                        None => seen.push((s, member)),
                    },
                }
            }
        } else {
            bad(
                ERR_BAD_ATTR_VALUE,
                "must be an object of { member: storedString }.".to_string(),
            );
        }
    }
}

fn key_diff(members: &[String], map: &Map<String, Value>) -> (Vec<String>, Vec<String>) {
    let missing = members
        .iter()
        .filter(|m| !map.contains_key(m.as_str()))
        .cloned()
        .collect();
    let extra = map
        .keys()
        .filter(|k| !members.contains(k))
        .cloned()
        .collect();
    (missing, extra)
}

fn list_note(prefix: &str, items: &[String]) -> String {
    if items.is_empty() {
        String::new()
    } else {
        format!("{prefix}{})", items.join(", "))
    }
}

/// Check 6: `@dbColumnType` pairing and the `@maxLength` it must hold.
fn check_db_column_type(tree: &Tree, id: NodeId, out: &mut Findings) {
    // ADR-0039: own: @dbColumnType is physical and never inherited.
    let Some(Value::String(value)) = own_value(tree, id, A_DB_COLUMN_TYPE) else {
        return;
    };
    let lbl = label(tree, id);
    let sub = &tree.node(id).sub_type;
    let parsed = parse_db_column_type(value);
    if parsed.is_none() || sub != SUB_STRING {
        out.errors.push(error_at(
            tree,
            id,
            ERR_BAD_ATTR_VALUE,
            format!(
                "{lbl} attribute '@{A_DB_COLUMN_TYPE}' value '{value}' is not legal on field.{sub}. Legal @{A_DB_COLUMN_TYPE} pairings: {DB_COLUMN_TYPE_PAIRINGS}."
            ),
        ));
    } else if let (Some(Some(length)), Some(Value::Number(max))) =
        (parsed, tree.attr(id, A_MAX_LENGTH))
        && max.as_f64().is_some_and(|m| m > length as f64)
    {
        out.errors.push(error_at(
            tree,
            id,
            ERR_BAD_ATTR_VALUE,
            format!(
                "{lbl} declares @{A_MAX_LENGTH}: {} over '@{A_DB_COLUMN_TYPE}: {value}', which holds {length}; a value the field accepts would not fit the column.",
                js_number(max)
            ),
        ));
    }
}

/// Run the attribute-schema pass.
pub fn attr_schema(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let registry = ctx.registry;
    let mut cache: HashMap<(&str, &str), Effective<'_>> = HashMap::new();
    for id in preorder(tree, ctx.root) {
        let node = tree.node(id);
        let eff = cache
            .entry((node.type_name.as_str(), node.sub_type.as_str()))
            .or_insert_with(|| {
                let def = registry.find(&node.type_name, &node.sub_type);
                let mut by_name: HashMap<&str, &AttrSchema> = HashMap::new();
                let mut required = Vec::new();
                for a in def.map_or(&[][..], |d| d.attributes.as_slice()) {
                    by_name.insert(a.name.as_str(), a);
                    if a.required {
                        required.push(a);
                    }
                }
                let mut pending_conflict = None;
                for ca in registry.common_attrs() {
                    if by_name.contains_key(ca.name.as_str()) {
                        pending_conflict.get_or_insert(ca.name.as_str());
                    } else {
                        by_name.insert(ca.name.as_str(), ca);
                        if ca.required {
                            required.push(ca);
                        }
                    }
                }
                Effective {
                    by_name,
                    required,
                    pending_conflict,
                    def,
                }
            });
        let type_key = || format!("{}.{}", node.type_name, node.sub_type);

        if let Some(name) = eff.pending_conflict.take() {
            out.errors.push(error_at(
                tree,
                id,
                ERR_PROVIDER_ATTR_CONFLICT,
                format!(
                    "Common attr '{name}' conflicts with per-type attr on {}",
                    type_key()
                ),
            ));
        }

        if ctx.strict {
            // Check 0 (ADR-0023): an own attribute no schema declares.
            // ADR-0039: own: an inherited attribute was validated on its declaring node.
            for (name, attr) in tree.own_attrs(id) {
                if attr.sub_type == ATTR_SUBTYPE_PROPERTIES
                    || eff.by_name.contains_key(name.as_str())
                {
                    continue;
                }
                out.errors.push(error_at(
                    tree,
                    id,
                    ERR_UNKNOWN_ATTR,
                    format!(
                        "Unknown attribute '@{name}' on {} — not declared by any registered provider for {}",
                        label(tree, id),
                        type_key()
                    ),
                ));
            }
            // Check 0b (FR-033): structural child placement.
            if let Some(def) = eff.def {
                // ADR-0039: own: an inherited child was placement-checked on its declarer.
                for &child in tree.own_children(id) {
                    let c = tree.node(child);
                    if !def
                        .child_rules
                        .iter()
                        .any(|r| r.matches(&c.type_name, &c.sub_type, &c.name))
                    {
                        out.errors.push(error_at(
                            tree,
                            id,
                            ERR_CHILD_NOT_ALLOWED,
                            format!(
                                "Child {} is not allowed under {} — no registered child rule for {} admits (type='{}', subType='{}', name='{}')",
                                label(tree, child),
                                label(tree, id),
                                type_key(),
                                c.type_name,
                                c.sub_type,
                                c.name
                            ),
                        ));
                    }
                }
            }
        }

        if !eff.by_name.is_empty() {
            // Check 1: required attributes, inherited ones counting (abstract nodes are templates).
            if !node.is_abstract {
                for spec in &eff.required {
                    if tree.attr(id, &spec.name).is_none() {
                        out.errors.push(error_at(
                            tree,
                            id,
                            ERR_MISSING_REQUIRED_ATTR,
                            format!(
                                "{} is missing required attribute '@{}'",
                                label(tree, id),
                                spec.name
                            ),
                        ));
                    }
                }
            }
            // Checks 2 + 3: well-typed and in range.
            // ADR-0039: own: an inherited attribute was validated on its declaring node.
            for (name, attr) in tree.own_attrs(id) {
                let Some(spec) = eff.by_name.get(name.as_str()) else {
                    continue;
                };
                let value = &attr.value;
                // A null value is an attribute that was authored but left unset (YAML `~`):
                // the reference's tree builder drops it, so it is never judged.
                if value.is_null() {
                    continue;
                }
                if spec.value_type.is_some() {
                    let errors = validate_value(&attr.sub_type, name, value);
                    if !errors.is_empty() {
                        for e in errors {
                            out.errors.push(error_at(
                                tree,
                                id,
                                ERR_BAD_ATTR_VALUE,
                                format!("{} {e}", label(tree, id)),
                            ));
                        }
                        continue;
                    }
                }
                let Some(allowed) = spec
                    .allowed_values
                    .as_deref()
                    .filter(|a| !a.is_empty() && name != A_DB_COLUMN_TYPE)
                else {
                    continue;
                };
                let offenders: Vec<&Value> = match value {
                    Value::Array(items) => items
                        .iter()
                        .filter(|v| !allowed.iter().any(|a| js_same(a, v)))
                        .collect(),
                    v if allowed.iter().any(|a| js_same(a, v)) => Vec::new(),
                    v => vec![v],
                };
                for bad in offenders {
                    out.errors.push(error_at(
                        tree,
                        id,
                        ERR_BAD_ATTR_VALUE,
                        format!(
                            "{} attribute '@{name}' has value '{}' which is not one of the allowed values: {}",
                            label(tree, id),
                            js_display(bad),
                            allowed.iter().map(js_display).collect::<Vec<_>>().join(", ")
                        ),
                    ));
                }
            }
        }

        // Checks 4-6 run after the schema returns early in the reference only when the
        // node has no schema at all, and field nodes always have one.
        if node.type_name == TYPE_FIELD && !eff.by_name.is_empty() {
            if node.sub_type == SUB_ENUM {
                check_enum(tree, id, out);
            }
            check_db_column_type(tree, id, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_code_is_in_the_shared_catalogue() {
        let raw = include_str!("../../../../../fixtures/conformance/ERROR-CODES.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for code in [ERR_CHILD_NOT_ALLOWED, ERR_ENUM_EXTENDS_VALUES_CONFLICT] {
            assert!(
                codes.contains_key(code),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }

    #[test]
    fn value_shapes_follow_the_attr_subtype() {
        assert!(validate_value("int", "n", &json!(4.0)).is_empty());
        assert!(validate_value("int", "n", &json!(4)).is_empty());
        assert!(validate_value("int", "n", &json!(4.5))[0].contains("fraction 4.5"));
        assert!(validate_value("boolean", "b", &json!("x"))[0].contains("got string"));
        assert!(validate_value("stringarray", "f", &json!(["a", 1]))[0].contains("string[]"));
        assert!(validate_value("filter", "f", &json!("legacy"))[0].contains("'filter'"));
        assert_eq!(
            validate_value("intMap", "m", &json!({"a": 1, "b": 1.5})).len(),
            1
        );
        assert!(
            validate_value("intMap", "m", &json!({"a": 3_000_000_000_i64}))[0].contains("32-bit")
        );
    }

    #[test]
    fn db_column_types_parse_like_the_reference() {
        assert_eq!(parse_db_column_type("uuid"), Some(None));
        assert_eq!(parse_db_column_type("varchar(40)"), Some(Some(40)));
        assert_eq!(parse_db_column_type("character(3)"), Some(Some(3)));
        assert_eq!(parse_db_column_type("varchar(0)"), None);
        assert_eq!(parse_db_column_type("varchar(1234567890)"), None);
        assert_eq!(parse_db_column_type("char(3)"), None);
    }
}
