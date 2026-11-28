//! The generated text of a small two-package model, pinned file by file.
//!
//! The goldens under `tests/golden/shop/` are the specification of the shipped generators'
//! output. A change to the emitted text fails here with the file named; regenerate them
//! deliberately with `UPDATE_GOLDEN=1 cargo test -p metaobjects-codegen --test golden`.

mod common;

use std::collections::BTreeMap;
use std::path::PathBuf;

use common::{Scratch, shop_files};
use metaobjects_codegen::EntityGenerator;
use metaobjects_codegen::generator::{GenContext, Generator};
use metaobjects_codegen::project::load_project;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/shop")
}

fn generate(files: &[(&str, &str)]) -> BTreeMap<String, String> {
    let project = Scratch::project("golden", files);
    let loaded = load_project(project.path(), None, false).expect("the model loads clean");
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &[],
        collection: &loaded.collection,
        reference_nodes: &loaded.reference_nodes,
    };
    common::crate_generators()
        .iter()
        .flat_map(|g| {
            g.generate(&ctx)
                .unwrap_or_else(|e| panic!("{} failed: {e}", g.name()))
        })
        .filter(|f| !VERBATIM.contains(&f.path.as_str()) && !LIBRARIES.contains(&f.path.as_str()))
        .map(|f| (f.path, f.content))
        .collect()
}

/// The support crate's three source files are the engine's own `emitted` modules, written
/// out verbatim; `the_support_crate_is_the_emitted_modules` pins that, so a second copy of
/// them here would only have to be regenerated on every edit.
const VERBATIM: &[&str] = &[
    "meta_support/src/pattern.rs",
    "meta_support/src/validation.rs",
    "meta_support/src/wire.rs",
];

/// The transport and the command helpers are fixed text held by their generators. The
/// compile gate builds them, format-checks them and drives them; a copy here would pin
/// nothing the gate does not.
const LIBRARIES: &[&str] = &["meta_client/src/lib.rs", "meta_cli/src/lib.rs"];

fn read_goldens() -> BTreeMap<String, String> {
    fn walk(dir: &std::path::Path, base: &std::path::Path, out: &mut BTreeMap<String, String>) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        for e in read.filter_map(Result::ok) {
            let p = e.path();
            if p.is_dir() {
                walk(&p, base, out);
            } else {
                let rel = p
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.insert(rel, std::fs::read_to_string(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(&golden_dir(), &golden_dir(), &mut out);
    out
}

#[test]
fn the_shop_model_generates_exactly_the_golden_files() {
    let got = generate(&shop_files());
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        let _ = std::fs::remove_dir_all(golden_dir());
        for (path, text) in &got {
            let p = golden_dir().join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        return;
    }
    let want = read_goldens();
    assert_eq!(
        got.keys().collect::<Vec<_>>(),
        want.keys().collect::<Vec<_>>(),
        "the set of generated files changed"
    );
    for (path, text) in &got {
        assert_eq!(text, &want[path], "{path} differs from its golden");
    }
}

#[test]
fn generation_is_deterministic() {
    assert_eq!(generate(&shop_files()), generate(&shop_files()));
}

#[test]
fn the_support_crate_is_the_emitted_modules() {
    use metaobjects_codegen::emitted::{PATTERN_RS, VALIDATION_RS, WIRE_RS};
    let project = Scratch::project("golden-support", &shop_files());
    let loaded = load_project(project.path(), None, false).expect("the model loads clean");
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &[],
        collection: &loaded.collection,
        reference_nodes: &loaded.reference_nodes,
    };
    let files = EntityGenerator
        .generate(&ctx)
        .expect("the entity generator succeeds");
    for (path, source) in VERBATIM.iter().zip([PATTERN_RS, VALIDATION_RS, WIRE_RS]) {
        let file = files
            .iter()
            .find(|f| f.path == *path)
            .unwrap_or_else(|| panic!("no {path}"));
        assert!(
            file.content.ends_with(source) && file.content.starts_with("// @generated"),
            "{path} is not the engine's module under the generated banner"
        );
    }
}
