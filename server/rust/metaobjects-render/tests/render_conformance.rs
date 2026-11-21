//! The shared render corpus (`fixtures/render-conformance/`): the same template, payload,
//! partials and format give the same bytes in every port.
//!
//! Each case directory holds `template.mustache`, `payload.json`, either `expected.txt`
//! (byte-identical output) or `expected-error.txt` (the render must fail, with a message
//! containing the file's trimmed text), an
//! optional `meta.json` (`format`, `maxChars`) and optional `partials/<name>.mustache`,
//! referenced as `{{> partials/<name>}}`. A sub-corpus with no `template.mustache` of its
//! own (`template-generator/`, which drives the codegen `template` generator) has its own
//! harness and is not a render case.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use metaobjects_render::{Body, InMemoryProvider, RenderRequest, render};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/render-conformance")
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn run_case(dir: &Path) -> Result<(), String> {
    let template = read(&dir.join("template.mustache"));
    let payload: Value = serde_json::from_str(&read(&dir.join("payload.json")))
        .map_err(|e| format!("payload.json: {e}"))?;
    let error_path = dir.join("expected-error.txt");
    let expected_error = error_path
        .is_file()
        .then(|| read(&error_path).trim().to_string());
    let meta: Value = if dir.join("meta.json").is_file() {
        serde_json::from_str(&read(&dir.join("meta.json"))).map_err(|e| e.to_string())?
    } else {
        Value::Null
    };
    let format = meta["format"].as_str().unwrap_or("text");
    let max_chars = meta["maxChars"]
        .as_u64()
        .map(|n| usize::try_from(n).expect("maxChars fits"));

    let mut partials = HashMap::new();
    let pdir = dir.join("partials");
    if pdir.is_dir() {
        for entry in std::fs::read_dir(&pdir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|x| x == "mustache") {
                let stem = path.file_stem().expect("stem").to_string_lossy();
                partials.insert(format!("partials/{stem}"), read(&path));
            }
        }
    }
    let provider = InMemoryProvider::new(partials);
    let result = render(
        &RenderRequest::new(Body::Inline(&template), &payload, &provider)
            .format(format)
            .max_chars(max_chars),
    );
    if let Some(wanted) = expected_error {
        return match result {
            Err(e) if e.to_string().contains(&wanted) => Ok(()),
            Err(e) => Err(format!(
                "expected an error containing {wanted:?}\n  actual   {e}"
            )),
            Ok(out) => Err(format!(
                "expected an error containing {wanted:?}\n  rendered {out:?}"
            )),
        };
    }
    let expected = read(&dir.join("expected.txt"));
    let actual = result.map_err(|e| e.to_string())?;
    if actual == expected {
        Ok(())
    } else {
        Err(format!("expected {expected:?}\n  actual   {actual:?}"))
    }
}

#[test]
fn render_conformance_corpus() {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(corpus())
        .expect("fixtures/render-conformance")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.join("template.mustache").is_file())
        .collect();
    dirs.sort();
    assert!(dirs.len() >= 18, "found only {} render cases", dirs.len());
    let failures: Vec<String> = dirs
        .iter()
        .filter_map(|d| {
            run_case(d)
                .err()
                .map(|e| format!("FAIL {}: {e}", d.file_name().unwrap().to_string_lossy()))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
