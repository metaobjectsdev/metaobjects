//! JSON output that matches `JSON.stringify(value, null, 2)` byte for byte.
//!
//! Every port's canonical output and registry manifest is compared as text against
//! files the TypeScript port wrote, so two details of JavaScript's serializer are
//! reproduced here rather than left to `serde_json`:
//!
//! - **Key order.** A JavaScript object lists integer-like keys first, in ascending
//!   numeric order, then the remaining keys in insertion order.
//! - **Numbers.** JavaScript has one number type and prints `1.0` as `1`, switching
//!   to exponent notation below `1e-6` and at or above `1e21`.

use serde_json::{Map, Number, Value};

/// Serialize `value` as `JSON.stringify(value, null, 2)` would.
pub fn to_js_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value, 0);
    out
}

fn write_value(out: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number(n)),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_value(out, item, depth + 1);
            }
            newline(out, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in js_key_order(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, depth + 1);
                write_string(out, key);
                out.push_str(": ");
                write_value(out, item, depth + 1);
            }
            newline(out, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, depth: usize) {
    out.push('\n');
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// The order a JavaScript object enumerates its own string keys in.
pub fn js_key_order(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut rest: Vec<(&String, &Value)> = Vec::new();
    for (k, v) in map {
        match array_index(k) {
            Some(i) => indexed.push((i, k, v)),
            None => rest.push((k, v)),
        }
    }
    if indexed.is_empty() {
        return rest;
    }
    indexed.sort_by_key(|(i, _, _)| *i);
    let mut out: Vec<(&String, &Value)> = indexed.into_iter().map(|(_, k, v)| (k, v)).collect();
    out.extend(rest);
    out
}

/// A canonical array index (`0`, `17`, never `017` or `-1`) below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n < u64::from(u32::MAX) {
        u32::try_from(n).ok()
    } else {
        None
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `String(n)` for a JSON number.
pub fn js_number(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return js_f64(u as f64);
    }
    js_f64(n.as_f64().unwrap_or(f64::NAN))
}

/// `String(x)` for a double.
pub fn js_f64(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if x == 0.0 {
        return "0".to_string();
    }
    let abs = x.abs();
    if (1e-6..1e21).contains(&abs) {
        // Rust's Display gives the shortest round-trip digits without an exponent.
        return format!("{x}");
    }
    // Exponent form: `{:e}` gives "1e-7" / "1.5e21"; JavaScript writes "1.5e+21".
    let s = format!("{x:e}");
    match s.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => s,
    }
}

/// True when `x` is a whole number JavaScript would print without a fraction.
pub fn is_js_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// A whole-number double inside JavaScript's safe-integer range, as an `i64`.
pub fn safe_whole_i64(x: f64) -> Option<i64> {
    #[allow(clippy::cast_possible_truncation)]
    (is_js_integer(x) && x.abs() < 9.007_199_254_740_992e15).then_some(x as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn integer_like_keys_come_first() {
        let v: Value = serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4,"01":5}"#).unwrap();
        assert_eq!(
            to_js_pretty(&v),
            "{\n  \"2\": 4,\n  \"10\": 2,\n  \"b\": 1,\n  \"a\": 3,\n  \"01\": 5\n}"
        );
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_f64(1.0), "1");
        assert_eq!(js_f64(0.5), "0.5");
        assert_eq!(js_f64(1e21), "1e+21");
        assert_eq!(js_f64(1e-7), "1e-7");
        assert_eq!(js_f64(-0.0), "0");
        assert_eq!(
            to_js_pretty(&json!([1.0, 2.5, []])),
            "[\n  1,\n  2.5,\n  []\n]"
        );
    }

    #[test]
    fn control_characters_escape_like_javascript() {
        assert_eq!(to_js_pretty(&json!("a\"\u{1}\n")), "\"a\\\"\\u0001\\n\"");
    }
}
