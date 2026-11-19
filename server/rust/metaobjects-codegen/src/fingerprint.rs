//! The whole-run skip key (ADR-0064 section 3).
//!
//! `gen` loads the metadata, then computes ONE key from every input that can change what it
//! writes, and compares it with the one the last successful run stored in
//! `.metaobjects/.gen-state/.fingerprint-rust.json`. A match, with every file the manifest
//! records still on disk with the bytes that run left, skips the run: nothing renders and
//! nothing is written, the manifest and the stored key included.
//!
//! The key may be wrong only in the safe direction: an input it over-counts causes an extra
//! render; an input it misses would cause a wrong skip, so anything in doubt is counted.
//! Timestamps are never an input.
//!
//! The key is built from small named entries ([`InputEntry`]: a kind, a name and a content
//! hash) folded into one digest by [`fold`], so a later per-object key can reuse the same
//! entries for a subset of the inputs. Its bytes are internal to this port and are never
//! compared with another port's.

use std::collections::BTreeMap;
use std::path::Path;

use metaobjects::node::{NodeId, Tree};
use metaobjects::serializer::to_canonical_value;
use serde_json::{Map, Value};

use crate::hashes::HashManifest;
use crate::sha256::{Sha256, hex, sha256_hex};

/// Bump when the key's own recipe changes: every stored key then misses.
pub const FINGERPRINT_FORMAT: u64 = 1;

/// Where this port keeps its key, beside the (committed) manifest and never committed
/// itself (`.gen-state/*` is ignored except `.hashes.json`).
pub const FINGERPRINT_FILE: &str = ".fingerprint-rust.json";

/// The hash of an input that does not exist. A file that appears or disappears changes it.
pub const ABSENT: &str = "absent";

pub const KIND_TOOL: &str = "tool";
pub const KIND_ENGINE: &str = "engine";
pub const KIND_CONFIG: &str = "config";
pub const KIND_MODEL: &str = "model";
pub const KIND_FLAG: &str = "flag";
pub const KIND_GENERATOR: &str = "generator";
pub const KIND_EXTRA: &str = "extra";

/// One named input of the run: what kind it is, its name, and its content hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputEntry {
    pub kind: &'static str,
    pub name: String,
    pub sha256: String,
}

impl InputEntry {
    pub fn new(kind: &'static str, name: impl Into<String>, sha256: impl Into<String>) -> Self {
        Self {
            kind,
            name: name.into(),
            sha256: sha256.into(),
        }
    }
}

/// The one key: a SHA-256 over the sorted entries. Order of arrival is irrelevant.
pub fn fold(entries: &[InputEntry]) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .map(|e| format!("{}\0{}\0{}", e.kind, e.name, e.sha256))
        .collect();
    lines.sort();
    sha256_hex(lines.join("\n").as_bytes())
}

/// The SHA-256 of a file's bytes, or [`ABSENT`]. Timestamps are never read.
pub fn hash_file(path: &Path) -> String {
    match std::fs::read(path) {
        Ok(bytes) => sha256_hex(&bytes),
        Err(_) => ABSENT.to_string(),
    }
}

/// One hash over every file under `root` (relative path and content), or over the file
/// itself, or [`ABSENT`]. Adding, removing, renaming or editing any file changes it.
pub fn hash_tree(root: &Path) -> String {
    if !root.exists() {
        return ABSENT.to_string();
    }
    if root.is_file() {
        return hash_file(root);
    }
    fn walk(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = read.filter_map(Result::ok).map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    let mut files = Vec::new();
    walk(root, &mut files);
    let mut h = Sha256::new();
    for f in files {
        let rel = f.strip_prefix(root).unwrap_or(&f);
        h.update(rel.to_string_lossy().replace('\\', "/").as_bytes());
        h.update(&[0]);
        h.update(hash_file(&f).as_bytes());
        h.update(b"\n");
    }
    hex(&h.finish())
}

/// The model half of the key: a hash tree over the LOADED root.
///
/// Each root-level node (an object, a shared field, a template node) is hashed in its
/// canonical EFFECTIVE form (`extends` and overlays applied, attributes in fixed order, no
/// source positions). Node hashes roll up into one hash per package and one for the model.
/// Nothing here reads a metadata source file, so a file that is reformatted, reordered or
/// split in two without changing what loads does not change the key, and an edit to an
/// abstract parent changes the key of every node that inherits from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelTree {
    /// Resolution key to the hash of the node's canonical effective form.
    pub nodes: BTreeMap<String, String>,
    /// Package to the hash over its sorted `resolution-key:node-hash` lines.
    pub packages: BTreeMap<String, String>,
    /// The hash over the sorted `package:package-hash` lines.
    pub model: String,
}

fn node_hash(tree: &Tree, id: NodeId) -> String {
    let mut value = to_canonical_value(tree, id, true);
    // The RESOLVED package is part of the node's resolution key, so the node's own
    // `package` attribute is dropped: moving a node to another file of the same package
    // (which may or may not restate it) does not change the hash.
    if let Value::Object(top) = &mut value {
        for body in top.values_mut() {
            if let Value::Object(b) = body {
                b.shift_remove("package");
            }
        }
    }
    sha256_hex(value.to_string().as_bytes())
}

/// Build the hash tree of the loaded root.
pub fn build_model_tree(tree: &Tree, root: NodeId) -> ModelTree {
    // ADR-0039 sanctioned own: a top-level scan of the loader ROOT (`metadata.root` is never
    // extended, so own == effective).
    let mut nodes = BTreeMap::new();
    let mut by_package: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for &child in tree.own_children(root) {
        let key = tree.resolution_key(child);
        let digest = node_hash(tree, child);
        by_package
            .entry(tree.effective_package(child))
            .or_default()
            .push(format!("{key}:{digest}"));
        nodes.insert(key, digest);
    }
    let mut packages = BTreeMap::new();
    for (pkg, mut lines) in by_package {
        lines.sort();
        packages.insert(pkg, sha256_hex(lines.join("\n").as_bytes()));
    }
    let model_lines: Vec<String> = packages.iter().map(|(p, h)| format!("{p}:{h}")).collect();
    let model = sha256_hex(model_lines.join("\n").as_bytes());
    ModelTree {
        nodes,
        packages,
        model,
    }
}

/// The key a previous successful run stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFingerprint {
    pub key: String,
    /// Every manifest-recorded path (project-relative, as the manifest keys it) mapped to
    /// the SHA-256 of the bytes on disk when the run finished.
    pub outputs: BTreeMap<String, String>,
}

pub fn fingerprint_path(gen_state_dir: &Path) -> std::path::PathBuf {
    gen_state_dir.join(FINGERPRINT_FILE)
}

/// Read the stored key; anything unreadable or of another format is no key.
pub fn read_stored(gen_state_dir: &Path) -> Option<StoredFingerprint> {
    let text = std::fs::read_to_string(fingerprint_path(gen_state_dir)).ok()?;
    let raw: Value = serde_json::from_str(&text).ok()?;
    let obj = raw.as_object()?;
    if obj.get("format")?.as_u64()? != FINGERPRINT_FORMAT {
        return None;
    }
    let key = obj.get("fingerprint")?.as_str()?.to_string();
    let mut outputs = BTreeMap::new();
    for (k, v) in obj.get("outputs")?.as_object()? {
        outputs.insert(k.clone(), v.as_str()?.to_string());
    }
    Some(StoredFingerprint { key, outputs })
}

/// Store the key of a run that succeeded with every generator cacheable.
pub fn write_stored(
    gen_state_dir: &Path,
    key: &str,
    outputs: &BTreeMap<String, String>,
) -> std::io::Result<()> {
    std::fs::create_dir_all(gen_state_dir)?;
    let mut out = Map::new();
    out.insert("format".into(), Value::from(FINGERPRINT_FORMAT));
    out.insert("fingerprint".into(), Value::from(key));
    out.insert("extras".into(), Value::Array(Vec::new()));
    out.insert(
        "outputs".into(),
        Value::Object(
            outputs
                .iter()
                .map(|(k, v)| (k.clone(), Value::from(v.clone())))
                .collect(),
        ),
    );
    out.insert("untracked".into(), Value::Array(Vec::new()));
    let mut text =
        serde_json::to_string_pretty(&Value::Object(out)).expect("a plain map serializes");
    text.push('\n');
    std::fs::write(fingerprint_path(gen_state_dir), text)
}

/// Delete the stored key (a run does this before it writes anything).
pub fn delete_stored(gen_state_dir: &Path) {
    let _ = std::fs::remove_file(fingerprint_path(gen_state_dir));
}

/// Every manifest-recorded path mapped to the SHA-256 of the bytes on disk now, or `None`
/// when any recorded file is missing (a skip then never matches).
pub fn output_hashes(
    manifest: &HashManifest,
    project_root: &Path,
) -> Option<BTreeMap<String, String>> {
    let mut hashes = BTreeMap::new();
    for (key, _) in manifest.records() {
        let bytes = std::fs::read(project_root.join(key)).ok()?;
        hashes.insert(key.to_string(), sha256_hex(&bytes));
    }
    Some(hashes)
}
