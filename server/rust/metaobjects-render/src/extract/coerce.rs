//! Stage 7: canonicalize a raw scalar per its [`FieldSpec`]. `None` is `MALFORMED`: the
//! value was present but could not be coerced. Mirrors `coerce.py`.
//!
//! Number rules shared with the C#, TS and Python ports: non-finite values are malformed,
//! radix prefixes (`0x..`) are rejected, and only an ASCII numeric literal parses.

use serde_json::Value;

use super::normalize::{self, normalize_enum};
use super::types::{Coercion, ExtractOptions, ExtractionReport, FieldKind, FieldSpec, Tolerance};

/// `^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`
pub(crate) fn is_ascii_numeric(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if int_digits == 0 && i == frac_start {
            return false;
        }
    } else if int_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let exp_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == exp_start {
            return false;
        }
    }
    i == b.len()
}

/// Canonicalize `raw` for `spec`, or `None` when it is malformed.
pub(crate) fn value(
    raw: &str,
    spec: &FieldSpec,
    opts: &ExtractOptions,
    path: &str,
    report: &mut ExtractionReport,
) -> Option<Value> {
    if let Some(hook) = &opts.on_field
        && let Some(v) = hook(path, raw, spec)
    {
        report.add_coercion(Coercion::new(path, raw, &value_text(&v), "onField"));
        return Some(v);
    }
    let norm = opts
        .normalizers
        .get(path)
        .or_else(|| opts.normalizers.get(&spec.name));
    if let Some(norm) = norm
        && let Some(v) = norm(raw)
    {
        report.add_coercion(Coercion::new(path, raw, &value_text(&v), "normalizer"));
        return Some(v);
    }
    let ci = opts.tolerance != Tolerance::Strict;
    match spec.kind {
        FieldKind::Enum => coerce_enum(raw, spec, opts, path, report, ci),
        FieldKind::Int | FieldKind::Long => coerce_number(raw, spec, path, report, ci, true),
        FieldKind::Double => coerce_number(raw, spec, path, report, ci, false),
        FieldKind::Boolean => coerce_bool(raw, ci),
        FieldKind::String | FieldKind::Object => Some(Value::String(raw.to_string())),
    }
}

/// Coerce a `@default` string to the field's kind with no side effects: it comes from the
/// metadata, not the reply.
pub(crate) fn scalar(raw: &str, spec: &FieldSpec) -> Option<Value> {
    match spec.kind {
        FieldKind::Int | FieldKind::Long => {
            let t = raw.trim();
            if !is_ascii_numeric(t) {
                return None;
            }
            if let Ok(n) = t.parse::<i64>() {
                return Some(Value::from(n));
            }
            let d: f64 = t.parse().ok()?;
            d.is_finite().then(|| int_value(d.trunc()))
        }
        FieldKind::Double => {
            let t = raw.trim();
            if !is_ascii_numeric(t) {
                return None;
            }
            let d: f64 = t.parse().ok()?;
            d.is_finite().then(|| Value::from(d))
        }
        FieldKind::Boolean => coerce_bool(raw, true),
        _ => Some(Value::String(raw.to_string())),
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn coerce_enum(
    raw: &str,
    spec: &FieldSpec,
    opts: &ExtractOptions,
    path: &str,
    report: &mut ExtractionReport,
    ci: bool,
) -> Option<Value> {
    let mode = if ci {
        spec.normalize.as_str()
    } else {
        normalize::NONE
    };
    let values = spec.enum_values.as_deref().unwrap_or_default();
    if let Some(v) = values.iter().find(|v| *v == raw) {
        return Some(Value::String(v.clone()));
    }
    if mode != normalize::NONE {
        let norm_raw = normalize_enum(raw, mode);
        if let Some(v) = values.iter().find(|v| normalize_enum(v, mode) == norm_raw) {
            report.add_coercion(Coercion::new(path, raw, v, "normalize"));
            return Some(Value::String(v.clone()));
        }
    }
    let schema_target = lookup_alias(raw, &spec.enum_alias, mode);
    if let Some(runtime) = lookup_alias(raw, &opts.aliases, mode) {
        let kind = if schema_target.as_ref().is_some_and(|s| *s != runtime) {
            "runtime-alias-override"
        } else {
            "alias"
        };
        report.add_coercion(Coercion::new(path, raw, &runtime, kind));
        return Some(Value::String(runtime));
    }
    if let Some(target) = schema_target {
        report.add_coercion(Coercion::new(path, raw, &target, "alias"));
        return Some(Value::String(target));
    }
    if let Some(d) = &spec.coerce_default
        && values.contains(d)
    {
        report.add_coercion(Coercion::new(path, raw, d, "coerceDefault"));
        return Some(Value::String(d.clone()));
    }
    None
}

fn lookup_alias(raw: &str, aliases: &[(String, String)], mode: &str) -> Option<String> {
    if let Some((_, t)) = aliases.iter().find(|(k, _)| k == raw) {
        return Some(t.clone());
    }
    if mode == normalize::NONE {
        return None;
    }
    let norm_raw = normalize_enum(raw, mode);
    aliases
        .iter()
        .find(|(k, _)| normalize_enum(k, mode) == norm_raw)
        .map(|(_, t)| t.clone())
}

/// A whole number as a JSON integer when it fits, else as a float.
fn int_value(d: f64) -> Value {
    #[allow(clippy::cast_possible_truncation)]
    if d.abs() < 9.2e18 {
        Value::from(d as i64)
    } else {
        Value::from(d)
    }
}

fn coerce_number(
    raw: &str,
    spec: &FieldSpec,
    path: &str,
    report: &mut ExtractionReport,
    lenient: bool,
    integer: bool,
) -> Option<Value> {
    let t = raw.trim();
    if !is_ascii_numeric(t) {
        return None;
    }
    // An integer parse first, so a long above 2^53 is not rounded through a float.
    if integer && let Ok(n) = t.parse::<i64>() {
        #[allow(clippy::cast_precision_loss)]
        let f = n as f64;
        let in_range = spec.min.is_none_or(|m| f >= m) && spec.max.is_none_or(|m| f <= m);
        if in_range {
            return Some(Value::from(n));
        }
        return clamp(f, spec, path, report, lenient, integer);
    }
    let d: f64 = t.parse().ok()?;
    clamp(d, spec, path, report, lenient, integer)
}

/// Apply the field's range: clamp (recorded) when lenient, malformed when strict.
fn clamp(
    n: f64,
    spec: &FieldSpec,
    path: &str,
    report: &mut ExtractionReport,
    lenient: bool,
    integer: bool,
) -> Option<Value> {
    if !n.is_finite() {
        return None;
    }
    let mut c = n;
    if let Some(min) = spec.min
        && c < min
    {
        c = min;
    }
    if let Some(max) = spec.max
        && c > max
    {
        c = max;
    }
    #[allow(clippy::float_cmp)]
    if c != n {
        if !lenient {
            return None;
        }
        report.add_coercion(Coercion::new(path, &num_text(n), &num_text(c), "clamp"));
    }
    Some(if integer {
        int_value(c.trunc())
    } else {
        Value::from(c)
    })
}

fn num_text(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e21 {
        format!("{n:.0}")
    } else {
        n.to_string()
    }
}

fn coerce_bool(raw: &str, ci: bool) -> Option<Value> {
    let t = raw.trim();
    let t = if ci { t.to_lowercase() } else { t.to_string() };
    match t.as_str() {
        "true" | "yes" | "1" => Some(Value::Bool(true)),
        "false" | "no" | "0" => Some(Value::Bool(false)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_literal_shape() {
        for ok in ["1", "-1", "+1.5", ".5", "1.", "1e5", "2.5E-3"] {
            assert!(is_ascii_numeric(ok), "{ok}");
        }
        for bad in ["", ".", "0x10", "1_000", "１", "1e", "NaN", "inf"] {
            assert!(!is_ascii_numeric(bad), "{bad}");
        }
    }
}
