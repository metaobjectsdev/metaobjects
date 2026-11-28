//! The metamodel-docs corpus (`fixtures/metamodel-docs/`): the builder's data and the
//! rendered pages equal what TypeScript pinned.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use metaobjects::manifest::build_manifest;
use metaobjects::metamodel_docs::{build_pages, parse_definitions};
use metaobjects::providers::default_registry;
use metaobjects_codegen::plan::{shipped_provider_descriptions, shipped_template};
use metaobjects_codegen::render::{Body, Provider, RenderRequest, render};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/metamodel-docs")
}

struct Shipped;
impl Provider for Shipped {
    fn resolve(&self, reference: &str) -> Option<String> {
        shipped_template(reference).map(str::to_string)
    }
}

fn pages() -> Vec<metaobjects::metamodel_docs::Page> {
    let registry = default_registry().unwrap();
    build_pages(
        &build_manifest(&registry),
        &parse_definitions(),
        &shipped_provider_descriptions(),
    )
}

fn files_under(dir: &Path, prefix: &str, out: &mut BTreeSet<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if entry.path().is_dir() {
            files_under(&entry.path(), &format!("{prefix}{name}/"), out);
        } else {
            out.insert(format!("{prefix}{name}"));
        }
    }
}

#[test]
fn page_data_equals_every_pinned_data_file() {
    let dir = corpus().join("data");
    let pages = pages();
    let mut pinned = BTreeSet::new();
    files_under(&dir, "", &mut pinned);
    let built: BTreeSet<String> = pages.iter().map(|p| format!("{}.json", p.path)).collect();
    assert_eq!(built, pinned, "the page set and the data files differ");
    for page in &pages {
        let text = std::fs::read_to_string(dir.join(format!("{}.json", page.path))).unwrap();
        let expected: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(page.data, expected, "{}: page data", page.path);
    }
}

#[test]
fn rendered_pages_equal_every_expected_file_byte_for_byte() {
    let dir = corpus().join("expected");
    let pages = pages();
    let mut pinned = BTreeSet::new();
    files_under(&dir, "", &mut pinned);
    let built: BTreeSet<String> = pages.iter().map(|p| p.path.clone()).collect();
    assert_eq!(built, pinned, "the page set and the expected files differ");
    for page in &pages {
        let request = RenderRequest::new(Body::Ref(page.template), &page.data, &Shipped);
        let text = render(&request).unwrap_or_else(|e| panic!("{}: {e}", page.path));
        let expected = std::fs::read_to_string(dir.join(&page.path)).unwrap();
        assert_eq!(text, expected, "{}: rendered bytes", page.path);
    }
}

/// Run the generator through the engine, as `cargo meta gen` does for a list that names it.
fn run_gen(list: &str, template: Option<(&str, &str)>) -> common::Scratch {
    let p = common::Scratch::project("metamodel-docs", &common::shop_files());
    p.write("metaobjects.config.json", list);
    if let Some((path, text)) = template {
        p.write(path, text);
    }
    let mut opts = metaobjects_codegen::RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    metaobjects_codegen::run(&opts, &metaobjects_codegen::shipped_generators())
        .unwrap_or_else(|e| panic!("gen failed: {e}"));
    p
}

#[test]
fn the_generator_writes_the_pages_under_metamodel_and_reads_no_model() {
    let p = run_gen(r#"{ "generators": ["metamodel-docs"] }"#, None);
    let expected = std::fs::read_to_string(corpus().join("expected/types/field.md")).unwrap();
    assert_eq!(p.read("generated/metamodel/types/field.md"), expected);
    assert!(
        p.exists("generated/metamodel/INDEX.md") && p.exists("generated/metamodel/providers.md")
    );
}

#[test]
fn the_dir_option_moves_the_pages_and_a_project_template_wins() {
    let p = run_gen(
        r#"{ "generators": [{ "name": "metamodel-docs", "options": { "dir": "" } }] }"#,
        Some((
            "templates/metamodel/index.md.mustache",
            "mine {{{rows.length}}}\n",
        )),
    );
    assert!(p.exists("generated/providers.md") && !p.exists("generated/metamodel/INDEX.md"));
    assert!(p.read("generated/INDEX.md").starts_with("mine"));
}
