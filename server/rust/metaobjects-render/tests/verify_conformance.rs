//! The shared template drift corpus (`fixtures/verify-conformance/`): per case a payload
//! field tree, a `template.mustache`, optional `partials/` and `options.json`, and the
//! expected findings. `expected-drift.rust.json`, where present, replaces
//! `expected-drift.json`: the Rust renderer refuses every delimiter change, so its check
//! reports each one (as the Python port does).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use metaobjects_render::InMemoryProvider;
use metaobjects_render::verify::{PayloadField, VerifyError, VerifyOptions, verify};

/// The corpus size: a deleted case fails here.
const CASES: usize = 45;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/verify-conformance")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn fields(raw: &Value) -> Vec<PayloadField> {
    raw.as_array()
        .expect("field list")
        .iter()
        .map(|n| {
            PayloadField::owned(
                n["name"].as_str().expect("name").to_string(),
                n.get("fields").map(fields),
                n["isArray"].as_bool().unwrap_or(false),
            )
        })
        .collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|s| s.as_str().expect("string").to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn run_case(dir: &Path) -> Result<(), String> {
    let payload: Value = serde_json::from_str(&read(&dir.join("payload.json"))).expect("payload");
    let template = read(&dir.join("template.mustache"));
    let rust = dir.join("expected-drift.rust.json");
    let expected_path = if rust.is_file() {
        rust
    } else {
        dir.join("expected-drift.json")
    };
    let expected: Value = serde_json::from_str(&read(&expected_path)).expect("expected");
    let mut want: Vec<VerifyError> = expected
        .as_array()
        .expect("findings")
        .iter()
        .map(|e| VerifyError {
            code: e["code"].as_str().expect("code").to_string(),
            path: e["path"].as_str().expect("path").to_string(),
        })
        .collect();
    want.sort();

    let opts_path = dir.join("options.json");
    let opts: Value = if opts_path.is_file() {
        serde_json::from_str(&read(&opts_path)).expect("options")
    } else {
        Value::Null
    };
    let partials_dir = dir.join("partials");
    // "with" builds a provider from partials/ (empty when there is none); "without" has
    // none; absent, a provider exists exactly when partials/ does.
    let with_provider = match opts["provider"].as_str() {
        Some(mode) => mode == "with",
        None => partials_dir.is_dir(),
    };
    let mut partials = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&partials_dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| x == "mustache") {
                let stem = p.file_stem().expect("stem").to_string_lossy();
                partials.insert(format!("partials/{stem}"), read(&p));
            }
        }
    }
    let provider = InMemoryProvider::new(partials);
    let slots = strings(&opts["requiredSlots"]);
    let tags = strings(&opts["requiredTags"]);
    let options = VerifyOptions {
        provider: with_provider.then_some(&provider as &dyn metaobjects_render::Provider),
        required_slots: &slots,
        required_tags: &tags,
    };
    let fields = fields(&payload);
    let mut got = verify(&template, &fields, &options);
    got.sort();
    if got == want {
        Ok(())
    } else {
        Err(format!("got {got:?}\n  want {want:?}"))
    }
}

#[test]
fn verify_conformance_corpus() {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus())
        .expect("fixtures/verify-conformance")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("template.mustache").is_file())
        .collect();
    dirs.sort();
    assert_eq!(dirs.len(), CASES, "verify-conformance case count");
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
