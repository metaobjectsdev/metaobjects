//! The business-rules gate corpus (`fixtures/rules-check-conformance/`): each case loads
//! `input/` strictly, reads `options.json` (the `rules` and `verify` blocks, optional)
//! through the config reader, runs the gate and compares the diagnostics and the summary
//! with `expected.json`. Diagnostics compare as an unordered set of exact
//! (severity, code, path, message) records, as the other ports' runners do.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use metaobjects::config::parse_config;
use metaobjects::loader::Loader;
use metaobjects::naming::NamingRegistry;
use metaobjects::providers::default_registry;
use metaobjects::rules_check::{RulesCheckResult, check_rules};
use metaobjects::validate::util::ObjectIndex;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/rules-check-conformance")
}

fn input_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            input_files(&p, out);
        } else if p.extension().is_some_and(|e| e == "yaml" || e == "json") {
            out.push(p);
        }
    }
}

fn run(case: &Path) -> RulesCheckResult {
    let mut registry = default_registry().expect("the built-in providers compose");
    registry.seal();
    let mut files = Vec::new();
    input_files(&case.join("input"), &mut files);
    let sources: Vec<(String, String)> = files
        .iter()
        .map(|f| {
            (
                f.to_string_lossy().into_owned(),
                std::fs::read_to_string(f).unwrap(),
            )
        })
        .collect();
    let loaded = Loader::new(&registry).load_sources(&sources);
    assert!(
        loaded.errors.is_empty(),
        "{}: the input must load clean: {:?}",
        case.display(),
        loaded.errors
    );

    let mut config = json!({ "schema_version": 1 });
    if let Ok(text) = std::fs::read_to_string(case.join("options.json")) {
        let options: Value = serde_json::from_str(&text).unwrap();
        for (k, v) in options.as_object().unwrap() {
            config[k] = v.clone();
        }
    }
    let settings = parse_config(&config, "options.json", &NamingRegistry::builtin())
        .expect("options.json is a valid config fragment")
        .config
        .rules;

    let objects = ObjectIndex::build(&loaded.tree, loaded.root);
    check_rules(&loaded.tree, loaded.root, &objects, &settings)
}

fn as_json(result: &RulesCheckResult) -> Value {
    json!({
        "diagnostics": result.diagnostics.iter().map(|d| json!({
            "severity": d.severity.as_str(),
            "code": d.code,
            "path": d.path,
            "message": d.message,
        })).collect::<Vec<_>>(),
        "summary": result.summary.map(|s| json!({
            "operations": s.operations,
            "lifecycles": s.lifecycles,
            "transitions": s.transitions,
        })),
    })
}

fn sorted(diagnostics: &Value) -> Vec<String> {
    let mut v: Vec<String> = diagnostics
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d.to_string())
        .collect();
    v.sort();
    v
}

#[test]
fn every_rules_check_case_reports_what_the_corpus_expects() {
    let mut cases: Vec<PathBuf> = std::fs::read_dir(corpus())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("expected.json").is_file())
        .collect();
    cases.sort();
    assert!(
        cases.len() >= 16,
        "the corpus has 16 cases; found {}",
        cases.len()
    );
    let mut failures = Vec::new();
    for case in &cases {
        let expected: Value =
            serde_json::from_str(&std::fs::read_to_string(case.join("expected.json")).unwrap())
                .unwrap();
        let actual = as_json(&run(case));
        let name = case.file_name().unwrap().to_string_lossy();
        if sorted(&actual["diagnostics"]) != sorted(&expected["diagnostics"]) {
            failures.push(format!(
                "{name}: diagnostics differ\n  expected: {:#?}\n  actual:   {:#?}",
                sorted(&expected["diagnostics"]),
                sorted(&actual["diagnostics"])
            ));
        }
        let expected_summary = expected.get("summary").cloned().unwrap_or(Value::Null);
        if actual["summary"] != expected_summary {
            failures.push(format!(
                "{name}: summary differs: expected {expected_summary}, actual {}",
                actual["summary"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
