//! The shared reply-check corpus (`fixtures/response-verify-conformance/cases.json`): per
//! case, one canonical metadata document and the exhaustive set of reply findings the
//! template gate reports for it, compared as an unordered set of
//! `(template, code, path, severity)`.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::Value;

use metaobjects::loader::Loader;
use metaobjects::providers::default_registry;
use metaobjects::validate::prompt::TYPE_TEMPLATE;
use metaobjects::validate::util::ObjectIndex;
use metaobjects_cli::templates::{Severity, response_findings};

/// The corpus size: a deleted case fails here rather than silently shrinking coverage.
const CASES: usize = 7;

type Finding = (String, String, String, String);

fn cases() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/response-verify-conformance/cases.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    let doc: Value = serde_json::from_str(&text).expect("cases.json");
    doc["cases"].as_array().expect("cases").clone()
}

fn findings_of(metadata: &Value) -> BTreeSet<Finding> {
    let mut registry = default_registry().expect("registry");
    registry.seal();
    let result =
        Loader::new(&registry).load_sources(&[("case.json".to_string(), metadata.to_string())]);
    assert!(
        result.errors.is_empty(),
        "case does not load: {:?}",
        result.errors
    );
    let tree = &result.tree;
    let index = ObjectIndex::build(tree, result.root);
    tree.children(result.root)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_TEMPLATE)
        .flat_map(|t| {
            let name = tree.node(t).name.clone();
            response_findings(tree, &index, t)
                .into_iter()
                .map(move |f| {
                    let severity = match f.severity {
                        Severity::Error => "error",
                        Severity::Warning => "warning",
                    };
                    (
                        name.clone(),
                        f.code.to_string(),
                        f.path,
                        severity.to_string(),
                    )
                })
        })
        .collect()
}

fn expected_of(case: &Value) -> BTreeSet<Finding> {
    case["expect"]
        .as_array()
        .expect("expect")
        .iter()
        .map(|e| {
            let field = |k: &str| e[k].as_str().expect("string field").to_string();
            (
                field("template"),
                field("code"),
                field("path"),
                field("severity"),
            )
        })
        .collect()
}

#[test]
fn the_reply_corpus_holds() {
    let cases = cases();
    assert_eq!(cases.len(), CASES, "the corpus changed size");
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let (actual, expected) = (findings_of(&case["metadata"]), expected_of(case));
            (actual != expected)
                .then(|| format!("{}: expected {expected:?}, got {actual:?}", case["name"]))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
