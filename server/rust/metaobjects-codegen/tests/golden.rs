//! The generated text of a small two-package model, pinned file by file.
//!
//! The goldens under `tests/golden/shop/` are the specification of the entity generator's
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
    };
    EntityGenerator
        .generate(&ctx)
        .expect("the entity generator succeeds")
        .into_iter()
        .map(|f| (f.path, f.content))
        .collect()
}

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
