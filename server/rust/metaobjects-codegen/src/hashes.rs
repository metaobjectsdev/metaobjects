//! The hash manifest: one SHA-256 per generated path (ADR-0064 decision 1), kept as one
//! file per model package under `.metaobjects/.gen-state/.hashes/` (ADR-0064 Amendment 1).
//!
//! The files are committed. They are the only thing that lets a machine that did not
//! generate the output tell "this is exactly what I wrote" from "somebody edited this".
//! Every port writes the same shape: keys are paths relative to the project root, sorted,
//! two-space indentation, a trailing newline; a value is the hex digest, or an object
//! carrying a `hash` field (owner fields other tools keep there are preserved).
//!
//! In memory the manifest is one flat map. A reader gets the union of every file in
//! `.hashes/` over the legacy `.metaobjects/.gen-state/.hashes.json`; a writer files each
//! entry by [`place`] (a pure function of the entry and the loaded model) and writes only
//! the files whose bytes changed. A run that finds the legacy file migrates it on its next
//! save; a read-only command never saves.
//!
//! The manifest is read once at the start of a run, updated in memory, and saved once at
//! the end, and only when an entry was added, changed or removed. A run that changes nothing
//! leaves every file, and its timestamp, alone.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::sha256::sha256_hex;

/// The legacy single manifest's file name inside the gen-state directory.
pub const HASHES_FILE: &str = ".hashes.json";
/// The directory of per-package manifests inside the gen-state directory.
pub const HASHES_DIR: &str = ".hashes";
/// The manifest of the paths that belong to no package.
pub const ROOT_FILE: &str = ".root.json";

const PACKAGE_SEP: &str = "::";
const GITIGNORE_RULE: &str = ".gen-state/*";
const GITIGNORE_LEGACY: &str = "!.gen-state/.hashes.json";
const GITIGNORE_DIR: &str = "!.gen-state/.hashes/";

/// The hex SHA-256 of generated text: the function that produces every manifest value.
pub fn content_hash(content: &str) -> String {
    sha256_hex(content.as_bytes())
}

fn entry_hash(value: &Value) -> Option<&str> {
    match value {
        Value::String(s) => Some(s),
        Value::Object(o) => o.get("hash").and_then(Value::as_str),
        _ => None,
    }
}

/// The file name of a package's manifest: its `::` segments joined with `.`, each byte
/// outside `[A-Za-z0-9_-]` written as `%XX`, then `.json`. `None` is the root manifest.
pub fn package_file_name(package: Option<&str>) -> String {
    let Some(package) = package else {
        return ROOT_FILE.to_string();
    };
    let segments: Vec<String> = package
        .split(PACKAGE_SEP)
        .map(|seg| {
            let mut out = String::new();
            for b in seg.bytes() {
                if b.is_ascii_alphanumeric() || b == b'_' || b == b'-' {
                    out.push(b as char);
                } else {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
            out
        })
        .collect();
    format!("{}.json", segments.join("."))
}

/// The package a recorded path files under, or `None` for the root manifest: the entry's
/// `sourceNode` first, then the longest root-level object name the file's stem begins with.
/// `objects` are the loaded model's root-level objects as `(name, package)`.
pub fn place(path: &str, entry: &Value, objects: &[(String, String)]) -> Option<String> {
    if let Some(node) = entry
        .as_object()
        .and_then(|o| o.get("sourceNode"))
        .and_then(Value::as_str)
    {
        let object = node.split('.').next().unwrap_or(node);
        return object
            .rsplit_once(PACKAGE_SEP)
            .map(|(pkg, _)| pkg.to_string())
            .filter(|p| !p.is_empty());
    }
    let base = path.rsplit('/').next().unwrap_or(path);
    let stem = words(base.split('.').next().unwrap_or(base));
    let mut best: Vec<&str> = Vec::new(); // packages of the matches with the most words
    let mut best_len = 0;
    for (name, package) in objects {
        let w = words(name);
        if w.is_empty() || w.len() > stem.len() || stem[..w.len()] != w[..] {
            continue;
        }
        if w.len() > best_len {
            best_len = w.len();
            best.clear();
        }
        if w.len() == best_len {
            best.push(package);
        }
    }
    best.sort_unstable();
    best.dedup();
    match best.as_slice() {
        [p] if !p.is_empty() => Some((*p).to_string()),
        _ => None,
    }
}

/// Split a name or file stem into lowercase words: at `_` and `-`, before an uppercase
/// letter that follows a lowercase letter or digit, and before the last uppercase of a run
/// that a lowercase letter follows (`HTTPServer` is `http`, `server`).
fn words(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c == '_' || c == '-' {
            out.push(std::mem::take(&mut cur));
            continue;
        }
        if c.is_uppercase() && i > 0 {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            if prev.is_lowercase() || prev.is_ascii_digit() || (prev.is_uppercase() && next_lower) {
                out.push(std::mem::take(&mut cur));
            }
        }
        cur.extend(c.to_lowercase());
    }
    out.push(cur);
    out.retain(|w| !w.is_empty());
    out
}

/// `.gitignore` text with the legacy `!.gen-state/.hashes.json` line replaced by
/// `!.gen-state/.hashes/` (or the new line inserted after `.gen-state/*` when there is no
/// legacy line), or `None` when nothing needs to change (no `.gen-state/*` rule, or neither
/// the legacy line nor a missing new line).
pub fn migrate_gitignore(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    if !lines.iter().any(|l| l.trim() == GITIGNORE_RULE) {
        return None;
    }
    let has_dir = lines.iter().any(|l| l.trim() == GITIGNORE_DIR);
    let has_legacy = lines.iter().any(|l| l.trim() == GITIGNORE_LEGACY);
    if has_dir && !has_legacy {
        return None;
    }
    let mut out = String::new();
    let mut added = has_dir;
    for l in &lines {
        let t = l.trim();
        if t == GITIGNORE_LEGACY || (!added && !has_legacy && t == GITIGNORE_RULE) {
            if t == GITIGNORE_RULE {
                out.push_str(l);
                out.push('\n');
            }
            if !added {
                out.push_str(GITIGNORE_DIR);
                out.push('\n');
                added = true;
            }
            continue;
        }
        out.push_str(l);
        out.push('\n');
    }
    Some(out)
}

fn read_object(path: &Path) -> (Option<Map<String, Value>>, bool) {
    // (entries, present-but-unusable)
    match std::fs::read_to_string(path) {
        Err(_) => (None, path.exists()),
        Ok(t) => match serde_json::from_str::<Value>(&t) {
            Ok(Value::Object(m)) => (Some(m), false),
            _ => (None, true),
        },
    }
}

fn manifest_text(entries: &Map<String, Value>) -> String {
    let mut keys: Vec<&String> = entries.keys().collect();
    keys.sort();
    let mut sorted = Map::new();
    for k in keys {
        sorted.insert(k.clone(), entries[k].clone());
    }
    let mut text =
        serde_json::to_string_pretty(&Value::Object(sorted)).expect("a map of strings serializes");
    text.push('\n');
    text
}

/// The manifest as one in-memory session.
#[derive(Debug)]
pub struct HashManifest {
    dir: PathBuf,
    entries: Map<String, Value>,
    /// The manifest file each entry was read from (absent for the legacy file and for new
    /// entries): where a writer with no model leaves it.
    origin: HashMap<String, String>,
    /// The loaded model's root-level objects, `(name, package)`, once the runner has them.
    objects: Option<Vec<(String, String)>>,
    existed: bool,
    legacy: bool,
    dirty: bool,
}

impl HashManifest {
    /// Read the manifest of `gen_state_dir`: the union of `.hashes/*.json` over the legacy
    /// `.hashes.json`. A missing file is an empty manifest; an unreadable or corrupt one
    /// reads as empty too, which fails closed: every existing generated file is then
    /// refused rather than assumed ours.
    pub fn load(gen_state_dir: &Path) -> Self {
        let mut entries = Map::new();
        let mut origin = HashMap::new();
        let mut existed = false;
        let mut dirty = false;

        let legacy_path = gen_state_dir.join(HASHES_FILE);
        let legacy = legacy_path.exists();
        if legacy {
            existed = true;
            let (map, bad) = read_object(&legacy_path);
            dirty |= bad;
            entries = map.unwrap_or_default();
        }

        let dir = gen_state_dir.join(HASHES_DIR);
        for name in Self::files_in(&dir) {
            existed = true;
            let (map, bad) = read_object(&dir.join(&name));
            // A corrupt file is present but unusable: the next save replaces it.
            dirty |= bad;
            for (k, v) in map.unwrap_or_default() {
                origin.insert(k.clone(), name.clone());
                entries.insert(k, v);
            }
        }
        Self {
            dir,
            entries,
            origin,
            objects: None,
            existed,
            legacy,
            dirty,
        }
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().is_file())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        names
    }

    /// Hand the manifest the loaded model's root-level objects (`(name, package)`), so a
    /// save files each entry by [`place`] instead of leaving it where it was read.
    pub fn set_objects(&mut self, objects: Vec<(String, String)>) {
        self.objects = Some(objects);
    }

    /// Whether the project had a manifest at all (the legacy file or a per-package one).
    pub fn existed(&self) -> bool {
        self.existed
    }

    /// Whether the manifest was read from the legacy single file, which the next save
    /// migrates.
    pub fn is_legacy(&self) -> bool {
        self.legacy
    }

    /// The recorded hash for `key` (a project-relative path), if any.
    pub fn hash_of(&self, key: &str) -> Option<&str> {
        self.entries.get(key).and_then(entry_hash)
    }

    /// Every recorded key with its hash, in key order.
    pub fn records(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .filter_map(|(k, v)| Some((k.as_str(), entry_hash(v)?)))
    }

    /// Record `hash` for `key`. A no-op, leaving the manifest clean, when it is already
    /// recorded.
    pub fn record(&mut self, key: &str, hash: &str) {
        if self.hash_of(key) == Some(hash) {
            return;
        }
        match self.entries.get_mut(key) {
            Some(Value::Object(o)) => {
                o.insert("hash".into(), Value::String(hash.into()));
            }
            _ => {
                self.entries.insert(key.into(), Value::String(hash.into()));
            }
        }
        self.dirty = true;
    }

    /// Drop the record for `key`.
    pub fn remove(&mut self, key: &str) {
        if self.entries.shift_remove(key).is_some() {
            self.origin.remove(key);
            self.dirty = true;
        }
    }

    /// Whether the in-memory manifest differs from what was loaded (a legacy manifest
    /// counts: it is always migrated).
    pub fn is_dirty(&self) -> bool {
        self.dirty || self.legacy
    }

    fn file_of(&self, key: &str, value: &Value) -> String {
        match &self.objects {
            Some(objects) => package_file_name(place(key, value, objects).as_deref()),
            None => self
                .origin
                .get(key)
                .cloned()
                .unwrap_or_else(|| ROOT_FILE.to_string()),
        }
    }

    /// Every manifest file's text, by file name, as a save would write them.
    pub fn to_files(&self) -> BTreeMap<String, String> {
        let mut groups: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
        for (k, v) in &self.entries {
            groups
                .entry(self.file_of(k, v))
                .or_default()
                .insert(k.clone(), v.clone());
        }
        // With no entry at all the root manifest stays (as `{}`), so "no manifest" is
        // distinguishable from "empty"; otherwise it exists only when it holds an entry.
        if groups.is_empty() {
            groups.insert(ROOT_FILE.to_string(), Map::new());
        }
        groups
            .into_iter()
            .map(|(name, m)| (name, manifest_text(&m)))
            .collect()
    }

    /// Write the manifest, once, and only the files whose bytes changed; delete a package
    /// file that holds no entry; migrate the legacy file. Returns whether it wrote anything.
    pub fn save(&mut self) -> std::io::Result<bool> {
        if !self.is_dirty() {
            return Ok(false);
        }
        let files = self.to_files();
        std::fs::create_dir_all(&self.dir)?;
        let mut wrote = false;
        for (name, text) in &files {
            let path = self.dir.join(name);
            if std::fs::read_to_string(&path).ok().as_deref() != Some(text.as_str()) {
                std::fs::write(&path, text)?;
                wrote = true;
            }
        }
        for name in Self::files_in(&self.dir) {
            if !files.contains_key(&name) {
                std::fs::remove_file(self.dir.join(&name))?;
                wrote = true;
            }
        }
        if self.legacy {
            let gen_state = self.dir.parent().unwrap_or(Path::new("."));
            std::fs::remove_file(gen_state.join(HASHES_FILE))?;
            if let Some(parent) = gen_state.parent() {
                let ignore = parent.join(".gitignore");
                if let Some(next) = std::fs::read_to_string(&ignore)
                    .ok()
                    .and_then(|t| migrate_gitignore(&t))
                {
                    std::fs::write(&ignore, next)?;
                }
            }
            self.legacy = false;
            wrote = true;
        }
        self.origin = self
            .entries
            .iter()
            .map(|(k, v)| (k.clone(), self.file_of(k, v)))
            .collect();
        self.dirty = false;
        self.existed = true;
        Ok(wrote)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("mo-hashes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn root_file(dir: &Path) -> PathBuf {
        dir.join(HASHES_DIR).join(ROOT_FILE)
    }

    #[test]
    fn saves_sorted_with_a_trailing_newline_and_only_when_dirty() {
        let dir = scratch("save");
        let mut m = HashManifest::load(&dir);
        assert!(!m.existed());
        m.record("b/two.rs", "22");
        m.record("a/one.rs", "11");
        assert!(m.save().unwrap());
        let text = std::fs::read_to_string(root_file(&dir)).unwrap();
        assert_eq!(
            text,
            "{\n  \"a/one.rs\": \"11\",\n  \"b/two.rs\": \"22\"\n}\n"
        );

        let mut again = HashManifest::load(&dir);
        again.record("a/one.rs", "11");
        assert!(!again.is_dirty());
        assert!(
            !again.save().unwrap(),
            "an unchanged manifest is not rewritten"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_owner_fields_of_object_entries() {
        let dir = scratch("owner");
        std::fs::write(
            dir.join(HASHES_FILE),
            "{\n  \"x.rs\": { \"hash\": \"old\", \"generator\": \"entity\" }\n}\n",
        )
        .unwrap();
        let mut m = HashManifest::load(&dir);
        assert_eq!(m.hash_of("x.rs"), Some("old"));
        m.record("x.rs", "new");
        m.save().unwrap();
        assert!(
            !dir.join(HASHES_FILE).exists(),
            "the legacy file is migrated"
        );
        let text = std::fs::read_to_string(root_file(&dir)).unwrap();
        assert!(text.contains("\"generator\": \"entity\""), "{text}");
        assert!(text.contains("\"hash\": \"new\""), "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_manifest_reads_empty_and_is_replaced_on_save() {
        let dir = scratch("corrupt");
        std::fs::write(dir.join(HASHES_FILE), "not json").unwrap();
        let mut m = HashManifest::load(&dir);
        assert!(m.existed());
        assert_eq!(m.records().count(), 0);
        assert!(m.is_dirty());
        assert!(m.save().unwrap());
        assert_eq!(std::fs::read_to_string(root_file(&dir)).unwrap(), "{}\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn removing_a_record_marks_the_manifest_dirty() {
        let dir = scratch("remove");
        let mut m = HashManifest::load(&dir);
        m.record("x.rs", "1");
        m.save().unwrap();
        let mut m = HashManifest::load(&dir);
        m.remove("missing");
        assert!(!m.is_dirty());
        m.remove("x.rs");
        assert!(m.is_dirty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
