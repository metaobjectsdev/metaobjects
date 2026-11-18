//! The shared YAML corpus (`fixtures/yaml-conformance/`): each directory holds an
//! `input.yaml` and either an `expected.json` (the canonical serialization the
//! document must produce) or an `expected-errors.json` (the error envelopes, in
//! order). Fixtures this port does not pass yet are listed in
//! `yaml-conformance-expected-failures.json`; the ledger may only shrink, and
//! `minPassing` may only rise.

use std::path::PathBuf;

use serde_json::Value;

use metaobjects::loader::Loader;
use metaobjects::providers::default_registry;
use metaobjects::serializer::canonical_serialize;

const INPUT: &str = "input.yaml";

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/yaml-conformance")
}

fn read_json(path: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap())
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn check(dir: &std::path::Path) -> Vec<String> {
    let mut registry = default_registry().expect("the built-in providers compose");
    registry.seal();
    let text = std::fs::read_to_string(dir.join(INPUT)).unwrap();
    let result = Loader::new(&registry).load_sources(&[(INPUT.to_string(), text)]);
    let mut failures = Vec::new();
    let errors_file = dir.join("expected-errors.json");
    if errors_file.is_file() {
        let raw = read_json(&errors_file);
        let wanted: Vec<Value> = match &raw {
            Value::Array(items) => items.clone(),
            other => other["errors"].as_array().cloned().unwrap_or_default(),
        };
        if wanted.len() != result.errors.len() {
            failures.push(format!(
                "want {} errors, got {:?}",
                wanted.len(),
                result.errors.iter().map(|e| e.code).collect::<Vec<_>>()
            ));
            return failures;
        }
        for (i, (w, g)) in wanted.iter().zip(&result.errors).enumerate() {
            if w["code"].as_str() != Some(g.code) {
                failures.push(format!(
                    "errors[{i}].code: want {}, got {}",
                    w["code"], g.code
                ));
                continue;
            }
            let Some(src) = w.get("source") else { continue };
            let want_format = src["format"].as_str().unwrap_or_default();
            if want_format != g.source.format() {
                failures.push(format!(
                    "errors[{i}].format: want {want_format}, got {}",
                    g.source.format()
                ));
            }
            let want_files: Vec<&str> = src["files"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if want_files != g.source.files() {
                failures.push(format!("errors[{i}].files: want {want_files:?}"));
            }
            if let Some(p) = src["jsonPath"].as_str()
                && Some(p) != g.source.json_path()
            {
                failures.push(format!(
                    "errors[{i}].jsonPath: want {p}, got {:?}",
                    g.source.json_path()
                ));
            }
            if let Some(pos) = src.get("yamlPosition") {
                let got = g.source.yaml_position();
                let want = (pos["line"].as_u64(), pos["col"].as_u64());
                if got.map(|p| (Some(u64::from(p.line)), Some(u64::from(p.col)))) != Some(want) {
                    failures.push(format!(
                        "errors[{i}].yamlPosition: want {want:?}, got {got:?}"
                    ));
                }
            }
        }
    } else {
        if !result.errors.is_empty() {
            failures.push(format!(
                "unexpected errors: {:?}",
                result
                    .errors
                    .iter()
                    .map(|e| e.to_string())
                    .collect::<Vec<_>>()
            ));
        }
        let want = std::fs::read_to_string(dir.join("expected.json")).unwrap();
        let got = canonical_serialize(&result.tree, result.root);
        if want.trim() != got.trim() {
            failures.push(format!("canonical mismatch; got:\n{got}"));
        }
    }
    failures
}

#[test]
fn yaml_corpus() {
    let ledger_doc = read_json(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/yaml-conformance-expected-failures.json"),
    );
    assert_eq!(ledger_doc["language"], "rust");
    let min_passing = ledger_doc["minPassing"].as_u64().unwrap();
    let ledger: Vec<String> = ledger_doc["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join(INPUT).is_file())
        .collect();
    dirs.sort();
    let names: Vec<String> = dirs
        .iter()
        .map(|d| d.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    let stale: Vec<&String> = ledger.iter().filter(|l| !names.contains(l)).collect();
    assert!(stale.is_empty(), "ledger names no fixture: {stale:?}");
    let only = std::env::var("MO_FIXTURE").ok();
    let (mut passed, mut fixed, mut unexpected) = (0u64, Vec::new(), Vec::new());
    for (dir, name) in dirs.iter().zip(&names) {
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        let failures = check(dir);
        match (failures.is_empty(), ledger.contains(name)) {
            (true, false) => passed += 1,
            (true, true) => fixed.push(name.clone()),
            (false, true) => {
                if only.is_some() {
                    eprintln!("{name} [known gap]: {}", failures.join("; "));
                }
            }
            (false, false) => unexpected.push(format!("{name}: {}", failures.join("; "))),
        }
    }
    eprintln!(
        "yaml corpus: {passed} of {} fixtures pass; {} on the ledger",
        dirs.len(),
        ledger.len()
    );
    assert!(
        unexpected.is_empty(),
        "unlisted failures:\n{}",
        unexpected.join("\n")
    );
    assert!(
        fixed.is_empty(),
        "ledgered fixtures now pass; remove them: {fixed:?}"
    );
    if only.is_none() {
        assert!(
            passed >= min_passing,
            "{passed} pass but minPassing is {min_passing}"
        );
    }
}
