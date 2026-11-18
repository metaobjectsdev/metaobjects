//! The shipped libraries (FR-043): manifests, selection tokens and the YAML a
//! selection contributes, embedded into the crate at compile time by `build.rs`.
//!
//! This module only resolves *which texts* a selection names, in what order and
//! under which source ids; loading them is the loader's job.

use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

use serde_json::Value;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/embedded_library.rs"));
}

/// The prefix every library source id carries.
pub const LIBRARY_FILE_ID_PREFIX: &str = "library:";

/// One layer of a library, as its manifest declares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryLayer {
    /// Refs (path under `library/` minus `.yaml`) this layer contributes, in order.
    pub refs: Vec<String>,
    pub description: Option<String>,
}

/// A library's `library.json`, parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct LibraryManifest {
    pub name: String,
    pub kind: Option<String>,
    pub stability: Option<String>,
    pub since: Option<String>,
    pub description: Option<String>,
    pub use_when: Option<String>,
    pub packages: Vec<String>,
    /// Layer token to layer, in manifest order. The CORE layer's token is `""`.
    pub layers: Vec<(String, LibraryLayer)>,
    /// `(name, anchor)` of each declared generator.
    pub generators: Vec<(String, Option<String>)>,
    /// The `runtime` map as authored, untyped.
    pub runtime: Value,
}

impl LibraryManifest {
    fn layer(&self, token: &str) -> Option<&LibraryLayer> {
        self.layers.iter().find(|(t, _)| t == token).map(|(_, l)| l)
    }
}

fn opt_string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn parse_manifest(text: &str) -> LibraryManifest {
    let v: Value = serde_json::from_str(text).expect("embedded library.json is valid JSON");
    let strings = |v: Option<&Value>| -> Vec<String> {
        v.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    let layers = v
        .get("layers")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(token, l)| {
                    (
                        token.clone(),
                        LibraryLayer {
                            refs: strings(l.get("refs")),
                            description: opt_string(l, "description"),
                        },
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let generators = v
        .get("generators")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|g| Some((opt_string(g, "name")?, opt_string(g, "anchor"))))
                .collect()
        })
        .unwrap_or_default();
    LibraryManifest {
        name: opt_string(&v, "name").unwrap_or_default(),
        kind: opt_string(&v, "kind"),
        stability: opt_string(&v, "stability"),
        since: opt_string(&v, "since"),
        description: opt_string(&v, "description"),
        use_when: opt_string(&v, "useWhen"),
        packages: strings(v.get("packages")),
        layers,
        generators,
        runtime: v.get("runtime").cloned().unwrap_or(Value::Null),
    }
}

/// Every shipped library's parsed manifest, keyed by the library's directory name.
pub fn library_manifests() -> &'static BTreeMap<String, LibraryManifest> {
    static MANIFESTS: OnceLock<BTreeMap<String, LibraryManifest>> = OnceLock::new();
    MANIFESTS.get_or_init(|| {
        embedded::EMBEDDED_LIBRARY_MANIFESTS
            .iter()
            .map(|(name, text)| ((*name).to_string(), parse_manifest(text)))
            .collect()
    })
}

/// Split a selection token into `(library, layer)`: `"iam"` is `("iam", "")`,
/// `"iam/db"` is `("iam", "db")`. Only the first separator is meaningful.
pub fn split_layer_token(token: &str) -> (&str, &str) {
    token.split_once('/').unwrap_or((token, ""))
}

/// The library names this build ships, sorted.
pub fn known_library_packages() -> Vec<String> {
    library_manifests().keys().cloned().collect()
}

/// Every package name a shipped library owns, across every library and layer.
pub fn library_packages() -> HashSet<String> {
    library_manifests()
        .values()
        .flat_map(|m| m.packages.iter().cloned())
        .collect()
}

/// Every selection token this build accepts, sorted: `["ai", "ai/db", "iam", "iam/db"]`.
pub fn known_library_tokens() -> Vec<String> {
    let mut out = Vec::new();
    for (name, m) in library_manifests() {
        if m.layers.is_empty() {
            out.push(name.clone());
        }
        for (token, _) in &m.layers {
            out.push(if token.is_empty() {
                name.clone()
            } else {
                format!("{name}/{token}")
            });
        }
    }
    out.sort();
    out
}

/// The source id a library file loads under: `library:iam/model.yaml`.
pub fn library_file_id(r: &str) -> String {
    format!("{LIBRARY_FILE_ID_PREFIX}{r}.yaml")
}

/// True when a source id names a file a shipped library contributed.
pub fn is_library_file_id(id: &str) -> bool {
    id.starts_with(LIBRARY_FILE_ID_PREFIX)
}

/// The text of one library ref (`iam/model`), when this build embeds it.
pub fn library_ref_text(r: &str) -> Option<&'static str> {
    embedded::EMBEDDED_LIBRARY
        .iter()
        .find(|(k, _)| *k == r)
        .map(|(_, t)| *t)
}

/// Every ref one library contributes, core layer first, de-duplicated.
pub fn library_refs(name: &str) -> Vec<String> {
    let Some(m) = library_manifests().get(name) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let core = m.layer("").into_iter().map(|l| ("", l));
    let rest = m
        .layers
        .iter()
        .filter(|(t, _)| !t.is_empty())
        .map(|(t, l)| (t.as_str(), l));
    for (_, layer) in core.chain(rest) {
        for r in &layer.refs {
            if seen.insert(r.clone()) {
                out.push(r.clone());
            }
        }
    }
    out
}

/// The tokens of `selection` this build does not ship (an unknown library or an
/// unknown layer of a known one), in selection order.
pub fn unknown_library_tokens(selection: &[String]) -> Vec<String> {
    let known = known_library_tokens();
    selection
        .iter()
        .filter(|t| !known.contains(t))
        .cloned()
        .collect()
}

/// The refs a selection names, in load order. A layer token implies its core; a
/// token whose library or layer is unknown contributes nothing, not even a core.
pub fn library_selection_refs(selection: &[String]) -> Vec<String> {
    let manifests = library_manifests();
    let wanted: Vec<(&LibraryManifest, &str)> = selection
        .iter()
        .map(|t| split_layer_token(t))
        .filter_map(|(lib, layer)| {
            let m = manifests.get(lib)?;
            m.layer(layer)?;
            Some((m, layer))
        })
        .collect();
    let mut seen = HashSet::new();
    let mut refs = Vec::new();
    let mut add = |r: &String| {
        if seen.insert(r.clone()) {
            refs.push(r.clone());
        }
    };
    // Core layers first, across every requested library, so a db layer named
    // before its core still loads after it.
    for (m, _) in &wanted {
        if let Some(core) = m.layer("") {
            core.refs.iter().for_each(&mut add);
        }
    }
    for (m, layer) in &wanted {
        if !layer.is_empty()
            && let Some(l) = m.layer(layer)
        {
            l.refs.iter().for_each(&mut add);
        }
    }
    refs
}

/// `(source id, YAML text)` for the requested library selection, ordered as the
/// TypeScript port orders them: every core layer, then each requested layer.
/// An unrecognised token is skipped silently; the config reader refuses a token
/// a human typed (see [`unknown_library_tokens`]).
pub fn library_sources(selection: &[String]) -> Vec<(String, String)> {
    library_selection_refs(selection)
        .into_iter()
        .filter_map(|r| {
            let text = library_ref_text(&r)?;
            Some((library_file_id(&r), text.to_owned()))
        })
        .collect()
}
