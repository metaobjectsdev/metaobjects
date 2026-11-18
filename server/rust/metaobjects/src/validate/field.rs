//! Field-level validation: the field.enum / `@dbColumnType` rules the TypeScript
//! reference keeps in `validateAttrSchema` (Checks 4, 5, 5b, 5c, 6), and the passes
//! `validateFieldObjectStorage`, `validateFieldMap`, `validateEnumMaxLength` and
//! `validateFieldDefaults`.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::util::error_at;
use super::{Ctx, Findings};
use crate::errors::{ERR_BAD_ATTR_VALUE, MetaError};
use crate::node::NodeId;

pub const ERR_ENUM_EXTENDS_VALUES_CONFLICT: &str = "ERR_ENUM_EXTENDS_VALUES_CONFLICT";
pub const ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH: &str = "ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH";
pub const ERR_ENUM_MAX_LENGTH_WITH_INT_VALUE_MAP: &str = "ERR_ENUM_MAX_LENGTH_WITH_INT_VALUE_MAP";
pub const ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF: &str = "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF";
pub const ERR_STORAGE_FLATTENED_ARRAY: &str = "ERR_STORAGE_FLATTENED_ARRAY";
pub const ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE: &str =
    "ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE";

const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_METADATA: &str = "metadata";
const SUB_ENUM: &str = "enum";
const SUB_OBJECT: &str = "object";
const SUB_MAP: &str = "map";
const SUB_STRING: &str = "string";
const A_VALUES: &str = "values";
const A_INT_VALUE_MAP: &str = "intValueMap";
const A_STRING_VALUE_MAP: &str = "stringValueMap";
const A_MAX_LENGTH: &str = "maxLength";
const A_COERCE_DEFAULT: &str = "coerceDefault";
const A_DEFAULT: &str = "default";
const A_DB_COLUMN_TYPE: &str = "dbColumnType";
const A_OBJECT_REF: &str = "objectRef";
const A_STORAGE: &str = "storage";
const A_FLATTENED_COLUMN_PREFIX: &str = "flattenedColumnPrefix";
const A_VALUE_TYPE: &str = "valueType";
const STORAGE_FLATTENED: &str = "flattened";
const ENUM_MEMBER_PATTERN: &str = "^[A-Za-z_][A-Za-z0-9_]*$";
const MAP_SCALAR_VALUE_SUBTYPES: &[&str] = &[
    "string",
    "int",
    "long",
    "double",
    "float",
    "decimal",
    "boolean",
    "date",
    "time",
    "timestamp",
    "uuid",
];

/// A parsed `@dbColumnType` (`parseDbColumnType`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbColumnType {
    Uuid,
    Jsonb,
    Text,
    Varchar(Option<u32>),
    Char(u32),
}

/// Parse a `@dbColumnType` value, or `None` for one that is not legal. The spellings
/// are Postgres's own, matched exactly.
pub fn parse_db_column_type(value: &str) -> Option<DbColumnType> {
    match value {
        "uuid" => return Some(DbColumnType::Uuid),
        "jsonb" => return Some(DbColumnType::Jsonb),
        "text" => return Some(DbColumnType::Text),
        "varchar" | "character varying" => return Some(DbColumnType::Varchar(None)),
        _ => {}
    }
    let (kind, rest) = ["varchar(", "character varying(", "character("]
        .iter()
        .find_map(|p| value.strip_prefix(p).map(|r| (*p, r)))?;
    let digits = rest.strip_suffix(')')?;
    if digits.is_empty()
        || digits.len() > 9
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || digits.starts_with('0')
    {
        return None;
    }
    let n: u32 = digits.parse().ok()?;
    Some(if kind == "character(" {
        DbColumnType::Char(n)
    } else {
        DbColumnType::Varchar(Some(n))
    })
}

fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// The entries of a JS object or array value, as `Object.entries` lists them.
fn entries(v: &Value) -> Vec<(String, &Value)> {
    match v {
        Value::Object(m) => m.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(a) => a
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    }
}

fn node_label(ctx: &Ctx<'_>, id: NodeId) -> String {
    let n = ctx.tree.node(id);
    if n.name.is_empty() {
        format!("{}.{}", n.type_name, n.sub_type)
    } else {
        format!("{}.{} '{}'", n.type_name, n.sub_type, n.name)
    }
}

fn is_member(s: &str) -> bool {
    let mut it = s.chars();
    matches!(it.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && it.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A field.enum directly under the metadata root and abstract: a shared enum declaration.
fn shared_super(ctx: &Ctx<'_>, id: NodeId) -> Option<NodeId> {
    let tree = ctx.tree;
    let s = tree.node(id).super_node?;
    let n = tree.node(s);
    (n.type_name == TYPE_FIELD
        && n.sub_type == SUB_ENUM
        && n.is_abstract
        && n.parent
            .is_some_and(|p| tree.node(p).type_name == TYPE_METADATA))
    .then_some(s)
}

/// Checks 4, 5, 5b, 5c (field.enum) and 6 (`@dbColumnType`) of the reference's
/// attr-schema pass, on every node in document order.
pub fn validate_field_attr_rules(ctx: &Ctx<'_>, f: &mut Findings) {
    fn walk(ctx: &Ctx<'_>, f: &mut Findings, id: NodeId) {
        let n = ctx.tree.node(id);
        if n.type_name == TYPE_FIELD {
            if n.sub_type == SUB_ENUM {
                check_enum(ctx, f, id);
            }
            check_db_column_type(ctx, f, id);
        }
        for &c in ctx.tree.own_children(id) {
            walk(ctx, f, c);
        }
    }
    walk(ctx, f, ctx.root);
}

fn check_enum(ctx: &Ctx<'_>, f: &mut Findings, id: NodeId) {
    let tree = ctx.tree;
    let label = node_label(ctx, id);
    let shared = shared_super(ctx, id);
    let bad =
        |f: &mut Findings, msg: String| f.errors.push(error_at(tree, id, ERR_BAD_ATTR_VALUE, msg));
    // ADR-0039: own — @values is validated where it is declared.
    if let Some(Value::Array(raw)) = tree.own_attr(id, A_VALUES).map(|a| &a.value) {
        if raw.is_empty() {
            bad(
                f,
                format!("{label} must declare at least one value in '@{A_VALUES}'."),
            );
        } else {
            let mut seen: HashSet<String> = HashSet::new();
            for m in raw {
                let member = js_string(m);
                if !is_member(&member) {
                    bad(
                        f,
                        format!(
                            "{label} attribute '@{A_VALUES}' member '{member}' is not a valid identifier (must match {ENUM_MEMBER_PATTERN}). Non-identifier-safe member strings require a symbol↔value mapping (deferred)."
                        ),
                    );
                } else if !seen.insert(member.clone()) {
                    bad(
                        f,
                        format!("{label} attribute '@{A_VALUES}' has duplicate member '{member}'."),
                    );
                }
            }
        }
        if let Some(s) = shared {
            f.errors.push(error_at(tree, id, ERR_ENUM_EXTENDS_VALUES_CONFLICT, format!(
                "{label} extends shared abstract enum '{}' AND declares its own '@{A_VALUES}' — a shared enum's member set is owned by the shared declaration; remove the own '@{A_VALUES}' to inherit it, or extend a non-shared enum instead.", node_label(ctx, s))));
        }
    }
    // Check 5: the fallback attrs name a member of the EFFECTIVE @values.
    let members: Vec<String> = match tree.attr(id, A_VALUES) {
        Some(Value::Array(a)) => a.iter().map(js_string).collect(),
        _ => Vec::new(),
    };
    for attr in [A_COERCE_DEFAULT, A_DEFAULT] {
        // ADR-0039: own — the fallback attr DECLARED on this node.
        if let Some(Value::String(v)) = tree.own_attr(id, attr).map(|a| &a.value)
            && !members.contains(v)
        {
            bad(
                f,
                format!(
                    "{label} attribute '@{attr}' value '{v}' is not one of '@{A_VALUES}': {}.",
                    members.join(", ")
                ),
            );
        }
    }
    // Check 5b.
    if let Some(raw) = tree
        .own_attr(id, A_INT_VALUE_MAP)
        .map(|a| &a.value)
        .filter(|v| v.is_object() || v.is_array())
    {
        if let Some(s) = shared {
            f.errors.push(error_at(tree, id, ERR_ENUM_EXTENDS_VALUES_CONFLICT, format!(
                "{label} extends shared abstract enum '{0}' AND declares its own '@{A_INT_VALUE_MAP}' — a shared enum's integer backing is owned by the shared declaration; move '@{A_INT_VALUE_MAP}' onto '{0}' to inherit it, or extend a non-shared enum instead.", node_label(ctx, s))));
        }
        let ents = entries(raw);
        key_mismatch(f, tree, id, &label, A_INT_VALUE_MAP, &members, &ents, false);
        let mut seen: HashMap<u64, &str> = HashMap::new();
        for (member, v) in &ents {
            let Some(num) = v.as_f64().filter(|x| v.is_number() && x.fract() == 0.0) else {
                continue;
            };
            if let Some(owner) = seen.get(&num.to_bits()) {
                bad(
                    f,
                    format!(
                        "{label} attribute '@{A_INT_VALUE_MAP}' members '{owner}' and '{member}' share the same value {v}; every member must have a unique int."
                    ),
                );
            } else {
                seen.insert(num.to_bits(), member);
            }
        }
    }
    // Check 5c.
    if let Some(raw) = tree.own_attr(id, A_STRING_VALUE_MAP).map(|a| &a.value) {
        let pre = format!("{label} attribute '@{A_STRING_VALUE_MAP}'");
        if let Some(s) = shared {
            f.errors.push(error_at(tree, id, ERR_ENUM_EXTENDS_VALUES_CONFLICT, format!(
                "{pre} is declared on a field extending shared abstract enum '{0}' — a shared enum's stored strings are owned by the shared declaration; move it onto '{0}' to inherit it.", node_label(ctx, s))));
        } else if tree.attr(id, A_INT_VALUE_MAP).is_some() {
            bad(
                f,
                format!(
                    "{pre} is refused beside '@{A_INT_VALUE_MAP}': an @intValueMap enum is stored as integers, not strings. Keep one."
                ),
            );
        } else if tree.resolved_is_array(id) {
            bad(
                f,
                format!(
                    "{pre} is refused on an array enum: its column holds the members as text[] elements, which no port maps through @{A_STRING_VALUE_MAP}."
                ),
            );
        } else if !raw.is_object() {
            bad(
                f,
                format!("{pre} must be an object of {{ member: storedString }}."),
            );
        } else {
            let ents = entries(raw);
            key_mismatch(
                f,
                tree,
                id,
                &label,
                A_STRING_VALUE_MAP,
                &members,
                &ents,
                true,
            );
            let mut seen: HashMap<&str, &str> = HashMap::new();
            for (member, v) in &ents {
                match v.as_str().filter(|s| !s.is_empty()) {
                    None => bad(
                        f,
                        format!("{pre} member '{member}' must map to a non-empty string."),
                    ),
                    Some(s) => {
                        if let Some(owner) = seen.get(s) {
                            bad(
                                f,
                                format!(
                                    "{pre} members '{owner}' and '{member}' share the stored string '{s}'; every member must have a unique one."
                                ),
                            );
                        } else {
                            seen.insert(s, member);
                        }
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn key_mismatch(
    f: &mut Findings,
    tree: &crate::node::Tree,
    id: NodeId,
    label: &str,
    attr: &str,
    members: &[String],
    ents: &[(String, &Value)],
    with_prefix: bool,
) {
    let keys: HashSet<&str> = ents.iter().map(|(k, _)| k.as_str()).collect();
    let member_set: HashSet<&str> = members.iter().map(String::as_str).collect();
    let missing: Vec<&str> = members
        .iter()
        .map(String::as_str)
        .filter(|m| !keys.contains(m))
        .collect();
    let extra: Vec<&str> = ents
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| !member_set.contains(k))
        .collect();
    if missing.is_empty() && extra.is_empty() {
        return;
    }
    let _ = with_prefix;
    let mut msg =
        format!("{label} attribute '@{attr}' keys must exactly match '@{A_VALUES}' members");
    if !missing.is_empty() {
        msg.push_str(&format!(" (missing: {})", missing.join(", ")));
    }
    if !extra.is_empty() {
        msg.push_str(&format!(" (unknown: {})", extra.join(", ")));
    }
    msg.push('.');
    f.errors.push(error_at(tree, id, ERR_BAD_ATTR_VALUE, msg));
}

fn check_db_column_type(ctx: &Ctx<'_>, f: &mut Findings, id: NodeId) {
    let tree = ctx.tree;
    // ADR-0039: own — @dbColumnType is physical, never inherited.
    let Some(Value::String(own)) = tree.own_attr(id, A_DB_COLUMN_TYPE).map(|a| &a.value) else {
        return;
    };
    let label = node_label(ctx, id);
    let parsed = parse_db_column_type(own);
    if parsed.is_none() || tree.node(id).sub_type != SUB_STRING {
        let legal = [
            "uuid",
            "jsonb",
            "text",
            "varchar",
            "character varying",
            "varchar(n)",
            "character varying(n)",
            "character(n)",
        ];
        let list: Vec<String> = legal
            .iter()
            .map(|v| format!("{v} (field.string)"))
            .collect();
        f.errors.push(error_at(tree, id, ERR_BAD_ATTR_VALUE, format!(
            "{label} attribute '@{A_DB_COLUMN_TYPE}' value '{own}' is not legal on field.{}. Legal @{A_DB_COLUMN_TYPE} pairings: {}.", tree.node(id).sub_type, list.join(", "))));
        return;
    }
    let length = match parsed {
        Some(DbColumnType::Varchar(Some(n))) | Some(DbColumnType::Char(n)) => Some(n),
        _ => None,
    };
    // ADR-0039: resolving — @maxLength may be inherited.
    if let (Some(len), Some(max)) = (
        length,
        tree.attr(id, A_MAX_LENGTH).filter(|v| v.is_number()),
    ) && max.as_f64().is_some_and(|m| m > f64::from(len))
    {
        f.errors.push(error_at(tree, id, ERR_BAD_ATTR_VALUE, format!(
            "{label} declares @{A_MAX_LENGTH}: {max} over '@{A_DB_COLUMN_TYPE}: {own}', which holds {len}; a value the field accepts would not fit the column.")));
    }
}

// ---- validateFieldObjectStorage / validateFieldMap -----------------------------------

fn non_empty_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub fn validate_field_object_storage(ctx: &Ctx<'_>, f: &mut Findings) {
    let tree = ctx.tree;
    for &obj in tree
        .children(ctx.root)
        .iter()
        .filter(|&&c| tree.node(c).type_name == TYPE_OBJECT)
    {
        let oname = &tree.node(obj).name;
        // ADR-0039: own — the concrete field is an OWN child; its attrs are read resolving.
        for &fld in tree
            .own_children(obj)
            .iter()
            .filter(|&&c| tree.node(c).type_name == TYPE_FIELD)
        {
            let n = tree.node(fld);
            let has_ref = non_empty_str(tree.attr(fld, A_OBJECT_REF)).is_some();
            if n.sub_type == SUB_OBJECT && !has_ref {
                f.errors.push(error_at(tree, fld, ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF, format!(
                    "field.object \"{oname}.{}\" has no @objectRef; a field.object models a typed nested value and requires one. Take the first of these that fits: a known key set → declare an object.value and point @objectRef at it; dynamic keys over a known value type → field.map with @objectRef (a value object) or @valueType (a scalar); a genuinely open bag no reader pins a key in → @dbColumnType: jsonb on a field.string.", n.name)));
                continue;
            }
            let storage = tree.attr(fld, A_STORAGE);
            let is_flat = storage.and_then(Value::as_str) == Some(STORAGE_FLATTENED);
            if tree.attr(fld, A_FLATTENED_COLUMN_PREFIX).is_some() && !is_flat {
                let shown = match storage {
                    None | Some(Value::Null) => "not set (jsonb)".to_string(),
                    Some(s) => format!("\"{}\"", js_string(s)),
                };
                f.errors.push(error_at(tree, fld, ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE, format!(
                    "field.object \"{oname}.{}\" sets @flattenedColumnPrefix, but its @storage is {shown}; only a @storage \"flattened\" value object puts its members' columns in the owning table. Set @storage \"flattened\", or remove @flattenedColumnPrefix.", n.name)));
            }
            if is_flat && tree.resolved_is_array(fld) {
                f.errors.push(error_at(tree, fld, ERR_STORAGE_FLATTENED_ARRAY, format!(
                    "field \"{oname}.{}\" sets @storage \"flattened\" with isArray=true; flattened storage requires a single nested value", n.name)));
            }
        }
    }
}

pub fn validate_field_map(ctx: &Ctx<'_>, f: &mut Findings) {
    let tree = ctx.tree;
    for &obj in tree
        .children(ctx.root)
        .iter()
        .filter(|&&c| tree.node(c).type_name == TYPE_OBJECT)
    {
        let oname = &tree.node(obj).name;
        for &fld in tree
            .own_children(obj)
            .iter()
            .filter(|&&c| tree.node(c).type_name == TYPE_FIELD)
        {
            let n = tree.node(fld);
            if n.sub_type != SUB_MAP {
                continue;
            }
            let value_type = non_empty_str(tree.attr(fld, A_VALUE_TYPE));
            let has_ref = non_empty_str(tree.attr(fld, A_OBJECT_REF)).is_some();
            if value_type.is_some() == has_ref {
                f.errors.push(error_at(tree, fld, ERR_BAD_ATTR_VALUE, format!(
                    "field.map \"{oname}.{}\" must set exactly one of @valueType (a scalar value subtype) or @objectRef (a value-object); {}",
                    n.name, if value_type.is_some() { "both are set" } else { "neither is set" })));
                continue;
            }
            if let Some(vt) = value_type.filter(|v| !MAP_SCALAR_VALUE_SUBTYPES.contains(v)) {
                f.errors.push(error_at(tree, fld, ERR_BAD_ATTR_VALUE, format!(
                    "field.map \"{oname}.{}\" has @valueType \"{vt}\" which is not a scalar value subtype (string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid). For a value-object-valued map use @objectRef instead.", n.name)));
            }
        }
    }
}

// ---- validateEnumMaxLength -----------------------------------------------------------

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub fn validate_enum_max_length(ctx: &Ctx<'_>, f: &mut Findings) {
    fn visit(ctx: &Ctx<'_>, f: &mut Findings, node: NodeId) {
        let tree = ctx.tree;
        // ADR-0039: own children — every node is visited once, where it is declared.
        for &c in tree.own_children(node) {
            let cn = tree.node(c);
            if cn.type_name == TYPE_FIELD && cn.sub_type == SUB_ENUM {
                check(ctx, f, c);
            }
            if cn.type_name != TYPE_FIELD {
                visit(ctx, f, c);
            }
        }
    }
    fn check(ctx: &Ctx<'_>, f: &mut Findings, field: NodeId) {
        let tree = ctx.tree;
        // ADR-0039: own — reported on the node that DECLARES one of these.
        let declares = [A_MAX_LENGTH, A_VALUES, A_INT_VALUE_MAP, A_STRING_VALUE_MAP]
            .iter()
            .any(|a| tree.own_attr(field, a).is_some());
        let Some(max) = tree.attr(field, A_MAX_LENGTH).filter(|v| v.is_number()) else {
            return;
        };
        if !declares {
            return;
        }
        let max_f = max.as_f64().unwrap_or(0.0);
        let n = tree.node(field);
        let label = match n.parent.map(|p| tree.node(p)) {
            Some(p) if p.type_name == TYPE_OBJECT => format!("{}.{}", p.name, n.name),
            _ => n.name.clone(),
        };
        if tree.attr(field, A_INT_VALUE_MAP).is_some() {
            f.errors.push(error_at(tree, field, ERR_ENUM_MAX_LENGTH_WITH_INT_VALUE_MAP, format!(
                "field.enum \"{label}\" sets @maxLength {max} and @intValueMap; an @intValueMap enum is stored as an integer, so a column length does not apply. Remove @maxLength.")));
            return;
        }
        let map = tree
            .attr(field, A_STRING_VALUE_MAP)
            .and_then(Value::as_object);
        let mut too_long: Vec<String> = match tree.attr(field, A_VALUES) {
            Some(Value::Array(a)) => a
                .iter()
                .filter_map(Value::as_str)
                .map(|m| {
                    map.and_then(|mm| mm.get(m))
                        .and_then(Value::as_str)
                        .unwrap_or(m)
                        .to_string()
                })
                .filter(|v| (utf16_len(v) as f64) > max_f)
                .collect(),
            _ => Vec::new(),
        };
        too_long.sort_by_key(|v| std::cmp::Reverse(utf16_len(v)));
        if let Some(first) = too_long.first() {
            let len = utf16_len(first);
            let kind = if map.is_none() {
                "member"
            } else {
                "stored value"
            };
            f.errors.push(error_at(tree, field, ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH, format!(
                "field.enum \"{label}\" @maxLength {max} is shorter than its {kind} \"{first}\" ({len} characters). Raise @maxLength to at least {len}, or shorten the member.")));
        }
    }
    visit(ctx, f, ctx.root);
}

// ---- validateFieldDefaults -----------------------------------------------------------

fn ascii_int(s: &str) -> bool {
    let d = s.strip_prefix(['+', '-']).unwrap_or(s);
    !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())
}

/// `^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`
fn ascii_number(s: &str) -> bool {
    let s = s.strip_prefix(['+', '-']).unwrap_or(s);
    let (mant, exp) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    if let Some(e) = exp {
        let digits = e.strip_prefix(['+', '-']).unwrap_or(e);
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    let (int, frac) = match mant.split_once('.') {
        Some((i, fr)) => (i, Some(fr)),
        None => (mant, None),
    };
    let all_digits = |x: &str| x.bytes().all(|b| b.is_ascii_digit());
    if !all_digits(int) || frac.is_some_and(|fr| !all_digits(fr)) {
        return false;
    }
    if int.is_empty() {
        frac.is_some_and(|fr| !fr.is_empty())
    } else {
        true
    }
}

fn finite_number(t: &str) -> bool {
    ascii_number(t) && t.parse::<f64>().is_ok_and(f64::is_finite)
}

fn stringify_default(v: &Value) -> String {
    match v {
        Value::Bool(b) => b.to_string(),
        other => js_string(other),
    }
}

pub fn validate_field_defaults(ctx: &Ctx<'_>, f: &mut Findings) {
    fn walk(ctx: &Ctx<'_>, out: &mut Vec<MetaError>, id: NodeId) {
        let tree = ctx.tree;
        let n = tree.node(id);
        if n.type_name == TYPE_FIELD && n.sub_type != SUB_ENUM {
            // ADR-0039: own — the @default declared on THIS node.
            if let Some(raw) = tree
                .own_attr(id, A_DEFAULT)
                .map(|a| &a.value)
                .filter(|v| !matches!(v, Value::Null | Value::Array(_) | Value::Object(_)))
            {
                let def = stringify_default(raw);
                let t = def.trim();
                let ok = match n.sub_type.as_str() {
                    "int" | "long" | "currency" => ascii_int(t) || finite_number(t),
                    "double" | "float" | "decimal" => finite_number(t),
                    "boolean" => def == "true" || def == "false",
                    _ => true,
                };
                if !ok {
                    out.push(error_at(tree, id, ERR_BAD_ATTR_VALUE, format!(
                        "field.{} \"{}\" @{A_DEFAULT} \"{def}\" is not coercible to the field's type", n.sub_type, n.name)));
                }
            }
        }
        for &c in tree.own_children(id) {
            walk(ctx, out, c);
        }
    }
    walk(ctx, &mut f.errors, ctx.root);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_in_the_catalogue() {
        let raw = include_str!("../../../../../fixtures/conformance/ERROR-CODES.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for c in [
            ERR_ENUM_EXTENDS_VALUES_CONFLICT,
            ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH,
            ERR_ENUM_MAX_LENGTH_WITH_INT_VALUE_MAP,
            ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF,
            ERR_STORAGE_FLATTENED_ARRAY,
            ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE,
        ] {
            assert!(codes.contains_key(c), "{c}");
        }
    }

    #[test]
    fn db_column_types() {
        assert_eq!(
            parse_db_column_type("varchar(20)"),
            Some(DbColumnType::Varchar(Some(20)))
        );
        assert_eq!(
            parse_db_column_type("character(3)"),
            Some(DbColumnType::Char(3))
        );
        assert_eq!(
            parse_db_column_type("character varying"),
            Some(DbColumnType::Varchar(None))
        );
        assert_eq!(parse_db_column_type("varchar(0)"), None);
        assert_eq!(parse_db_column_type("varchar(1234567890)"), None);
        assert_eq!(parse_db_column_type("VARCHAR"), None);
    }

    #[test]
    fn default_gates_are_ascii_only() {
        assert!(ascii_int("-12") && !ascii_int("1_000") && !ascii_int("") && !ascii_int("0x10"));
        assert!(finite_number("1.5e3") && finite_number(".5") && finite_number("5."));
        assert!(!finite_number("1e999") && !finite_number("NaN") && !finite_number("."));
    }
}
