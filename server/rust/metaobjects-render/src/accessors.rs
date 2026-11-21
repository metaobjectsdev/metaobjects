//! Derived payload accessors: `{{#hasFoo}}` over a payload field `foo`, and `-last` on
//! each object element of a list.
//!
//! A prompt needs conditional sections ("include the abilities block only when there ARE
//! abilities"), and the payload contract answers that with a DERIVED accessor rather than
//! an authored boolean: the author declares `abilities`, and `hasAbilities` follows from it.
//! The rule is shared across the ports on purpose (the JVM's `PayloadAccessors`, Python's
//! `payload_accessors.py`) and is gated by the `render-derived-has-accessor` case.

use serde_json::{Map, Value};

/// The prefix every derived boolean accessor carries.
pub const HAS_PREFIX: &str = "has";

/// The positional accessor on every object element of a list, so a separator needs no
/// hand-computed flag: `{{#items}}{{name}}{{^-last}}, {{/-last}}{{/items}}`. The leading
/// `-` cannot collide with a field name. Scalar elements carry none.
pub const LAST_ACCESSOR: &str = "-last";

const MAX_DEPTH: usize = 32;

/// Upper-case the first character and leave the rest alone (`abilities` -> `Abilities`).
#[must_use]
pub fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// `"has" + capitalize(name)`: `abilities` -> `hasAbilities`.
#[must_use]
pub fn has_accessor_name(field_name: &str) -> String {
    format!("{HAS_PREFIX}{}", capitalize(field_name))
}

/// Is `value` "present" for `has<Field>`? A string must be non-blank, a list non-empty,
/// anything else non-null. Numbers and booleans get no accessor at all (`None`): they are
/// always-present scalars, and `{{#hasCount}}` over a number is drift, not a condition.
#[must_use]
pub fn accessor_value(value: &Value) -> Option<bool> {
    match value {
        Value::Null => Some(false),
        Value::String(s) => Some(!s.trim().is_empty()),
        Value::Number(_) | Value::Bool(_) => None,
        Value::Array(a) => Some(!a.is_empty()),
        Value::Object(_) => Some(true),
    }
}

/// A copy of `payload` carrying its derived accessors, recursively. An authored key always
/// wins: a payload that really carries `hasFoo` keeps its own value.
#[must_use]
pub fn with_derived_accessors(payload: &Value) -> Value {
    derive(payload, 0)
}

fn derive(payload: &Value, depth: usize) -> Value {
    if depth > MAX_DEPTH {
        return payload.clone();
    }
    match payload {
        Value::Object(map) => {
            let mut out: Map<String, Value> = map
                .iter()
                .map(|(k, v)| (k.clone(), derive(v, depth + 1)))
                .collect();
            for (k, v) in map {
                let name = has_accessor_name(k);
                if map.contains_key(&name) {
                    continue;
                }
                if let Some(present) = accessor_value(v) {
                    out.insert(name, Value::Bool(present));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => {
            let last = items.len().saturating_sub(1);
            Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, v)| {
                        let mut el = derive(v, depth + 1);
                        if let Value::Object(m) = &mut el {
                            m.entry(LAST_ACCESSOR).or_insert(Value::Bool(i == last));
                        }
                        el
                    })
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derives_has_flags_and_last() {
        let v = with_derived_accessors(&json!({
            "bio": "  ", "tags": ["a"], "count": 3, "items": [{"n": 1}, {"n": 2}], "hasBio": true
        }));
        assert_eq!(v["hasBio"], json!(true), "authored key wins");
        assert_eq!(v["hasTags"], json!(true));
        assert!(v.get("hasCount").is_none());
        assert_eq!(v["items"][0]["-last"], json!(false));
        assert_eq!(v["items"][1]["-last"], json!(true));
    }

    #[test]
    fn capitalize_keeps_the_rest() {
        assert_eq!(capitalize("fooBar"), "FooBar");
        assert_eq!(has_accessor_name("URL"), "hasURL");
    }
}
