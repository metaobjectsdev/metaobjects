//! The shipped templates of the `metamodel-docs` generator: the shared `templates/metamodel/`
//! Mustache set every port renders, synced into this crate by `scripts/sync-doc-templates.sh`
//! and embedded here, so an ejected copy of the generator (which cannot `include_str!` them
//! from its own directory) reads them through [`shipped_template`].

use std::collections::BTreeMap;

const INDEX: &str = include_str!("../templates/metamodel/index.md.mustache");
const PROVIDERS: &str = include_str!("../templates/metamodel/providers.md.mustache");
const TYPE_PAGE: &str = include_str!("../templates/metamodel/type-page.md.mustache");
const PROVIDER_DESCRIPTIONS: &str =
    include_str!("../templates/metamodel/provider-descriptions.json");

/// The shipped template of a ref such as `metamodel/index.md`.
pub fn shipped_template(reference: &str) -> Option<&'static str> {
    match reference {
        "metamodel/index.md" => Some(INDEX),
        "metamodel/providers.md" => Some(PROVIDERS),
        "metamodel/type-page.md" => Some(TYPE_PAGE),
        _ => None,
    }
}

/// Each provider's one-line description, by provider id.
pub fn shipped_provider_descriptions() -> BTreeMap<String, String> {
    let doc: serde_json::Value = serde_json::from_str(PROVIDER_DESCRIPTIONS)
        .expect("provider-descriptions.json is valid JSON");
    doc.as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
        .collect()
}
