//! The shared reply-parser corpus (`fixtures/extract-conformance/`): per case, `schema.json`
//! (format, rootName, fields, optional tolerance and rootless), `input.txt` (a deliberately
//! dirty model reply) and `expected.json` (`empty`, per-path `states`, `malformedRequired`,
//! and the data as dotted leaf paths). Numbers compare within 1e-9, as every runner does.

use std::path::{Path, PathBuf};

use serde_json::Value;

use metaobjects_render::extract::{
    ExtractOptions, ExtractSchema, FieldKind, FieldSpec, Format, Tolerance, extract,
};

/// The corpus size: a deleted case fails here rather than silently shrinking coverage.
const CASES: usize = 58;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/extract-conformance")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn opt_string(f: &Value, key: &str) -> Option<String> {
    f.get(key)
        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
}

fn opt_usize(f: &Value, key: &str) -> Option<usize> {
    f.get(key)
        .and_then(Value::as_u64)
        .map(|n| usize::try_from(n).expect("fits"))
}

fn parse_field(f: &Value) -> FieldSpec {
    let name = f["name"].as_str().expect("name");
    let kind = FieldKind::parse(f["kind"].as_str().expect("kind")).expect("known kind");
    let required = f["required"].as_bool().unwrap_or(false);
    let array = f["array"].as_bool().unwrap_or(false);
    let mut spec = match kind {
        FieldKind::Enum => {
            let values = f["enumValues"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|v| v.as_str().expect("member").to_string())
                        .collect()
                })
                .unwrap_or_default();
            let aliases = f["enumAlias"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().expect("member").to_string()))
                        .collect()
                })
                .unwrap_or_default();
            FieldSpec::enumeration(name, required, values)
                .aliases(aliases)
                .coerce_default(opt_string(f, "coerceDefault"))
                .normalize(f["normalize"].as_str().unwrap_or("strip"))
        }
        FieldKind::Object => {
            let nested = f["fields"]
                .as_array()
                .map(|a| a.iter().map(parse_field).collect())
                .unwrap_or_default();
            FieldSpec::object(
                name,
                required,
                ExtractSchema {
                    format: Format::Json,
                    root_name: name.to_string(),
                    fields: nested,
                },
            )
        }
        _ => {
            let spec =
                FieldSpec::scalar(name, kind, required).range(f["min"].as_f64(), f["max"].as_f64());
            if f["textContent"].as_bool().unwrap_or(false) {
                spec.text_content()
            } else {
                spec
            }
        }
    };
    spec = spec.default_value(opt_string(f, "default"));
    if array {
        spec = spec.array();
    }
    spec.item_bounds(opt_usize(f, "minItems"), opt_usize(f, "maxItems"))
}

fn flatten(prefix: &str, value: &Value, out: &mut Vec<(String, Value)>) {
    match value {
        Value::Object(m) => {
            for (k, v) in m {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten(&key, v, out);
            }
        }
        Value::Array(xs) => {
            for (i, v) in xs.iter().enumerate() {
                flatten(&format!("{prefix}[{i}]"), v, out);
            }
        }
        other => out.push((prefix.to_string(), other.clone())),
    }
}

fn run_case(dir: &Path) -> Result<(), String> {
    let node = read_json(&dir.join("schema.json"));
    let schema = ExtractSchema {
        format: Format::parse(node["format"].as_str().expect("format")).expect("known format"),
        root_name: node["rootName"].as_str().expect("rootName").to_string(),
        fields: node["fields"]
            .as_array()
            .expect("fields")
            .iter()
            .map(parse_field)
            .collect(),
    };
    let text = std::fs::read_to_string(dir.join("input.txt")).map_err(|e| e.to_string())?;
    let expected = read_json(&dir.join("expected.json"));
    let mut opts = ExtractOptions::default().rootless(node["rootless"].as_bool().unwrap_or(false));
    if let Some(t) = node["tolerance"].as_str() {
        opts = opts.tolerance(Tolerance::parse(t).expect("known tolerance"));
    }
    let outcome = extract(Some(&text), &schema, &opts);
    let mut problems = Vec::new();

    if outcome.report.is_empty() != expected["empty"].as_bool().unwrap_or(false) {
        problems.push(format!("empty: got {}", outcome.report.is_empty()));
    }
    let mut got_states: Vec<(String, String)> = outcome
        .report
        .states()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().to_string()))
        .collect();
    got_states.sort();
    let mut want_states: Vec<(String, String)> = expected["states"]
        .as_object()
        .expect("states")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().expect("state").to_string()))
        .collect();
    want_states.sort();
    if got_states != want_states {
        problems.push(format!(
            "states:\n    got  {got_states:?}\n    want {want_states:?}"
        ));
    }
    let mut got_mr = outcome.report.malformed_required().to_vec();
    got_mr.sort();
    let mut want_mr: Vec<String> = expected
        .get("malformedRequired")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().expect("path").to_string())
                .collect()
        })
        .unwrap_or_default();
    want_mr.sort();
    if got_mr != want_mr {
        problems.push(format!(
            "malformedRequired: got {got_mr:?}, want {want_mr:?}"
        ));
    }

    let mut leaves = Vec::new();
    flatten("", &Value::Object(outcome.data.clone()), &mut leaves);
    let want = expected["data"].as_object().expect("data");
    let mut got_keys: Vec<&String> = leaves.iter().map(|(k, _)| k).collect();
    got_keys.sort();
    let mut want_keys: Vec<&String> = want.keys().collect();
    want_keys.sort();
    if got_keys != want_keys {
        problems.push(format!("data leaves: got {got_keys:?}, want {want_keys:?}"));
    } else {
        for (path, got) in &leaves {
            let exp = &want[path];
            let same = match (exp, got) {
                (Value::Bool(a), Value::Bool(b)) => a == b,
                (Value::Number(a), Value::Number(b)) => {
                    (a.as_f64().expect("f64") - b.as_f64().expect("f64")).abs() <= 1e-9
                }
                (Value::Number(_), _) | (Value::Bool(_), _) => false,
                (e, g) => text_of(e) == text_of(g),
            };
            if !same {
                problems.push(format!("data[{path}]: got {got}, want {exp}"));
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n  "))
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

#[test]
fn extract_conformance_corpus() {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus())
        .expect("fixtures/extract-conformance")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("schema.json").is_file())
        .collect();
    dirs.sort();
    assert_eq!(dirs.len(), CASES, "extract-conformance case count");
    let failures: Vec<String> = dirs
        .iter()
        .filter_map(|d| {
            run_case(d)
                .err()
                .map(|e| format!("FAIL {}:\n  {e}", d.file_name().unwrap().to_string_lossy()))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} failing\n{}",
        failures.len(),
        failures.join("\n")
    );
}
