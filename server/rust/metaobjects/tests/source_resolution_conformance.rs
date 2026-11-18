//! The source-resolution gate: every case of the shared
//! `fixtures/source-resolution-conformance/cases.json` must resolve the same
//! file set (or fail the same way) as every other port.
//!
//! `tests/source-resolution-expected-failures.json` is a ledger of case names
//! known to fail. It may only shrink, and it is empty.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use metaobjects::collection::resolve_collection;
use metaobjects::naming::NamingRegistry;
use serde_json::Value;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/source-resolution-conformance")
}

/// A fresh directory under `$DEV_SCRATCH` (RAM) or the system temp dir, removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "mo-source-resolution-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn materialize(root: &Path, case: &Value) {
    for (rel, content) in case["tree"].as_object().unwrap() {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content.as_str().unwrap()).unwrap();
    }
    if let Some(links) = case.get("symlinks").and_then(Value::as_object) {
        for (link, target) in links {
            let link = root.join(link);
            std::fs::create_dir_all(link.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(root.join(target.as_str().unwrap()), &link).unwrap();
        }
    }
    let from = root.join(
        case.get("resolveFrom")
            .and_then(Value::as_str)
            .unwrap_or("."),
    );
    if !case["config"].is_null() {
        std::fs::create_dir_all(from.join(".metaobjects")).unwrap();
        std::fs::write(
            from.join(".metaobjects/config.json"),
            serde_json::to_string(&case["config"]).unwrap(),
        )
        .unwrap();
    }
    std::fs::create_dir_all(&from).unwrap();
}

/// Run one case; `Err` describes how it diverged.
fn run_case(case: &Value) -> Result<(), String> {
    let scratch = Scratch::new();
    let root = scratch.0.clone();
    materialize(&root, case);
    let from = root.join(
        case.get("resolveFrom")
            .and_then(Value::as_str)
            .unwrap_or("."),
    );
    let result = resolve_collection(&from, Some(&from), &NamingRegistry::builtin());
    match (case.get("expectFiles"), case.get("expectError")) {
        (Some(files), None) => {
            let c = result.map_err(|e| format!("unexpected error: {e}"))?;
            let actual: Vec<String> = c
                .files
                .iter()
                .map(|f| {
                    f.strip_prefix(&root)
                        .unwrap_or_else(|_| panic!("{} is outside the case root", f.display()))
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect();
            let expected: BTreeSet<String> = files
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            let set: BTreeSet<String> = actual.iter().cloned().collect();
            if set != expected {
                return Err(format!("files {set:?} != expected {expected:?}"));
            }
            if actual.len() != expected.len() {
                return Err(format!(
                    "{} files resolved, a duplicate collapsed: {actual:?}",
                    actual.len()
                ));
            }
            Ok(())
        }
        (None, Some(Value::String(code))) => match result {
            Err(e) if e.code == code => Ok(()),
            Err(e) => Err(format!("failed with {} not {code}: {}", e.code, e.message)),
            Ok(_) => Err(format!("resolved, expected {code}")),
        },
        (None, Some(Value::Bool(true))) => match result {
            Err(e) if !e.code.is_empty() => Ok(()),
            Err(_) => Err("raised an uncoded error".into()),
            Ok(_) => Err("resolved, expected an error".into()),
        },
        _ => Err("case has neither expectFiles nor expectError".into()),
    }
}

#[test]
fn every_case_resolves_as_pinned() {
    let cases: Value =
        serde_json::from_str(&std::fs::read_to_string(fixture_dir().join("cases.json")).unwrap())
            .unwrap();
    let ledger: Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/source-resolution-expected-failures.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let expected_failures: BTreeSet<&str> = ledger["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let (mut failed, mut unexpected_pass, mut passing) = (Vec::new(), Vec::new(), 0);
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        match (run_case(case), expected_failures.contains(name)) {
            (Ok(()), false) => passing += 1,
            (Ok(()), true) => unexpected_pass.push(name),
            (Err(why), false) => failed.push(format!("{name}: {why}")),
            (Err(_), true) => {}
        }
    }
    assert!(failed.is_empty(), "cases failed:\n{}", failed.join("\n"));
    assert!(
        unexpected_pass.is_empty(),
        "these cases pass now; remove them from the ledger: {unexpected_pass:?}"
    );
    let total = cases["cases"].as_array().unwrap().len();
    assert!(total >= 27, "the corpus shrank to {total} cases");
    assert_eq!(passing, total - expected_failures.len());
}
