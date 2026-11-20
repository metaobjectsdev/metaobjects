//! The per-package hash manifest (ADR-0064 Amendment 1): the shared vectors, file-level
//! separation between packages, a read-only load that migrates nothing, and an end-to-end run.

mod common;

use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use common::{Scratch, shop_files};
use metaobjects_codegen::generator::{EmittedFile, GenContext, GenError};
use metaobjects_codegen::hashes::{
    HASHES_DIR, HASHES_FILE, HashManifest, ROOT_FILE, migrate_gitignore, package_file_name, place,
};
use metaobjects_codegen::{Generator, RunOptions, run};
use serde_json::{Map, Value};

const VECTORS: &str = include_str!("../../../../fixtures/codegen-skip-conformance/manifests.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}

fn objects(v: &Value) -> Vec<(String, String)> {
    v["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            (
                o["name"].as_str().unwrap().to_string(),
                o["package"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

fn scratch(tag: &str) -> PathBuf {
    let base = std::env::var_os("DEV_SCRATCH")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(format!("mo-hash-manifest-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A gen-state directory inside `<root>/.metaobjects`, as a project lays it out.
fn gen_state(root: &Path) -> PathBuf {
    let dir = root.join(".metaobjects/.gen-state");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn files_of(gen_state: &Path) -> std::collections::BTreeMap<String, String> {
    let dir = gen_state.join(HASHES_DIR);
    std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| {
                    (
                        e.file_name().into_string().unwrap(),
                        std::fs::read_to_string(e.path()).unwrap(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn tick() {
    sleep(Duration::from_millis(30));
}

#[test]
fn file_names_follow_the_vectors() {
    for c in vectors()["fileNames"].as_array().unwrap() {
        let got = package_file_name(c["package"].as_str());
        assert_eq!(got, c["file"].as_str().unwrap(), "{}", c["package"]);
    }
}

#[test]
fn placement_follows_the_vectors() {
    let v = vectors();
    let objs = objects(&v);
    for c in v["placement"].as_array().unwrap() {
        let path = c["path"].as_str().unwrap();
        let entry = c.get("entry").cloned().unwrap_or(Value::String("h".into()));
        let got = place(path, &entry, &objs);
        assert_eq!(
            got.as_deref(),
            c["package"].as_str(),
            "{path}: {}",
            c["why"]
        );
    }
}

#[test]
fn a_legacy_manifest_splits_exactly_as_the_vector_says() {
    let v = vectors();
    let split = &v["legacySplit"];
    let root = scratch("split");
    let gs = gen_state(&root);
    let ignore = root.join(".metaobjects/.gitignore");
    std::fs::write(&ignore, split["gitignoreBefore"].as_str().unwrap()).unwrap();
    std::fs::write(
        gs.join(HASHES_FILE),
        serde_json::to_string_pretty(&split["legacy"]).unwrap(),
    )
    .unwrap();

    let mut m = HashManifest::load(&gs);
    assert!(m.existed() && m.is_legacy());
    m.set_objects(objects(&v));
    assert!(m.save().unwrap());

    assert!(!gs.join(HASHES_FILE).exists(), "the legacy file is removed");
    let got = files_of(&gs);
    let want = split["files"].as_object().unwrap();
    assert_eq!(
        got.keys().collect::<Vec<_>>(),
        want.keys()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
    );
    for (name, text) in &got {
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(&parsed, &want[name], "{name}");
    }
    let golden = split["goldenFile"].as_str().unwrap();
    assert_eq!(got[golden], split["goldenText"].as_str().unwrap());
    assert_eq!(
        std::fs::read_to_string(&ignore).unwrap(),
        split["gitignoreAfter"].as_str().unwrap()
    );

    // A second identical write changes no file.
    let mtimes = |gs: &Path| -> Vec<_> {
        files_of(gs)
            .keys()
            .map(|n| {
                std::fs::metadata(gs.join(HASHES_DIR).join(n))
                    .unwrap()
                    .modified()
                    .unwrap()
            })
            .collect()
    };
    let before = (files_of(&gs), mtimes(&gs));
    tick();
    let mut again = HashManifest::load(&gs);
    again.set_objects(objects(&v));
    assert!(!again.is_legacy() && !again.save().unwrap());
    assert_eq!((files_of(&gs), mtimes(&gs)), before);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn the_gitignore_is_left_alone_when_it_has_the_line_or_no_rule() {
    let after = vectors()["legacySplit"]["gitignoreAfter"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(migrate_gitignore(&after), None);
    assert_eq!(migrate_gitignore("target/\n"), None);
}

#[test]
fn different_packages_are_different_files() {
    let root = scratch("packages");
    let gs = gen_state(&root);
    let objs = vec![
        ("Order".to_string(), "acme::shop".to_string()),
        ("Customer".to_string(), "acme::crm".to_string()),
    ];
    let mut m = HashManifest::load(&gs);
    m.set_objects(objs.clone());
    m.record("gen/Order.rs", "o1");
    m.record("gen/Customer.rs", "c1");
    m.record("gen/index.rs", "i1");
    assert!(m.save().unwrap());
    let names: Vec<String> = files_of(&gs).into_keys().collect();
    assert_eq!(names, [".root.json", "acme.crm.json", "acme.shop.json"]);

    let mtime = |n: &str| {
        std::fs::metadata(gs.join(HASHES_DIR).join(n))
            .unwrap()
            .modified()
            .unwrap()
    };
    let (crm, shop, root_m) = (
        mtime("acme.crm.json"),
        mtime("acme.shop.json"),
        mtime(ROOT_FILE),
    );
    let shop_text = files_of(&gs)["acme.shop.json"].clone();
    tick();

    // A no-op save writes nothing.
    let mut m = HashManifest::load(&gs);
    m.set_objects(objs.clone());
    m.record("gen/Order.rs", "o1");
    assert!(!m.save().unwrap());
    assert_eq!(mtime("acme.shop.json"), shop);

    // A change in package A touches A's file only.
    m.record("gen/Customer.rs", "c2");
    assert!(m.save().unwrap());
    assert_ne!(mtime("acme.crm.json"), crm);
    assert_eq!(mtime("acme.shop.json"), shop);
    assert_eq!(mtime(ROOT_FILE), root_m);
    assert_eq!(files_of(&gs)["acme.shop.json"], shop_text);

    // The last entry of a package takes its file with it.
    m.remove("gen/Customer.rs");
    assert!(m.save().unwrap());
    assert!(!gs.join(HASHES_DIR).join("acme.crm.json").exists());

    // An emptied manifest keeps `.root.json` as `{}`.
    m.remove("gen/Order.rs");
    m.remove("gen/index.rs");
    assert!(m.save().unwrap());
    let left = files_of(&gs);
    assert_eq!(left.len(), 1);
    assert_eq!(left[ROOT_FILE], "{}\n");
    assert!(HashManifest::load(&gs).existed());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_read_only_load_of_a_legacy_manifest_migrates_nothing() {
    let root = scratch("readonly");
    let gs = gen_state(&root);
    let text = "{\n  \"gen/Order.rs\": \"o1\"\n}\n";
    std::fs::write(gs.join(HASHES_FILE), text).unwrap();
    let mut m = HashManifest::load(&gs);
    m.set_objects(vec![("Order".into(), "acme::shop".into())]);
    assert_eq!(m.hash_of("gen/Order.rs"), Some("o1"));
    drop(m);
    assert_eq!(std::fs::read_to_string(gs.join(HASHES_FILE)).unwrap(), text);
    assert!(!gs.join(HASHES_DIR).exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_package_file_wins_over_the_legacy_file() {
    let root = scratch("union");
    let gs = gen_state(&root);
    std::fs::write(gs.join(HASHES_FILE), "{\"a.rs\":\"old\",\"b.rs\":\"b\"}").unwrap();
    std::fs::create_dir_all(gs.join(HASHES_DIR)).unwrap();
    std::fs::write(gs.join(HASHES_DIR).join(ROOT_FILE), "{\"a.rs\":\"new\"}").unwrap();
    let m = HashManifest::load(&gs);
    assert_eq!(m.hash_of("a.rs"), Some("new"));
    assert_eq!(m.hash_of("b.rs"), Some("b"));
    let _ = std::fs::remove_dir_all(&root);
}

/// Emits one snake_case file per object, named for the object (`src/order.txt`), so the stem rule can place it.
struct PerObject;

impl Generator for PerObject {
    fn name(&self) -> &str {
        "per-object"
    }
    fn identity(&self) -> String {
        "per-object:1".into()
    }
    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        let mut out = Vec::new();
        for &c in ctx.tree.own_children(ctx.root) {
            if ctx.tree.node(c).type_name == "object" {
                let name = &ctx.tree.node(c).name;
                out.push(EmittedFile::new(
                    format!("src/{}.txt", name.to_lowercase()),
                    format!("// {name}\n"),
                ));
            }
        }
        out.push(EmittedFile::new(
            "index.txt".to_string(),
            "// all\n".to_string(),
        ));
        Ok(out)
    }
}

#[test]
fn a_run_over_a_two_package_model_writes_a_manifest_per_package_and_a_root_one() {
    let p = Scratch::project("e2e", &shop_files());
    let opts = RunOptions::new(p.path());
    let gens: Vec<Box<dyn Generator>> = vec![Box::new(PerObject)];
    let r = run(&opts, &gens).unwrap_or_else(|e| panic!("{e}"));
    assert!(r.manifest_written);
    let gs = p.path().join(".metaobjects/.gen-state");
    assert!(!gs.join(HASHES_FILE).exists());
    let files = files_of(&gs);
    assert!(files.contains_key("shop.json"), "{:?}", files.keys());
    assert!(
        files.contains_key("shop.billing.json"),
        "{:?}",
        files.keys()
    );
    assert!(files.contains_key(ROOT_FILE), "{:?}", files.keys());
    let shop: Map<String, Value> = serde_json::from_str(&files["shop.json"]).unwrap();
    let billing: Map<String, Value> = serde_json::from_str(&files["shop.billing.json"]).unwrap();
    assert!(shop.keys().any(|k| k.ends_with("/order.txt")), "{shop:?}");
    assert!(
        billing.keys().any(|k| k.ends_with("/invoice.txt")),
        "{billing:?}"
    );
    assert!(files[ROOT_FILE].contains("index.txt"));
}

#[test]
fn the_gitignore_migration_replaces_the_legacy_line_or_inserts_after_the_rule() {
    let new = ".gen-state/*\n!.gen-state/.hashes/\n";
    assert_eq!(
        migrate_gitignore(".gen-state/*\n!.gen-state/.hashes.json\n").as_deref(),
        Some(new)
    );
    assert_eq!(migrate_gitignore(".gen-state/*\n").as_deref(), Some(new));
    assert_eq!(
        migrate_gitignore(".gen-state/*\n!.gen-state/.hashes/\n!.gen-state/.hashes.json\n")
            .as_deref(),
        Some(new)
    );
}

#[test]
fn a_manifest_whose_entries_are_all_in_packages_has_no_root_file() {
    let root = scratch("noroot");
    let gs = gen_state(&root);
    std::fs::create_dir_all(gs.join(HASHES_DIR)).unwrap();
    std::fs::write(gs.join(HASHES_DIR).join(ROOT_FILE), "{}\n").unwrap();
    let mut m = HashManifest::load(&gs);
    m.set_objects(vec![("Order".into(), "acme::shop".into())]);
    m.record("gen/Order.rs", "o1");
    assert!(m.save().unwrap());
    let names: Vec<String> = files_of(&gs).into_keys().collect();
    assert_eq!(names, ["acme.shop.json"]);
    let _ = std::fs::remove_dir_all(&root);
}
