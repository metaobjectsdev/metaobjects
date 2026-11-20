//! Field-level validation: the passes `validateFieldObjectStorage`, `validateFieldMap`,
//! `validateEnumMaxLength` and `validateFieldDefaults`, plus the `@dbColumnType`
//! parser the attribute-schema and expression passes share.

use serde_json::Value;

use super::util::error_at;
use super::{Ctx, Findings};
use crate::errors::{ERR_BAD_ATTR_VALUE, MetaError};
use crate::json::js_display;
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
const SUB_ENUM: &str = "enum";
const SUB_OBJECT: &str = "object";
const SUB_MAP: &str = "map";
const A_VALUES: &str = "values";
const A_INT_VALUE_MAP: &str = "intValueMap";
const A_STRING_VALUE_MAP: &str = "stringValueMap";
const A_MAX_LENGTH: &str = "maxLength";
const A_DEFAULT: &str = "default";
const A_OBJECT_REF: &str = "objectRef";
const A_STORAGE: &str = "storage";
const A_FLATTENED_COLUMN_PREFIX: &str = "flattenedColumnPrefix";
const A_VALUE_TYPE: &str = "valueType";
const STORAGE_FLATTENED: &str = "flattened";
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
                    Some(s) => format!("\"{}\"", js_display(s)),
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
        other => js_display(other),
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
        let raw = include_str!("../../data/ERROR-CODES.json");
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
