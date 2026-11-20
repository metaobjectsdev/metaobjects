//! Cross-field validator conditions (`validateCrossFieldValidators`) and the
//! `@dbCheck` / `@constraintName` pass (`validateDbCheck`), with the expression
//! typing they need (a private port of `validateExprNode` / `inferExprType` /
//! `literalComparisonProblem`).

use serde_json::Value;
use std::collections::HashMap;

use super::util::{START_OF_UNITS, error_at, ops_for_subtype};
use super::{Ctx, Findings};
use crate::errors::{ERR_BAD_ATTR_VALUE, ERR_UNKNOWN_ATTR};
use crate::json::js_display;
use crate::node::NodeId;

pub const ERR_CROSS_FIELD_WITHOUT_CHECK: &str = "ERR_CROSS_FIELD_WITHOUT_CHECK";
pub const ERR_CONSTRAINT_NAME_WITHOUT_CHECK: &str = "ERR_CONSTRAINT_NAME_WITHOUT_CHECK";

const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_VALIDATOR: &str = "validator";
const SUB_ENUM: &str = "enum";
const SUB_BOOLEAN: &str = "boolean";
const SUB_STRING: &str = "string";
const SUB_INT: &str = "int";
const SUB_LONG: &str = "long";
const SUB_DOUBLE: &str = "double";
const SUB_FLOAT: &str = "float";
const SUB_DECIMAL: &str = "decimal";
const SUB_CURRENCY: &str = "currency";
const SUB_DATE: &str = "date";
const SUB_TIMESTAMP: &str = "timestamp";
const SUB_UUID: &str = "uuid";
const SUB_DURATION: &str = "duration";
const SUB_OBJECT: &str = "object";
const SUB_MAP: &str = "map";

const V_AT_LEAST_ONE: &str = "atLeastOne";
const V_EXACTLY_ONE: &str = "exactlyOne";
const V_REQUIRED_WHEN: &str = "requiredWhen";
const V_PRESENT_IFF: &str = "presentIff";
const CROSS_FIELD: &[&str] = &[
    "comparison",
    V_REQUIRED_WHEN,
    V_PRESENT_IFF,
    V_AT_LEAST_ONE,
    V_EXACTLY_ONE,
];
const DB_CHECK_VALIDATORS: &[&str] = &["numeric", "length", "regex"];

const A_MAX: &str = "max";
const A_FIELDS: &str = "fields";
const A_WHEN: &str = "when";
const A_EQUALS: &str = "equals";
const A_CONDITION: &str = "condition";
const A_DB_CHECK: &str = "dbCheck";
const A_CONSTRAINT_NAME: &str = "constraintName";
const A_VALUES: &str = "values";

const EXPR_CASE: &str = "case";
const EXPR_NOW: &str = "now";
const EXPR_NOW_START_OF: &str = "startOf";
const EXPR_CAST: &str = "cast";
const EXPR_CAST_AS: &str = "as";
const EXPR_CAST_DB_COLUMN_TYPE: &str = "dbColumnType";
const CASE_WHEN: &str = "when";
const CASE_THEN: &str = "then";
const CASE_ELSE: &str = "else";
const CASE_OPERAND: &str = "operand";
const OP_NOT: &str = "not";
const OP_IS_NULL: &str = "isNull";
const OP_IS_NOT_NULL: &str = "isNotNull";
const COMPARISON_OPS: &[&str] = &["eq", "ne", "gt", "gte", "lt", "lte"];
const LOGIC_OPS: &[&str] = &["and", "or"];
pub(crate) const CAST_TARGETS: &[&str] = &[
    SUB_STRING,
    SUB_INT,
    SUB_LONG,
    SUB_DOUBLE,
    SUB_FLOAT,
    SUB_DECIMAL,
    SUB_BOOLEAN,
    SUB_DATE,
    SUB_TIMESTAMP,
    SUB_UUID,
];
const NUMERIC: &[&str] = &[
    SUB_INT,
    SUB_LONG,
    SUB_DOUBLE,
    SUB_FLOAT,
    SUB_DECIMAL,
    SUB_CURRENCY,
];

/// What a literal compared with a field.duration must be.
const DURATION_LITERAL_FORM: &str = "an ISO-8601 duration (such as PT1H30M; no years or months)";

// ---- duration patterns (hand matchers for the reference's regexes) --------------

/// Match `(\d+<d1>)?(\d+<d2>)?...` over the whole of `s`, designators in order.
fn components(s: &str, designators: &[char], fraction_on: Option<char>) -> bool {
    let b: Vec<char> = s.chars().collect();
    let (mut i, mut next) = (0, 0);
    while i < b.len() {
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
        if fraction_on.is_some() && i < b.len() && b[i] == '.' {
            let f = i + 1;
            i = f;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i == f || i >= b.len() || Some(b[i]) != fraction_on {
                return false;
            }
        }
        let Some(&c) = b.get(i) else { return false };
        let Some(idx) = designators.iter().position(|&d| d == c) else {
            return false;
        };
        if idx < next {
            return false;
        }
        next = idx + 1;
        i += 1;
    }
    true
}

fn duration_shape(s: &str, date: &[char], fraction: bool, signed_pm: bool) -> bool {
    let rest = if signed_pm {
        s.strip_prefix(['+', '-']).unwrap_or(s)
    } else {
        s
    };
    let Some(rest) = rest.strip_prefix('P') else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let (date_part, time_part) = match rest.find('T') {
        Some(t) => (&rest[..t], Some(&rest[t + 1..])),
        None => (rest, None),
    };
    if !components(date_part, date, None) {
        return false;
    }
    match time_part {
        None => true,
        Some(t) => {
            t.starts_with(|c: char| c.is_ascii_digit())
                && components(t, &['H', 'M', 'S'], if fraction { Some('S') } else { None })
        }
    }
}

/// `ISO_DURATION_RE`: a signed ISO-8601 duration, years and months allowed.
pub fn is_iso_duration(s: &str) -> bool {
    duration_shape(s, &['Y', 'M', 'W', 'D'], false, true)
}

/// `parseDurationLiteral` is defined: the field.duration literal form.
pub fn is_duration_literal(s: &str) -> bool {
    duration_shape(s, &['W', 'D'], true, true)
}

// ---- expression grammar ----------------------------------------------------------

fn kind_keys(
    node: &serde_json::Map<String, Value>,
) -> Option<(&'static str, &'static [&'static str])> {
    const KINDS: &[(&str, &[&str])] = &[
        ("field", &["field"]),
        ("value", &["value"]),
        (EXPR_NOW, &[EXPR_NOW, EXPR_NOW_START_OF]),
        (EXPR_CASE, &[EXPR_CASE, CASE_ELSE, CASE_OPERAND]),
        ("fn", &["fn", "args"]),
        ("op", &["op", "left", "right", "arg", "args"]),
    ];
    KINDS.iter().find(|(k, _)| node.contains_key(*k)).copied()
}

struct FnSig {
    min: usize,
    max: usize,
    params: &'static [&'static str],
    result: &'static str,
    ordered: bool,
}

fn fn_sig(name: &str) -> Option<FnSig> {
    let s = |min, max, params, result, ordered| FnSig {
        min,
        max,
        params,
        result,
        ordered,
    };
    Some(match name {
        "coalesce" => s(1, usize::MAX, &["same"], "same", false),
        "greatest" | "least" => s(1, usize::MAX, &["same"], "same", true),
        "nullif" => s(2, 2, &["same", "same"], "same", false),
        "lower" | "upper" => s(1, 1, &["string"], "string", false),
        "btrim" => s(1, 2, &["string", "string"], "string", false),
        "splitPart" => s(3, 3, &["string", "string", "int"], "string", false),
        "concat" => s(1, usize::MAX, &["scalar"], "string", false),
        "concatWs" => s(2, usize::MAX, &["string", "scalar"], "string", false),
        "substring" => s(2, 3, &["string", "int", "int"], "string", false),
        "replace" => s(3, 3, &["string", "string", "string"], "string", false),
        "left" | "right" => s(2, 2, &["string", "int"], "string", false),
        "length" => s(1, 1, &["string"], "int", false),
        _ => return None,
    })
}

fn js_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
    }
}

fn is_text_dbcolumntype(v: &str) -> bool {
    // text, varchar, character varying, varchar(n), character varying(n), character(n)
    super::field::parse_db_column_type(v).is_some_and(|p| {
        !matches!(
            p,
            super::field::DbColumnType::Uuid | super::field::DbColumnType::Jsonb
        )
    })
}

/// Structural well-formedness of an expression tree; empty when valid.
pub(crate) fn validate_expr(node: &Value) -> Vec<String> {
    let Some(n) = node.as_object() else {
        return vec![format!(
            "expression node must be an object, got {}",
            js_type(node)
        )];
    };
    let kind = kind_keys(n);
    if let Some((k, allowed)) = kind {
        let extra: Vec<&str> = n
            .keys()
            .map(String::as_str)
            .filter(|x| !allowed.contains(x))
            .collect();
        if !extra.is_empty() {
            return vec![format!(
                "expression '{k}' node takes only {}, not {}",
                allowed.join(", "),
                extra.join(", ")
            )];
        }
    }
    if let Some(f) = n.get("field") {
        return if f.as_str().is_some_and(|s| !s.is_empty()) {
            vec![]
        } else {
            vec!["expression 'field' must be a non-empty string".into()]
        };
    }
    if let Some(v) = n.get("value") {
        return if matches!(
            v,
            Value::Null | Value::String(_) | Value::Number(_) | Value::Bool(_)
        ) {
            vec![]
        } else {
            vec!["expression 'value' must be a scalar literal (string/number/boolean/null)".into()]
        };
    }
    if let Some(d) = n.get(EXPR_NOW) {
        if !d.as_str().is_some_and(is_iso_duration) {
            return vec![format!(
                "expression '{EXPR_NOW}' must be an ISO-8601 duration string (e.g. '-P7D'), got {d}"
            )];
        }
        if let Some(s) = n.get(EXPR_NOW_START_OF)
            && !s.as_str().is_some_and(|u| START_OF_UNITS.contains(&u))
        {
            return vec![format!(
                "expression '{EXPR_NOW_START_OF}' must be one of {}, got {s}",
                START_OF_UNITS.join(", ")
            )];
        }
        return vec![];
    }
    if let Some(arms) = n.get(EXPR_CASE) {
        let Some(arms) = arms.as_array().filter(|a| !a.is_empty()) else {
            return vec![format!(
                "'{EXPR_CASE}' requires a non-empty array of {{ {CASE_WHEN}, {CASE_THEN} }} arms"
            )];
        };
        let mut errs = Vec::new();
        for arm in arms {
            match arm.as_object() {
                Some(a)
                    if a.contains_key(CASE_WHEN)
                        && a.contains_key(CASE_THEN)
                        && a.keys().all(|k| k == CASE_WHEN || k == CASE_THEN) =>
                {
                    errs.extend(validate_expr(&a[CASE_WHEN]));
                    errs.extend(validate_expr(&a[CASE_THEN]));
                }
                _ => errs.push(format!(
                    "every '{EXPR_CASE}' arm must be {{ {CASE_WHEN}, {CASE_THEN} }}"
                )),
            }
        }
        for key in [CASE_ELSE, CASE_OPERAND] {
            if let Some(e) = n.get(key) {
                errs.extend(validate_expr(e));
            }
        }
        return errs;
    }
    if n.contains_key(EXPR_CAST) {
        let extra: Vec<&str> = n
            .keys()
            .map(String::as_str)
            .filter(|k| *k != EXPR_CAST && *k != EXPR_CAST_AS && *k != EXPR_CAST_DB_COLUMN_TYPE)
            .collect();
        if !extra.is_empty() {
            return vec![format!(
                "expression '{EXPR_CAST}' takes only '{EXPR_CAST_AS}' and '{EXPR_CAST_DB_COLUMN_TYPE}' beside it, not {}",
                extra.join(", ")
            )];
        }
        let to = n.get(EXPR_CAST_AS).and_then(Value::as_str);
        let Some(to) = to.filter(|t| CAST_TARGETS.contains(t)) else {
            return vec![format!(
                "'{EXPR_CAST}' requires '{EXPR_CAST_AS}': one of {}",
                CAST_TARGETS.join(", ")
            )];
        };
        if let Some(sp) = n.get(EXPR_CAST_DB_COLUMN_TYPE)
            && (!sp.as_str().is_some_and(is_text_dbcolumntype) || to != SUB_STRING)
        {
            return vec![format!(
                "'{EXPR_CAST}' '{EXPR_CAST_DB_COLUMN_TYPE}' is a text spelling of @dbColumnType (text, varchar, character varying, varchar(n), character varying(n), character(n)) with '{EXPR_CAST_AS}: {SUB_STRING}'"
            )];
        }
        return validate_expr(&n[EXPR_CAST]);
    }
    if let Some(f) = n.get("fn") {
        let name = f.as_str().unwrap_or("");
        let Some(sig) = fn_sig(name).filter(|_| f.is_string()) else {
            return vec![format!(
                "unknown expression fn '{}'",
                f.as_str().map_or_else(|| f.to_string(), str::to_string)
            )];
        };
        let args = n.get("args").and_then(Value::as_array);
        let Some(args) = args.filter(|a| a.len() >= sig.min.max(1)) else {
            return vec![if sig.min <= 1 {
                format!("'{name}' requires a non-empty args array")
            } else {
                format!("'{name}' requires at least {} args", sig.min)
            }];
        };
        if args.len() > sig.max {
            return vec![format!(
                "'{name}' takes at most {} args, got {}",
                sig.max,
                args.len()
            )];
        }
        return args.iter().flat_map(validate_expr).collect();
    }
    if let Some(op) = n.get("op") {
        let Some(op) = op.as_str() else {
            return vec!["expression 'op' must be a string".into()];
        };
        if COMPARISON_OPS.contains(&op) {
            return if n.contains_key("left") && n.contains_key("right") {
                let mut e = validate_expr(&n["left"]);
                e.extend(validate_expr(&n["right"]));
                e
            } else {
                vec![format!("comparison op '{op}' requires 'left' and 'right'")]
            };
        }
        if op == OP_IS_NULL || op == OP_IS_NOT_NULL || op == OP_NOT {
            return match n.get("arg") {
                Some(a) => validate_expr(a),
                None => vec![format!("op '{op}' requires 'arg'")],
            };
        }
        if LOGIC_OPS.contains(&op) {
            return match n
                .get("args")
                .and_then(Value::as_array)
                .filter(|a| !a.is_empty())
            {
                Some(a) => a.iter().flat_map(validate_expr).collect(),
                None => vec![format!("op '{op}' requires a non-empty args array")],
            };
        }
        return vec![format!("unknown expression op '{op}'")];
    }
    vec!["expression node must be one of {field}, {value}, {op,…}, {fn,…}, {case,…}, {now}, {cast,…}".into()]
}

pub(crate) type Ty = Option<String>;

fn literal_type(v: &Value) -> Ty {
    match v {
        Value::String(_) => Some(SUB_STRING.into()),
        Value::Bool(_) => Some(SUB_BOOLEAN.into()),
        Value::Number(n) => {
            let whole = n.is_i64()
                || n.is_u64()
                || n.as_f64()
                    .is_some_and(|f| f.is_finite() && f.fract() == 0.0);
            Some(if whole { SUB_INT } else { SUB_DOUBLE }.into())
        }
        _ => None,
    }
}

fn is_adaptable(n: &Value) -> bool {
    n.get("value").is_some_and(Value::is_number) || n.get(EXPR_NOW).is_some()
}

fn adapts_to(n: &Value, to: &str) -> bool {
    if n.get(EXPR_NOW).is_some() {
        return to == SUB_DATE || to == SUB_TIMESTAMP;
    }
    if literal_type(&n["value"]).as_deref() == Some(SUB_INT) {
        return NUMERIC.contains(&to);
    }
    to == SUB_DOUBLE || to == SUB_FLOAT || to == SUB_DECIMAL
}

/// The one type of some results, or the differing types when they do not unify.
fn unify(nodes: &[&Value], types: &[Ty]) -> (Ty, Option<Vec<String>>) {
    let typed: Vec<(&Value, &String)> = nodes
        .iter()
        .zip(types)
        .filter_map(|(n, t)| t.as_ref().map(|t| (*n, t)))
        .collect();
    let anchor = typed.iter().find(|(n, _)| !is_adaptable(n));
    let unified = anchor.or(typed.first()).map(|(_, t)| (*t).clone());
    let fits = typed.iter().all(|(n, t)| {
        Some(*t) == unified.as_ref()
            || (anchor.is_some_and(|(_, at)| is_adaptable(n) && adapts_to(n, at)))
    });
    if fits {
        (unified, None)
    } else {
        let mut seen: Vec<String> = Vec::new();
        for (_, t) in &typed {
            if !seen.contains(t) {
                seen.push((*t).clone());
            }
        }
        (unified, Some(seen))
    }
}

fn cast_problem(from: Option<&str>, to: &str, int_enum: bool) -> Option<String> {
    let from = from?;
    if from == SUB_OBJECT || from == SUB_MAP {
        return Some(format!("a field.{from} value cannot be cast"));
    }
    if from == to {
        return None;
    }
    let integer = |t: &str| t == SUB_INT || t == SUB_LONG;
    if from == SUB_ENUM {
        if to == SUB_STRING {
            return int_enum.then(|| "an int-stored enum (@intValueMap) cast to string gives its integer, not its member; cast it to int".to_string());
        }
        if integer(to) {
            return (!int_enum).then(|| {
                "only an enum stored as an integer (@intValueMap) can be cast to a number"
                    .to_string()
            });
        }
        return Some(format!("an enum cannot be cast to {to}"));
    }
    if to == SUB_STRING || from == SUB_STRING {
        return None;
    }
    if NUMERIC.contains(&to) {
        if from == SUB_BOOLEAN {
            return (to != SUB_INT).then(|| format!("a boolean casts only to int, not {to}"));
        }
        return (!NUMERIC.contains(&from)).then(|| format!("a {from} cannot be cast to {to}"));
    }
    if to == SUB_BOOLEAN {
        return (from != SUB_INT)
            .then(|| format!("a {from} cannot be cast to boolean; only an int can"));
    }
    if to == SUB_DATE || to == SUB_TIMESTAMP {
        return (from != SUB_DATE && from != SUB_TIMESTAMP)
            .then(|| format!("a {from} cannot be cast to {to}"));
    }
    Some(format!("a {from} cannot be cast to {to}"))
}

pub(crate) struct Infer {
    pub(crate) ty: Ty,
    pub(crate) errors: Vec<String>,
}

type Resolve<'a> = &'a dyn Fn(&str) -> Ty;

fn infer(node: &Value, resolve: Resolve<'_>) -> Infer {
    infer_with(node, resolve, &|_| false)
}

/// `inferExprType` with `isIntStoredEnum`: whether a named field is an int-stored enum.
pub(crate) fn infer_with(
    node: &Value,
    resolve: Resolve<'_>,
    ienum: &dyn Fn(&str) -> bool,
) -> Infer {
    let structural = validate_expr(node);
    if !structural.is_empty() {
        return Infer {
            ty: None,
            errors: structural,
        };
    }
    let n = node.as_object().expect("validated as an object");
    let done = |ty: Ty, errors: Vec<String>| Infer { ty, errors };
    if let Some(f) = n.get("field") {
        let name = f.as_str().unwrap_or("");
        return match resolve(name) {
            Some(t) => done(Some(t), vec![]),
            None => done(
                None,
                vec![format!(
                    "expression field '{name}' does not resolve to a projection field (not an aggregate) or a base entity field"
                )],
            ),
        };
    }
    if let Some(v) = n.get("value") {
        return done(literal_type(v), vec![]);
    }
    if n.contains_key(EXPR_NOW) {
        return done(Some(SUB_TIMESTAMP.into()), vec![]);
    }
    if let Some(arms) = n.get(EXPR_CASE).and_then(Value::as_array) {
        let mut errors = Vec::new();
        let operand = n.get(CASE_OPERAND).map(|o| infer_with(o, resolve, ienum));
        if let Some(o) = &operand {
            errors.extend(o.errors.iter().cloned());
        }
        let mut results: Vec<Ty> = Vec::new();
        let mut nodes: Vec<&Value> = Vec::new();
        for arm in arms {
            let (when, then) = (&arm[CASE_WHEN], &arm[CASE_THEN]);
            let w = infer_with(when, resolve, ienum);
            errors.extend(w.errors.iter().cloned());
            if operand.is_none() && w.ty.as_deref().is_some_and(|t| t != SUB_BOOLEAN) {
                errors.push(format!(
                    "a searched '{EXPR_CASE}' needs a boolean '{CASE_WHEN}', got {}",
                    w.ty.as_deref().unwrap_or("")
                ));
            }
            if let (Some(Infer { ty: Some(ot), .. }), Some(wt)) = (&operand, &w.ty)
                && when.get("value").is_none()
                && wt != ot
            {
                errors.push(format!("a simple '{EXPR_CASE}' compares its {ot} '{CASE_OPERAND}' with a {wt} '{CASE_WHEN}'"));
            }
            let t = infer_with(then, resolve, ienum);
            errors.extend(t.errors);
            results.push(t.ty);
            nodes.push(then);
        }
        if let Some(e) = n.get(CASE_ELSE) {
            let r = infer_with(e, resolve, ienum);
            errors.extend(r.errors);
            results.push(r.ty);
            nodes.push(e);
        }
        let (ty, differing) = unify(&nodes, &results);
        if let Some(d) = differing {
            errors.push(format!(
                "'{EXPR_CASE}' results have differing types ({})",
                d.join(", ")
            ));
        }
        return done(ty, errors);
    }
    if let Some(inner) = n.get(EXPR_CAST) {
        let operand = infer_with(inner, resolve, ienum);
        let to = n[EXPR_CAST_AS].as_str().unwrap_or("").to_string();
        let int_enum = inner
            .get("field")
            .and_then(Value::as_str)
            .is_some_and(ienum);
        let problem = cast_problem(operand.ty.as_deref(), &to, int_enum);
        let mut errors = operand.errors;
        if let Some(p) = problem {
            errors.push(format!("'{EXPR_CAST}': {p}"));
        }
        return done(Some(to), errors);
    }
    if let Some(f) = n.get("fn") {
        let name = f.as_str().unwrap_or("");
        let sig = fn_sig(name).expect("validated function");
        let args = n["args"].as_array().expect("validated args");
        let results: Vec<Infer> = args.iter().map(|a| infer_with(a, resolve, ienum)).collect();
        let mut errors: Vec<String> = results
            .iter()
            .flat_map(|r| r.errors.iter().cloned())
            .collect();
        let (mut same, mut same_nodes): (Vec<Ty>, Vec<&Value>) = (Vec::new(), Vec::new());
        for (i, (a, an)) in results.iter().zip(args).enumerate() {
            let kind = sig.params[i.min(sig.params.len() - 1)];
            let Some(t) = a.ty.as_deref() else { continue };
            match kind {
                "same" => {
                    same.push(Some(t.to_string()));
                    same_nodes.push(an);
                }
                "string" if t != SUB_STRING => errors.push(format!(
                    "'{name}' argument {} must be a string, got {t}",
                    i + 1
                )),
                "int" if t != SUB_INT => errors.push(format!(
                    "'{name}' argument {} must be an int, got {t}{}",
                    i + 1,
                    if t == SUB_LONG {
                        "; cast it ({ cast: <expr>, as: int })"
                    } else {
                        ""
                    }
                )),
                "scalar" if t == SUB_OBJECT || t == SUB_MAP => errors.push(format!(
                    "'{name}' argument {} must be a scalar, got {t}",
                    i + 1
                )),
                _ => {}
            }
        }
        let (unified, differing) = unify(&same_nodes, &same);
        if let Some(d) = differing {
            errors.push(format!(
                "'{name}' arguments have differing types ({})",
                d.join(", ")
            ));
        }
        if sig.ordered
            && unified
                .as_deref()
                .is_some_and(|u| u == SUB_BOOLEAN || u == SUB_OBJECT || u == SUB_MAP)
        {
            errors.push(format!(
                "'{name}' needs ordered arguments, got {}",
                unified.as_deref().unwrap_or("")
            ));
        }
        let ty = match sig.result {
            "same" => unified,
            "int" => Some(SUB_INT.into()),
            _ => Some(SUB_STRING.into()),
        };
        return done(ty, errors);
    }
    let op = n["op"].as_str().unwrap_or("");
    if COMPARISON_OPS.contains(&op) {
        let l = infer_with(&n["left"], resolve, ienum);
        let r = infer_with(&n["right"], resolve, ienum);
        let mut errors = l.errors;
        errors.extend(r.errors);
        if let Some(lt) = &l.ty
            && !ops_for_subtype(lt).contains(&op)
        {
            errors.push(format!("op '{op}' is not legal for a {lt} operand"));
        }
        return done(Some(SUB_BOOLEAN.into()), errors);
    }
    if op == OP_IS_NULL || op == OP_IS_NOT_NULL {
        return done(
            Some(SUB_BOOLEAN.into()),
            infer_with(&n["arg"], resolve, ienum).errors,
        );
    }
    let kids: Vec<&Value> = if op == OP_NOT {
        vec![&n["arg"]]
    } else {
        n["args"]
            .as_array()
            .map(|a| a.iter().collect())
            .unwrap_or_default()
    };
    let mut errors = Vec::new();
    for k in kids {
        let kt = infer_with(k, resolve, ienum);
        errors.extend(kt.errors);
        if let Some(t) = kt.ty.as_deref().filter(|t| *t != SUB_BOOLEAN) {
            errors.push(format!("op '{op}' requires boolean operands, got {t}"));
        }
    }
    done(Some(SUB_BOOLEAN.into()), errors)
}

/// Every node of an expression tree, root first.
pub(crate) fn expression_nodes<'a>(
    node: &'a Value,
    out: &mut Vec<&'a serde_json::Map<String, Value>>,
) {
    let Some(n) = node.as_object() else { return };
    out.push(n);
    for key in ["left", "right", "arg", EXPR_CAST, CASE_OPERAND, CASE_ELSE] {
        if let Some(c) = n.get(key) {
            expression_nodes(c, out);
        }
    }
    if let Some(args) = n.get("args").and_then(Value::as_array) {
        for a in args {
            expression_nodes(a, out);
        }
    }
    if let Some(arms) = n.get(EXPR_CASE).and_then(Value::as_array) {
        for arm in arms.iter().filter_map(Value::as_object) {
            for key in [CASE_WHEN, CASE_THEN] {
                if let Some(c) = arm.get(key) {
                    expression_nodes(c, out);
                }
            }
        }
    }
}

fn expr_view_only_node(node: &Value) -> Option<String> {
    let n = node.as_object()?;
    if n.contains_key(EXPR_CAST) {
        return Some(EXPR_CAST.into());
    }
    if n.contains_key(EXPR_CASE) {
        return Some(EXPR_CASE.into());
    }
    if n.contains_key(EXPR_NOW) {
        return Some(EXPR_NOW.into());
    }
    if let Some(f) = n.get("fn")
        && f.as_str() != Some("coalesce")
    {
        return Some(f.as_str().map_or_else(|| f.to_string(), str::to_string));
    }
    if let Some(f) = n.get("field").and_then(Value::as_str)
        && f.contains('.')
    {
        return Some(format!("the path \"{f}\""));
    }
    for key in ["left", "right", "arg"] {
        if let Some(c) = n.get(key)
            && let Some(hit) = expr_view_only_node(c)
        {
            return Some(hit);
        }
    }
    n.get("args")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find_map(expr_view_only_node))
}

/// A field as the literal check sees it: subtype, name and enum members.
pub(crate) struct FieldView<'a> {
    pub(crate) name: &'a str,
    pub(crate) sub: &'a str,
    pub(crate) members: Option<&'a Vec<Value>>,
}

pub(crate) fn literal_comparison_problem<'a>(
    expr: &Value,
    field_of: &dyn Fn(&str) -> Option<FieldView<'a>>,
) -> Option<String> {
    let check = |lit: &Value, reference: &Value| -> Option<String> {
        let lit = lit.as_object()?;
        let value = lit.get("value").filter(|v| !v.is_null())?;
        let name = reference.as_object()?.get("field")?.as_str()?;
        let field = field_of(name)?;
        let kind = if field.sub == SUB_BOOLEAN {
            "boolean"
        } else if NUMERIC.contains(&field.sub) {
            "number"
        } else {
            "string"
        };
        if js_type(value) != kind {
            return Some(format!(
                "compares \"{}\" (field.{}) with {value}; it needs a {kind}.",
                field.name, field.sub
            ));
        }
        if let Some(members) = field.members.filter(|_| field.sub == SUB_ENUM)
            && !members.iter().any(|m| js_display(m) == js_display(value))
        {
            let list: Vec<String> = members.iter().map(js_display).collect();
            return Some(format!(
                "compares \"{}\" with {value}, which is not one of its @values ({}).",
                field.name,
                list.join(", ")
            ));
        }
        if field.sub == SUB_DURATION && !value.as_str().is_some_and(is_duration_literal) {
            return Some(format!(
                "compares \"{}\" with {value}, which is not {DURATION_LITERAL_FORM}.",
                field.name
            ));
        }
        None
    };
    let mut nodes = Vec::new();
    expression_nodes(expr, &mut nodes);
    for n in nodes {
        if let (Some(l), Some(r)) = (n.get("left"), n.get("right"))
            && let Some(p) = check(l, r).or_else(|| check(r, l))
        {
            return Some(p);
        }
        if let (Some(operand), Some(arms)) = (
            n.get(CASE_OPERAND),
            n.get(EXPR_CASE).and_then(Value::as_array),
        ) {
            for arm in arms.iter().filter_map(Value::as_object) {
                if let Some(w) = arm.get(CASE_WHEN)
                    && let Some(p) = check(w, operand)
                {
                    return Some(p);
                }
            }
        }
    }
    None
}

// ---- the passes ------------------------------------------------------------------

fn field_children(ctx: &Ctx<'_>, obj: NodeId) -> Vec<NodeId> {
    ctx.tree
        .children(obj)
        .iter()
        .copied()
        .filter(|&c| ctx.tree.node(c).type_name == TYPE_FIELD)
        .collect()
}

fn condition_problem<'a>(
    ctx: &Ctx<'a>,
    condition: &Value,
    fields: &HashMap<&str, NodeId>,
) -> Option<String> {
    let mut nodes = Vec::new();
    expression_nodes(condition, &mut nodes);
    if let Some(u) = nodes
        .iter()
        .find(|n| n.contains_key(EXPR_CASE) || n.contains_key(EXPR_NOW))
    {
        let which = if u.contains_key(EXPR_CASE) {
            EXPR_CASE
        } else {
            EXPR_NOW
        };
        return Some(format!(
            "is not a valid expression: a condition takes no '{which}' node, since a CHECK can hold neither a CASE nor the current time."
        ));
    }
    if let Some(v) = expr_view_only_node(condition) {
        return Some(format!(
            "uses {v}, which a CHECK condition cannot hold: it takes fields, literals, comparisons, null tests, and / or / not, and coalesce."
        ));
    }
    let tree = ctx.tree;
    let resolve = |name: &str| fields.get(name).map(|&f| tree.node(f).sub_type.clone());
    let inferred = infer(condition, &resolve);
    if !inferred.errors.is_empty() {
        return Some(format!(
            "is not a valid expression: {}.",
            inferred.errors.join("; ")
        ));
    }
    if inferred.ty.as_deref() != Some(SUB_BOOLEAN) {
        return Some(format!(
            "must be a boolean expression (a comparison, a null test, or and / or / not of them), not a field.{}.",
            inferred.ty.as_deref().unwrap_or("undefined")
        ));
    }
    let has_null = nodes.iter().any(|n| {
        n.contains_key("left")
            && n.contains_key("right")
            && [&n["left"], &n["right"]].iter().any(|side| {
                side.as_object()
                    .is_some_and(|s| s.get("value").is_some_and(Value::is_null))
            })
    });
    if has_null {
        return Some("compares with null, which is never true: use isNull or isNotNull.".into());
    }
    let field_of = |name: &str| {
        fields.get(name).map(|&f| FieldView {
            name: &tree.node(f).name,
            sub: &tree.node(f).sub_type,
            members: tree.attr(f, A_VALUES).and_then(Value::as_array),
        })
    };
    literal_comparison_problem(condition, &field_of)
}

/// An object's effective fields by name.
pub(crate) fn fields_by_name<'a>(ctx: &Ctx<'a>, obj: NodeId) -> HashMap<&'a str, NodeId> {
    let tree = ctx.tree;
    field_children(ctx, obj)
        .into_iter()
        .map(|x| (tree.node(x).name.as_str(), x))
        .collect()
}

/// Why a `@condition` over an object's fields is refused, or `None` when it is legal.
/// `label` opens the message. One rule for a cross-field validator's condition and a
/// transition's guard (ADR-0066): every field it names is a field of the object, and the
/// expression passes [`condition_problem`].
pub(crate) fn condition_message(
    ctx: &Ctx<'_>,
    condition: &Value,
    object_name: &str,
    fields: &HashMap<&str, NodeId>,
    label: &str,
) -> Option<String> {
    let mut refs: Vec<&String> = Vec::new();
    let mut nodes = Vec::new();
    expression_nodes(condition, &mut nodes);
    for n in nodes {
        if let Some(Value::String(s)) = n.get("field")
            && !refs.contains(&s)
        {
            refs.push(s);
        }
    }
    let mut unknown: Vec<&String> = refs
        .into_iter()
        .filter(|r| !fields.contains_key(r.as_str()))
        .collect();
    unknown.sort();
    if !unknown.is_empty() {
        let names: Vec<String> = unknown.iter().map(|u| format!("\"{u}\"")).collect();
        return Some(format!(
            "{label} names {}, which {} of \"{object_name}\".",
            names.join(", "),
            if unknown.len() == 1 {
                "is not a field"
            } else {
                "are not fields"
            }
        ));
    }
    condition_problem(ctx, condition, fields).map(|problem| format!("{label} {problem}"))
}

pub fn validate_cross_field_validators(ctx: &Ctx<'_>, f: &mut Findings) {
    let tree = ctx.tree;
    for &obj in tree
        .children(ctx.root)
        .iter()
        .filter(|&&c| tree.node(c).type_name == TYPE_OBJECT)
    {
        let fields = fields_by_name(ctx, obj);
        let oname = &tree.node(obj).name;
        // ADR-0039: own — each validator is checked where it is declared.
        for &v in tree.own_children(obj) {
            let vn = tree.node(v);
            if vn.type_name != TYPE_VALIDATOR || !CROSS_FIELD.contains(&vn.sub_type.as_str()) {
                continue;
            }
            let push = |f: &mut Findings, code: &'static str, msg: String| {
                f.errors.push(error_at(tree, v, code, msg))
            };
            // ADR-0039: own — the attr is checked on the validator that declares it.
            if vn.sub_type == V_AT_LEAST_ONE && tree.own_attr(v, A_MAX).is_some() {
                if ctx.strict {
                    continue;
                }
                push(
                    f,
                    ERR_UNKNOWN_ATTR,
                    format!(
                        "validator.atLeastOne \"{oname}.{}\" carries @max, which atLeastOne does not take. For \"exactly one of these fields\", declare validator.exactlyOne instead; for \"at least one\", remove @max.",
                        vn.name
                    ),
                );
                continue;
            }
            if vn.sub_type == V_EXACTLY_ONE {
                let n = match tree.attr(v, A_FIELDS) {
                    Some(Value::String(_)) => 1,
                    Some(Value::Array(a)) => a.iter().filter(|x| x.is_string()).count(),
                    _ => 0,
                };
                if n < 2 {
                    push(
                        f,
                        ERR_BAD_ATTR_VALUE,
                        format!(
                            "validator.exactlyOne \"{oname}.{}\" @fields names {n} field{}; it needs two or more. For one field, make that field required.",
                            vn.name,
                            if n == 1 { "" } else { "s" }
                        ),
                    );
                    continue;
                }
            }
            if vn.sub_type == V_REQUIRED_WHEN || vn.sub_type == V_PRESENT_IFF {
                let when = tree
                    .attr(v, A_WHEN)
                    .and_then(Value::as_str)
                    .and_then(|w| fields.get(w).copied());
                let equals = tree.attr(v, A_EQUALS);
                if let Some(w) = when.filter(|&w| tree.node(w).sub_type == SUB_DURATION)
                    && !equals
                        .and_then(Value::as_str)
                        .is_some_and(is_duration_literal)
                {
                    push(
                        f,
                        ERR_BAD_ATTR_VALUE,
                        format!(
                            "validator.{} \"{oname}.{}\" @equals {} gates field.duration \"{}\"; it needs {DURATION_LITERAL_FORM}.",
                            vn.sub_type,
                            vn.name,
                            equals.map_or_else(|| "undefined".to_string(), Value::to_string),
                            tree.node(w).name
                        ),
                    );
                    continue;
                }
            }
            let Some(condition) = tree.attr(v, A_CONDITION) else {
                continue;
            };
            let label = format!(
                "validator.{} \"{oname}.{}\" @condition",
                vn.sub_type, vn.name
            );
            if let Some(message) = condition_message(ctx, condition, oname, &fields, &label) {
                push(f, ERR_BAD_ATTR_VALUE, message);
            }
        }
    }
}

pub fn validate_db_check(ctx: &Ctx<'_>, f: &mut Findings) {
    fn visit(ctx: &Ctx<'_>, f: &mut Findings, id: NodeId, owner: Option<&str>) {
        let tree = ctx.tree;
        let n = tree.node(id);
        let checked = (n.type_name == TYPE_VALIDATOR
            && (DB_CHECK_VALIDATORS.contains(&n.sub_type.as_str())
                || CROSS_FIELD.contains(&n.sub_type.as_str())))
            || (n.type_name == TYPE_FIELD && n.sub_type == SUB_ENUM);
        if checked
            && (tree.own_attr(id, A_DB_CHECK).is_some()
                || tree.own_attr(id, A_CONSTRAINT_NAME).is_some())
        {
            let name = tree
                .attr(id, A_CONSTRAINT_NAME)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let label = format!(
                "{}.{} \"{}{}\"",
                n.type_name,
                n.sub_type,
                owner.map_or(String::new(), |o| format!("{o}.")),
                n.name
            );
            let db_false = tree.attr(id, A_DB_CHECK) == Some(&Value::Bool(false));
            if db_false && CROSS_FIELD.contains(&n.sub_type.as_str()) {
                f.errors.push(error_at(tree, id, ERR_CROSS_FIELD_WITHOUT_CHECK, format!(
                    "{label} sets @dbCheck: false, but this validator is enforced only by its CHECK, so the rule would be enforced nowhere. Remove the validator, or remove @dbCheck: false.")));
            } else if let (true, Some(name)) = (db_false, name) {
                f.errors.push(error_at(tree, id, ERR_CONSTRAINT_NAME_WITHOUT_CHECK, format!(
                    "{label} sets @dbCheck: false and @constraintName \"{name}\"; with no CHECK there is nothing for the name to name. Remove @constraintName, or remove @dbCheck: false.")));
            }
        }
        let next = if n.type_name == TYPE_OBJECT || n.type_name == TYPE_FIELD {
            Some(n.name.as_str())
        } else {
            owner
        };
        for &c in tree.own_children(id) {
            visit(ctx, f, c, next);
        }
    }
    for &c in ctx.tree.own_children(ctx.root) {
        visit(ctx, f, c, None);
    }
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
            ERR_CROSS_FIELD_WITHOUT_CHECK,
            ERR_CONSTRAINT_NAME_WITHOUT_CHECK,
            ERR_UNKNOWN_ATTR,
            ERR_BAD_ATTR_VALUE,
        ] {
            assert!(codes.contains_key(c), "{c}");
        }
    }

    #[test]
    fn duration_literals() {
        for ok in ["PT1H30M", "-PT5S", "P1W", "P1DT2H", "PT0.5S", "+P2D"] {
            assert!(is_duration_literal(ok), "{ok}");
        }
        for bad in [
            "P", "PT", "P1Y", "P1M", "1H", "PT1", "PT1H2", "P1DT", "PT1.H", "PT.5S", "PT1M1H",
        ] {
            assert!(!is_duration_literal(bad), "{bad}");
        }
        assert!(is_iso_duration("P1Y2M"));
        assert!(!is_iso_duration("P"));
    }

    #[test]
    fn infer_types_a_comparison() {
        let e: Value = serde_json::json!({"op":"eq","left":{"field":"a"},"right":{"value":1}});
        let r = infer(&e, &|n| (n == "a").then(|| "int".to_string()));
        assert_eq!(r.ty.as_deref(), Some("boolean"));
        assert!(r.errors.is_empty());
        let bad = infer(&serde_json::json!({"field":"a"}), &|_| Some("int".into()));
        assert_eq!(bad.ty.as_deref(), Some("int"));
    }
}
