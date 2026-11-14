//! The registry-conformance gate: the built-in registry, written as a manifest,
//! must match the shared `expected-registry.json` byte for byte.

use std::path::PathBuf;

use metaobjects::manifest::emit_manifest;
use metaobjects::providers::{builtin_provider, compose_registry};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/registry-conformance")
}

#[test]
fn manifest_matches_the_shared_registry_fixture() {
    let dir = fixture_dir();
    let providers_doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("providers.json")).unwrap())
            .unwrap();
    // providers.json indexes the logical provider ids; the manifest is built from
    // all of them, in the order the file lists them.
    let ids: Vec<&str> = providers_doc["providers"]
        .as_object()
        .expect("providers.json has a providers map")
        .keys()
        .map(String::as_str)
        .collect();
    let providers: Vec<_> = ids
        .iter()
        .map(|id| builtin_provider(id).unwrap_or_else(|| panic!("unknown provider {id}")))
        .collect();
    let registry = compose_registry(&providers).expect("the built-in providers compose");
    let actual = emit_manifest(&registry);
    let expected = std::fs::read_to_string(dir.join("expected-registry.json")).unwrap();
    if actual != expected {
        let out = std::env::temp_dir().join("metaobjects-rust-actual-registry.json");
        std::fs::write(&out, &actual).unwrap();
        let line = actual
            .lines()
            .zip(expected.lines())
            .position(|(a, e)| a != e)
            .map_or(actual.lines().count().min(expected.lines().count()), |i| i);
        panic!(
            "registry manifest differs from expected-registry.json at line {} (actual written to {})",
            line + 1,
            out.display()
        );
    }
}
