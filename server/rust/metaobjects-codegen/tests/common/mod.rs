//! Shared scaffolding for the integration tests: scratch projects and the small model the
//! golden and compile tests both use.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// A throwaway project directory under `$DEV_SCRATCH` (a RAM disk), removed on drop.
pub struct Scratch(pub PathBuf);

impl Scratch {
    pub fn new(tag: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "mo-codegen-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }

    /// A project holding the given `(path, text)` files, with an empty `.metaobjects/config.json`
    /// when the files do not bring their own.
    pub fn project(tag: &str, files: &[(&str, &str)]) -> Self {
        let s = Self::new(tag);
        if !files.iter().any(|(p, _)| *p == ".metaobjects/config.json") {
            s.write(".metaobjects/config.json", r#"{ "schema_version": 1 }"#);
        }
        for (path, text) in files {
            s.write(path, text);
        }
        s
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn write(&self, rel: &str, text: &str) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    pub fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.0.join(rel)).unwrap()
    }

    pub fn exists(&self, rel: &str) -> bool {
        self.0.join(rel).exists()
    }

    pub fn mtime(&self, rel: &str) -> std::time::SystemTime {
        std::fs::metadata(self.0.join(rel))
            .unwrap()
            .modified()
            .unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The `shop` package: an abstract base, a shared enum, a value object, an entity that
/// uses all of them (inherited fields, inline and shared enums, optional and array fields,
/// a map, a keyword field name), and a self-referencing entity (which must be boxed).
pub const SHOP: &str = r#"{ "metadata.root": { "package": "shop", "children": [
  { "field.enum": { "name": "Currency", "abstract": true,
      "@description": "A currency the shop trades in.",
      "@values": ["usd", "EUR", "gbp_pound"] } },
  { "object.value": { "name": "Address", "@description": "Where a parcel goes.", "children": [
    { "field.string": { "name": "street", "@required": true } },
    { "field.string": { "name": "zipCode" } }
  ] } },
  { "object.entity": { "name": "Base", "abstract": true, "children": [
    { "field.long": { "name": "id" } },
    { "field.timestamp": { "name": "createdAt", "@required": true } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } }
  ] } },
  { "object.entity": { "name": "Order", "extends": "Base", "@description": "One purchase.\nSecond line.", "children": [
    { "field.enum": { "name": "status", "@required": true, "@description": "Where the order is.",
        "@values": ["NEW", "IN_FLIGHT", "done"] } },
    { "field.enum": { "name": "currency", "extends": "Currency", "@required": true } },
    { "field.currency": { "name": "total", "@required": true, "@currency": "USD" } },
    { "field.decimal": { "name": "taxRate" } },
    { "field.string": { "name": "type" } },
    { "field.string": { "name": "tags", "isArray": true } },
    { "field.map": { "name": "attributes", "@valueType": "string" } },
    { "field.object": { "name": "shipTo", "@required": true, "@objectRef": "Address" } },
    { "field.object": { "name": "billTo", "@objectRef": "Address" } },
    { "field.object": { "name": "history", "isArray": true, "@objectRef": "Address" } }
  ] } },
  { "object.entity": { "name": "Category", "extends": "Base", "children": [
    { "field.string": { "name": "title", "@required": true } },
    { "field.object": { "name": "parent", "@objectRef": "Category" } },
    { "field.object": { "name": "subcategories", "isArray": true, "@objectRef": "Category" } }
  ] } }
] } }"#;

/// A second package whose entity refers to `shop`, so its crate depends on the `shop` crate.
pub const BILLING: &str = r#"{ "metadata.root": { "package": "shop::billing", "children": [
  { "object.entity": { "name": "Invoice", "children": [
    { "field.long": { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } },
    { "field.object": { "name": "order", "@required": true, "@objectRef": "shop::Order" } },
    { "field.enum": { "name": "currency", "extends": "shop::Currency" } }
  ] } }
] } }"#;

/// The two-package model as project files.
pub fn shop_files() -> Vec<(&'static str, &'static str)> {
    vec![
        ("metaobjects/meta.shop.json", SHOP),
        ("metaobjects/meta.billing.json", BILLING),
    ]
}

/// The shared public fitness model every port's conformance corpora use.
pub const FITNESS: &str =
    include_str!("../../../../../fixtures/persistence-conformance/canonical/meta.fitness.json");
