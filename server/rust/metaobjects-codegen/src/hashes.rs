//! The hash manifest: `.metaobjects/.gen-state/.hashes.json`, one SHA-256 per generated
//! path (ADR-0064 decision 1).
//!
//! The file is committed. It is the only thing that lets a machine that did not generate
//! the output tell "this is exactly what I wrote" from "somebody edited this". Every port
//! writes the same shape: keys are paths relative to the project root, sorted, two-space
//! indentation, a trailing newline; a value is the hex digest, or an object carrying a
//! `hash` field (owner fields other tools keep there are preserved).
//!
//! The manifest is read once at the start of a run, updated in memory, and saved once at
//! the end, and only when an entry was added, changed or removed. A run that changes nothing
//! leaves the file, and its timestamp, alone.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::sha256::sha256_hex;

/// The manifest's file name inside the gen-state directory.
pub const HASHES_FILE: &str = ".hashes.json";

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

/// The manifest as one in-memory session.
#[derive(Debug)]
pub struct HashManifest {
    path: PathBuf,
    entries: Map<String, Value>,
    existed: bool,
    dirty: bool,
}

impl HashManifest {
    /// Read the manifest in `gen_state_dir`. A missing file is an empty manifest; an
    /// unreadable or corrupt one reads as empty too, which fails closed: every existing
    /// generated file is then refused rather than assumed ours.
    pub fn load(gen_state_dir: &Path) -> Self {
        let path = gen_state_dir.join(HASHES_FILE);
        let text = std::fs::read_to_string(&path).ok();
        let parsed = text
            .as_deref()
            .and_then(|t| serde_json::from_str::<Value>(t).ok());
        let corrupt = text.is_some() && !matches!(parsed, Some(Value::Object(_)));
        let entries = match parsed {
            Some(Value::Object(map)) => map,
            _ => Map::new(),
        };
        // A corrupt file is present but unusable: the next save replaces it.
        let existed = text.is_some();
        let dirty = corrupt;
        Self {
            path,
            entries,
            existed,
            dirty,
        }
    }

    /// Whether the project had a manifest file at all.
    pub fn existed(&self) -> bool {
        self.existed
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
            self.dirty = true;
        }
    }

    /// Whether the in-memory manifest differs from what was loaded.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// The manifest's text: keys sorted, two-space indent, trailing newline.
    pub fn to_text(&self) -> String {
        let mut keys: Vec<&String> = self.entries.keys().collect();
        keys.sort();
        let mut sorted = Map::new();
        for k in keys {
            sorted.insert(k.clone(), self.entries[k].clone());
        }
        let mut text = serde_json::to_string_pretty(&Value::Object(sorted))
            .expect("a map of strings serializes");
        text.push('\n');
        text
    }

    /// Write the manifest once, and only when an entry changed. Returns whether it wrote.
    pub fn save(&mut self) -> std::io::Result<bool> {
        if !self.dirty {
            return Ok(false);
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.path, self.to_text())?;
        self.dirty = false;
        self.existed = true;
        Ok(true)
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

    #[test]
    fn saves_sorted_with_a_trailing_newline_and_only_when_dirty() {
        let dir = scratch("save");
        let mut m = HashManifest::load(&dir);
        assert!(!m.existed());
        m.record("b/two.rs", "22");
        m.record("a/one.rs", "11");
        assert!(m.save().unwrap());
        let text = std::fs::read_to_string(dir.join(HASHES_FILE)).unwrap();
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
        let text = std::fs::read_to_string(dir.join(HASHES_FILE)).unwrap();
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
        assert_eq!(
            std::fs::read_to_string(dir.join(HASHES_FILE)).unwrap(),
            "{}\n"
        );
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
