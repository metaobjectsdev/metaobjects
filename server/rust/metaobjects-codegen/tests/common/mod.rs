//! Shared scaffolding for the integration tests: scratch projects and the small model the
//! golden and compile tests both use.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use metaobjects_codegen::{RunOptions, run, shipped_generators};

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
/// `Order` and `Category` are stored, so they are served: filters and sorts on some fields,
/// and a many-to-many relationship between them through `OrderCategory`.
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
    { "field.timestamp": { "name": "createdAt", "@required": true, "@filterable": true, "@sortable": true } },
    { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
  ] } },
  { "object.entity": { "name": "Order", "extends": "Base", "@description": "One purchase.\nSecond line.", "children": [
    { "source.rdb": { "@table": "orders" } },
    { "field.enum": { "name": "status", "@required": true, "@description": "Where the order is.",
        "@filterable": true, "@sortable": true, "@values": ["NEW", "IN_FLIGHT", "done"] } },
    { "field.enum": { "name": "currency", "extends": "Currency", "@required": true } },
    { "field.currency": { "name": "total", "@required": true, "@currency": "USD", "@filterable": true, "@sortable": true } },
    { "field.decimal": { "name": "taxRate", "@filterable": true } },
    { "field.string": { "name": "type", "@filterable": true } },
    { "field.string": { "name": "tags", "isArray": true } },
    { "field.map": { "name": "attributes", "@valueType": "string" } },
    { "field.object": { "name": "shipTo", "@required": true, "@objectRef": "Address" } },
    { "field.object": { "name": "billTo", "@objectRef": "Address" } },
    { "field.object": { "name": "history", "isArray": true, "@objectRef": "Address" } },
    { "relationship.association": { "name": "categories", "@cardinality": "many", "@objectRef": "Category",
        "@through": "OrderCategory" } }
  ] } },
  { "object.entity": { "name": "OrderCategory", "children": [
    { "source.rdb": { "@table": "order_categories" } },
    { "field.long": { "name": "orderId", "@required": true } },
    { "field.long": { "name": "categoryId", "@required": true } },
    { "identity.primary": { "name": "pk", "@fields": ["orderId", "categoryId"] } },
    { "identity.reference": { "name": "fkOrder", "@fields": "orderId", "@references": "Order" } },
    { "identity.reference": { "name": "fkCategory", "@fields": "categoryId", "@references": "Category" } }
  ] } },
  { "object.entity": { "name": "Category", "extends": "Base", "children": [
    { "source.rdb": { "@table": "categories" } },
    { "field.string": { "name": "title", "@required": true, "@filterable": true, "@sortable": true } },
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

// ---- building generated output with the real toolchain ---------------------------------

/// The directory the generated crates are built in: the workspace's own target directory, so
/// serde and its derive build once and later runs reuse them. A separate sub-directory keeps
/// this off the outer `cargo test`'s lock.
pub fn target_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/gen-check")
}

pub fn cargo(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(args)
        .current_dir(dir)
        .env("CARGO_TARGET_DIR", target_dir())
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .output()
        .expect("cargo runs")
}

/// Run every shipped generator over the project, into `generated/`, through the run engine.
pub fn generate_all(project: &Scratch, entities: &[&str]) {
    let mut opts = RunOptions::new(project.path());
    opts.out_dir = PathBuf::from("generated");
    opts.entities = entities.iter().map(|e| e.to_string()).collect();
    run(&opts, &shipped_generators()).unwrap_or_else(|e| panic!("gen failed: {e}"));
}

pub fn copy_tree(from: &Path, to: &Path) {
    if from.is_dir() {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            copy_tree(&entry.path(), &to.join(entry.file_name()));
        }
    } else {
        std::fs::copy(from, to).unwrap();
    }
}

/// The lockfile the generated workspaces are built against. The generated crates depend on
/// crates the repository itself does not (`reqwest`, and `tokio` in the probe), so the
/// repository's own lockfile cannot pin them; without this file every run would resolve
/// whatever was newest that day.
pub fn gen_lock() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/gen-check.lock")
}

const UPDATE_GEN_LOCK: &str = "UPDATE_GEN_LOCK";

/// A scratch Cargo workspace holding a copy of the project's `generated` tree under `out/`,
/// plus a `probe` crate when one is given (its manifest's dependencies and its `main.rs`).
/// The workspace starts from [`gen_lock`], so cargo resolves the versions that file names.
/// Cargo is not run offline: a fresh machine has not downloaded them yet.
pub fn generated_workspace(tag: &str, project: &Scratch, probe: Option<(&str, &str)>) -> Scratch {
    let ws = Scratch::new(tag);
    copy_tree(&project.path().join("generated"), &ws.path().join("out"));
    let members = if probe.is_some() {
        "\"out/*\", \"probe\""
    } else {
        "\"out/*\""
    };
    ws.write(
        "Cargo.toml",
        &format!("[workspace]\nresolver = \"2\"\nmembers = [{members}]\n"),
    );
    std::fs::copy(gen_lock(), ws.path().join("Cargo.lock")).unwrap();
    if let Some((dependencies, main)) = probe {
        ws.write(
            "probe/Cargo.toml",
            &format!(
                "[package]\nname = \"probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\npublish = false\n\n[dependencies]\n{dependencies}"
            ),
        );
        ws.write("probe/src/main.rs", main);
    }
    ws
}

/// Every generated crate of the workspace is already in rustfmt's output form under the
/// `rustfmt.toml` it carries. `rustfmt` follows the `mod` declarations, so checking each
/// crate's root (and each binary or test root beside it) checks every file.
pub fn assert_formatted(ws: &Scratch) {
    let mut crates: Vec<PathBuf> = std::fs::read_dir(ws.path().join("out"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    crates.sort();
    assert!(!crates.is_empty(), "nothing was generated");
    for dir in crates {
        assert!(
            dir.join("rustfmt.toml").is_file(),
            "{} has no rustfmt.toml",
            dir.display()
        );
        let mut roots = Vec::new();
        for candidate in ["src/lib.rs", "src/main.rs"] {
            if dir.join(candidate).is_file() {
                roots.push(candidate.to_string());
            }
        }
        assert!(!roots.is_empty(), "{} has no crate root", dir.display());
        let out = Command::new("rustfmt")
            .args(["--check", "--edition", "2021"])
            .args(&roots)
            .current_dir(&dir)
            .output()
            .expect("rustfmt runs");
        assert!(
            out.status.success(),
            "{} is not rustfmt-clean:\n{}{}",
            dir.display(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

/// `cargo check` accepts the whole workspace.
pub fn assert_builds(ws: &Scratch, what: &str) {
    let check = cargo(ws.path(), &["check", "--workspace", "--all-targets", "-q"]);
    assert!(
        check.status.success(),
        "cargo check failed on {what}:\n{}",
        String::from_utf8_lossy(&check.stderr)
    );
}

/// The registry packages a lockfile names, as `name version` lines.
fn locked(lock: &str) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for package in lock.split("[[package]]").skip(1) {
        let value = |key: &str| {
            package
                .lines()
                .find_map(|l| l.strip_prefix(key))
                .map(|v| v.trim().trim_matches('"').to_string())
        };
        // A package with no `source` is one of the workspace's own crates.
        if let (Some(name), Some(version), Some(_)) =
            (value("name = "), value("version = "), value("source = "))
        {
            out.insert(format!("{name} {version}"));
        }
    }
    out
}

/// After a build: cargo resolved nothing [`gen_lock`] does not name. With `UPDATE_GEN_LOCK=1`
/// the workspace's lockfile becomes the committed one instead (run it on the shop workspace,
/// whose probe needs every dependency the generated crates can have).
pub fn assert_pinned(ws: &Scratch) {
    let built = ws.read("Cargo.lock");
    if std::env::var_os(UPDATE_GEN_LOCK).is_some() {
        std::fs::write(gen_lock(), &built).unwrap();
        return;
    }
    let pinned = locked(&std::fs::read_to_string(gen_lock()).unwrap());
    let floating: Vec<String> = locked(&built).difference(&pinned).cloned().collect();
    assert!(
        floating.is_empty(),
        "cargo resolved packages tests/gen-check.lock does not pin: {floating:?}\n\
         refresh it with `{UPDATE_GEN_LOCK}=1 cargo test -p metaobjects-codegen --test compile generated_crates`"
    );
}

/// Runs the workspace's probe and returns what it printed.
pub fn run_probe(ws: &Scratch) -> String {
    let probe = cargo(ws.path(), &["run", "-q", "-p", "probe"]);
    assert!(
        probe.status.success(),
        "the probe failed:\n{}{}",
        String::from_utf8_lossy(&probe.stdout),
        String::from_utf8_lossy(&probe.stderr)
    );
    String::from_utf8_lossy(&probe.stdout).into_owned()
}
