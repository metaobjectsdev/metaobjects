//! The shared metamodel corpus (`fixtures/conformance/`): every fixture directory is
//! loaded and checked against the expectation files it declares, as the other
//! ports' runners do.
//!
//! Fixtures this port does not pass yet are listed in
//! `conformance-expected-failures.json` beside this file. The ledger may only
//! shrink: a listed fixture that now passes fails the run until it is removed, and
//! a listed name with no fixture directory fails the run.
//!
//! While the port is in preview (ADR-0065 decision 5), an unlisted fixture that
//! fails prints a warning instead of failing the run, so a new fixture added for
//! another port never turns this lane red. A regression is still caught: the ledger
//! records `minPassing`, the number of fixtures known to pass, and the run fails
//! when fewer pass. Raise it when fixtures leave the ledger; it may only rise.

use std::path::{Path, PathBuf};

use serde_json::Value;

use metaobjects::errors::MetaError;
use metaobjects::json::{safe_whole_i64, to_js_pretty};
use metaobjects::loader::Loader;
use metaobjects::providers::{Provider, builtin_provider, compose_registry};
use metaobjects::registry::{AttrSchema, ChildRule, TypeDefinition, TypeRegistry};
use metaobjects::serializer::{canonical_serialize_effective, to_canonical_value};
use metaobjects::source::ErrorSource;

const DEFAULT_PROVIDERS: &[&str] = &[
    "metaobjects-core-types",
    "metaobjects-db",
    "metaobjects-documentation",
    "metaobjects-prompt",
    "metaobjects-ui",
    "metaobjects-ui-web",
];

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/conformance")
}

fn ledger_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/conformance-expected-failures.json")
}

// ---- test-only providers, as in the other ports' adapters --------------------

fn noop(_: &mut TypeRegistry) -> Result<(), MetaError> {
    Ok(())
}

fn required(name: &str, value_type: &str) -> AttrSchema {
    let mut a = AttrSchema::simple(name, Some(value_type), "");
    a.required = true;
    a
}

fn register_briefing(r: &mut TypeRegistry) -> Result<(), MetaError> {
    let mut def = TypeDefinition::new("template", "briefing", "");
    def.attributes = vec![
        required("payloadRef", "string"),
        required("author", "string"),
        required("recipient", "string"),
    ];
    def.child_rules = vec![ChildRule::wildcard("attr")];
    r.register(def)
}

fn register_custom_vocabulary(r: &mut TypeRegistry) -> Result<(), MetaError> {
    let mut def = TypeDefinition::new("layout", "picker", "");
    def.attributes = vec![AttrSchema::simple("displayField", Some("string"), "")];
    def.child_rules = vec![ChildRule::wildcard("attr")];
    r.register(def)?;
    let mut labels = AttrSchema::simple("valueLabels", Some("string"), "");
    labels.is_array = Some(true);
    r.extend(
        "field",
        "string",
        vec![
            AttrSchema::simple("searchable", Some("boolean"), ""),
            labels,
        ],
        Vec::new(),
    )
}

fn provider(id: &str) -> Provider {
    if let Some(p) = builtin_provider(id) {
        return p;
    }
    let core = &["metaobjects-core-types"][..];
    match id {
        "example-template-briefing" => Provider::new(id, core, "", register_briefing),
        "example-custom-vocabulary" => Provider::new(id, core, "", register_custom_vocabulary),
        "cycle-a" => Provider::new(id, &["cycle-b"], "", noop),
        "cycle-b" => Provider::new(id, &["cycle-a"], "", noop),
        "depends-on-missing" => Provider::new(id, &["does-not-exist"], "", noop),
        "duplicate-x" | "duplicate-x-clone" => Provider::new("duplicate-x", &[], "", noop),
        other => panic!("unknown provider id {other:?}"),
    }
}

// ---- one fixture ---------------------------------------------------------------

struct Outcome {
    errors: Vec<MetaError>,
    canonical: Option<Value>,
    effective: Option<String>,
}

fn run_load(fixture: &Path) -> Outcome {
    let ids: Vec<String> = match std::fs::read_to_string(fixture.join("providers.json")) {
        Ok(text) => serde_json::from_str(&text).expect("providers.json is a string array"),
        Err(_) => DEFAULT_PROVIDERS.iter().map(|s| s.to_string()).collect(),
    };
    let providers: Vec<Provider> = ids.iter().map(|id| provider(id)).collect();
    let mut registry = match compose_registry(&providers) {
        Ok(r) => r,
        Err(e) => {
            return Outcome {
                errors: vec![e],
                canonical: None,
                effective: None,
            };
        }
    };
    registry.seal();
    let input = fixture.join("input");
    let result = Loader::new(&registry)
        .load_dir(&input)
        .expect("fixture input is readable");
    let prefix = format!("{}/", input.to_string_lossy());
    let errors = result
        .errors
        .into_iter()
        .map(|mut e| {
            e.source
                .map_files(|f| f.strip_prefix(&prefix).unwrap_or(f).replace('\\', "/"));
            e
        })
        .collect();
    Outcome {
        errors,
        canonical: Some(to_canonical_value(&result.tree, result.root, false)),
        effective: Some(canonical_serialize_effective(&result.tree, result.root)),
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap())
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Whole-number doubles as integers, so `1.0` and `1` compare equal as in JSON.
fn normalize_numbers(v: &Value) -> Value {
    match v {
        Value::Number(n) if n.is_f64() => n
            .as_f64()
            .and_then(safe_whole_i64)
            .map_or_else(|| v.clone(), Value::from),
        Value::Array(items) => Value::Array(items.iter().map(normalize_numbers).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| (k.clone(), normalize_numbers(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}

fn check_envelope(i: usize, want: &Value, got: &MetaError, failures: &mut Vec<String>) {
    if let Some(needles) = want.get("messageIncludes").and_then(Value::as_array) {
        for needle in needles.iter().filter_map(Value::as_str) {
            if !got.message.contains(needle) {
                failures.push(format!(
                    "envelope[{i}].message: expected to include {needle:?}, got {:?}",
                    got.message
                ));
            }
        }
    }
    let Some(src) = want.get("source").filter(|s| s.is_object()) else {
        return;
    };
    let format = src["format"].as_str().unwrap_or_default();
    if format != got.source.format() {
        failures.push(format!(
            "envelope[{i}].source.format: expected {format:?}, got {:?}",
            got.source.format()
        ));
    }
    let want_files: Vec<&str> = src["files"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if want_files
        != got
            .source
            .files()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    {
        failures.push(format!(
            "envelope[{i}].source.files: expected {want_files:?}, got {:?}",
            got.source.files()
        ));
    }
    if let Some(path) = src.get("jsonPath").and_then(Value::as_str)
        && Some(path) != got.source.json_path()
    {
        failures.push(format!(
            "envelope[{i}].source.jsonPath: expected {path:?}, got {:?}",
            got.source.json_path()
        ));
    }
    let (referrer, target) = match got.source.as_ref() {
        ErrorSource::Resolved {
            referrer, target, ..
        } => (Some(referrer.as_str()), Some(target.as_str())),
        _ => (None, None),
    };
    if let Some(r) = src.get("referrer").and_then(Value::as_str)
        && Some(r) != referrer
    {
        failures.push(format!(
            "envelope[{i}].source.referrer: expected {r:?}, got {referrer:?}"
        ));
    }
    if let Some(t) = src.get("target").and_then(Value::as_str)
        && Some(t) != target
    {
        failures.push(format!(
            "envelope[{i}].source.target: expected {t:?}, got {target:?}"
        ));
    }
}

/// Run every check `fixture` declares. An empty list is a pass.
fn check(fixture: &Path) -> Vec<String> {
    let has = |f: &str| fixture.join(f).is_file();
    let mut failures = Vec::new();
    if has("script.json") {
        failures.push("script.json operations are not implemented in the Rust port yet".into());
    }
    let out = run_load(fixture);
    let mut codes: Vec<&str> = out.errors.iter().map(|e| e.code).collect();
    codes.sort_unstable();

    if !has("expected-errors.json")
        && (has("expected.json")
            || has("expected-effective.json")
            || has("expected-warnings.json")
            || has("script.json"))
        && !codes.is_empty()
    {
        failures.push(format!(
            "happy-path fixture loaded with unexpected error(s): {codes:?}: {}",
            out.errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join(" | ")
        ));
    }

    if has("expected-errors.json") {
        let raw = read_json(&fixture.join("expected-errors.json"));
        let (wanted, legacy): (Vec<Value>, bool) = match &raw {
            Value::Array(items) => (items.clone(), true),
            Value::Object(m) => (
                m.get("errors")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                false,
            ),
            _ => panic!("expected-errors.json has an unknown shape"),
        };
        let mut want: Vec<&str> = wanted.iter().filter_map(|e| e["code"].as_str()).collect();
        want.sort_unstable();
        if want != codes {
            failures.push(format!("errors: want {want:?} got {codes:?}"));
        }
        if !legacy {
            if wanted.len() != out.errors.len() {
                failures.push(format!(
                    "envelope length mismatch: expected {}, got {}",
                    wanted.len(),
                    out.errors.len()
                ));
            } else {
                for (i, (w, g)) in wanted.iter().zip(&out.errors).enumerate() {
                    if w["code"].as_str() != Some(g.code) {
                        failures.push(format!(
                            "envelope[{i}].code: expected {}, got {}",
                            w["code"], g.code
                        ));
                        continue;
                    }
                    check_envelope(i, w, g, &mut failures);
                }
            }
            let want_warnings = raw
                .get("warnings")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if want_warnings != 0 {
                failures.push(format!("warnings count: expected {want_warnings}, got 0"));
            }
        }
    }

    if has("expected.json") {
        let want = normalize_numbers(&read_json(&fixture.join("expected.json")));
        match &out.canonical {
            Some(got) if normalize_numbers(got) == want => {}
            Some(got) => failures.push(format!(
                "canonical serialization mismatch; got:\n{}",
                to_js_pretty(got)
            )),
            None => failures.push("canonical serialization mismatch: no tree".into()),
        }
    }

    if has("expected-effective.json") {
        let want = std::fs::read_to_string(fixture.join("expected-effective.json")).unwrap();
        let got = out.effective.clone().unwrap_or_default();
        if want.trim() != got.trim() {
            failures.push(format!("effective serialization mismatch; got:\n{got}"));
        }
    }

    if has("expected-warnings.json") {
        let want = read_json(&fixture.join("expected-warnings.json"));
        if want.as_array().is_some_and(|a| !a.is_empty()) {
            failures.push(format!("warnings: want {want} got []"));
        }
    }
    failures
}

#[test]
fn metamodel_corpus() {
    let doc = read_json(&ledger_path());
    assert_eq!(doc["language"], "rust", "the ledger names its port");
    let min_passing = doc["minPassing"]
        .as_u64()
        .expect("the ledger records minPassing");
    let ledger: Vec<String> = {
        doc["fixtures"]
            .as_array()
            .expect("ledger has a fixtures list")
            .iter()
            .map(|v| v.as_str().expect("fixture names are strings").to_string())
            .collect()
    };
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input").is_dir())
        .collect();
    dirs.sort();

    let names: Vec<String> = dirs
        .iter()
        .map(|d| d.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    let stale: Vec<&String> = ledger.iter().filter(|l| !names.contains(l)).collect();
    assert!(
        stale.is_empty(),
        "these ledger entries name no fixture directory; remove them: {stale:?}"
    );

    let only = std::env::var("MO_FIXTURE").ok();
    let mut passed = 0;
    let mut unexpected = Vec::new();
    let mut fixed = Vec::new();
    for dir in &dirs {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        let failures = check(dir);
        let listed = ledger.contains(&name);
        match (failures.is_empty(), listed) {
            (true, false) => passed += 1,
            (true, true) => fixed.push(name),
            (false, true) => {
                if only.is_some() {
                    eprintln!("{name} [known gap]: {}", failures.join("; "));
                }
            }
            (false, false) => unexpected.push(format!("{name}: {}", failures.join("; "))),
        }
    }
    eprintln!(
        "metamodel corpus: {passed} of {} fixtures pass; {} on the expected-failures ledger; {} unlisted failures",
        dirs.len(),
        ledger.len(),
        unexpected.len()
    );
    for failure in &unexpected {
        eprintln!(
            "warning: fixture fails in Rust and is not on the ledger (preview port, not a gate failure): {failure}"
        );
    }
    assert!(
        fixed.is_empty(),
        "these ledgered fixtures now pass; remove them from the ledger (it may only shrink): {fixed:?}"
    );
    if only.is_none() {
        assert!(
            passed as u64 >= min_passing,
            "{passed} fixtures pass but the ledger's minPassing is {min_passing}: a fixture that passed has regressed (see the warnings above)"
        );
    }
}
