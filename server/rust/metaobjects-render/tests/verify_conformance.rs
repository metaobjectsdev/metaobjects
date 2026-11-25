//! The shared template drift corpus (`fixtures/verify-conformance/`): the same payload field
//! tree, template, partials and options give the same findings in every port.
//!
//! Each case directory holds `payload.json` (the declared field tree, not render data),
//! `template.mustache`, optional `partials/<name>.mustache` (referenced as
//! `partials/<name>`), optional `options.json` (`requiredSlots`, `requiredTags`, and
//! `provider`: `with` or `without`; the default is `with` exactly when a `partials/`
//! directory exists) and `expected-drift.json`, a list of `{ code, path }` compared as a
//! sorted multiset.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use metaobjects_render::InMemoryProvider;
use metaobjects_render::presence::ERR_VAR_NOT_ON_PAYLOAD;
use metaobjects_render::verify::{
    ERR_OUTPUT_TAG_MISSING, ERR_PARTIAL_UNRESOLVED, ERR_REQUIRED_SLOT_UNUSED, ERR_TEMPLATE_SYNTAX,
    PayloadField, VerifyOptions, verify,
};

/// The corpus size: a deleted case fails here rather than silently shrinking coverage.
const CASES: usize = 45;

/// The closed set of codes a case may expect; anything else is a typo in the fixture.
const KNOWN_CODES: [&str; 5] = [
    ERR_VAR_NOT_ON_PAYLOAD,
    ERR_PARTIAL_UNRESOLVED,
    ERR_REQUIRED_SLOT_UNUSED,
    ERR_OUTPUT_TAG_MISSING,
    ERR_TEMPLATE_SYNTAX,
];

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/verify-conformance")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn run_case(dir: &Path) -> Result<(), String> {
    let fields = PayloadField::from_json(
        &serde_json::from_str(&read(&dir.join("payload.json"))).map_err(|e| e.to_string())?,
    );
    let template = read(&dir.join("template.mustache"));
    let options: Value = if dir.join("options.json").is_file() {
        serde_json::from_str(&read(&dir.join("options.json"))).map_err(|e| e.to_string())?
    } else {
        Value::Null
    };
    let partials_dir = dir.join("partials");
    let mut partials = HashMap::new();
    if partials_dir.is_dir() {
        for entry in std::fs::read_dir(&partials_dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|x| x == "mustache") {
                let stem = path.file_stem().expect("stem").to_string_lossy();
                partials.insert(format!("partials/{stem}"), read(&path));
            }
        }
    }
    let with_provider = match options["provider"].as_str() {
        Some("with") => true,
        Some("without") => false,
        _ => partials_dir.is_dir(),
    };
    let provider = InMemoryProvider::new(partials);
    let opts = VerifyOptions {
        provider: with_provider.then_some(&provider as &dyn metaobjects_render::Provider),
        required_slots: strings(&options["requiredSlots"]),
        required_tags: strings(&options["requiredTags"]),
    };

    let expected: Vec<(String, String)> =
        serde_json::from_str::<Vec<Value>>(&read(&dir.join("expected-drift.json")))
            .map_err(|e| e.to_string())?
            .iter()
            .map(|e| {
                (
                    e["code"].as_str().unwrap_or_default().to_string(),
                    e["path"].as_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
    if let Some((code, _)) = expected
        .iter()
        .find(|(c, _)| !KNOWN_CODES.contains(&c.as_str()))
    {
        return Err(format!("expected-drift.json names an unknown code {code}"));
    }
    let mut actual: Vec<(String, String)> = verify(&template, &fields, &opts)
        .into_iter()
        .map(|f| (f.code.to_string(), f.path))
        .collect();
    actual.sort();
    let mut want = expected;
    want.sort();
    if actual == want {
        Ok(())
    } else {
        Err(format!("expected {want:?}, got {actual:?}"))
    }
}

#[test]
fn the_verify_corpus_holds() {
    let mut names: Vec<String> = std::fs::read_dir(corpus())
        .expect("corpus")
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names.len(), CASES, "the corpus changed size: {names:?}");
    let failures: Vec<String> = names
        .iter()
        .filter_map(|n| {
            run_case(&corpus().join(n))
                .err()
                .map(|e| format!("{n}: {e}"))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {CASES} failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
