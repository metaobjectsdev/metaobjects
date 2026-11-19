//! The run engine's contract (ADR-0064): identical bytes are never rewritten, the manifest is
//! written only when a record changed, an unchanged project skips without touching disk, and a
//! hand-edited generated file is refused rather than overwritten.

mod common;

use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;

use common::{Scratch, shop_files};
use metaobjects_codegen::engine::{
    Outcome, STAGE_LOAD, STAGE_PLAN, STAGE_RENDER, STAGE_SKIP, STAGE_WRITE,
};
use metaobjects_codegen::fingerprint::FINGERPRINT_FILE;
use metaobjects_codegen::{EntityGenerator, Generator, RunError, RunOptions, RunReport, run};

const MANIFEST: &str = ".metaobjects/.gen-state/.hashes.json";

fn generators() -> Vec<Box<dyn Generator>> {
    vec![Box::new(EntityGenerator)]
}

fn gen_with(project: &Scratch, tweak: impl FnOnce(&mut RunOptions)) -> Result<RunReport, RunError> {
    let mut opts = RunOptions::new(project.path());
    tweak(&mut opts);
    run(&opts, &generators())
}

fn gen_ok(project: &Scratch) -> RunReport {
    gen_with(project, |_| {}).unwrap_or_else(|e| panic!("gen failed: {e}"))
}

/// A pause longer than the filesystem's timestamp granularity, so "untouched" is observable.
fn tick() {
    sleep(Duration::from_millis(30));
}

#[test]
fn a_first_run_writes_every_file_and_records_them_all() {
    let p = Scratch::project("first", &shop_files());
    let r = gen_ok(&p);
    assert_eq!(r.outcome, Outcome::Generated);
    assert_eq!(r.files.overwritten + r.files.unchanged, 0);
    assert!(r.files.created > 0);
    assert!(r.manifest_written);
    assert!(p.exists("generated/shop/src/order.rs"));
    assert!(p.exists("generated/shop_billing/Cargo.toml"));
    let manifest = p.read(MANIFEST);
    assert!(
        manifest.contains("\"generated/shop/src/order.rs\""),
        "{manifest}"
    );
    assert!(manifest.ends_with("}\n"));
    assert!(p.exists(&format!(".metaobjects/.gen-state/{FINGERPRINT_FILE}")));
    let names: Vec<&str> = r.timings.phases.iter().map(|t| t.name).collect();
    assert_eq!(names, [STAGE_LOAD, STAGE_PLAN, STAGE_RENDER, STAGE_WRITE]);
}

#[test]
fn an_unchanged_project_skips_without_touching_any_file() {
    let p = Scratch::project("skip", &shop_files());
    gen_ok(&p);
    let files = [
        "generated/shop/src/order.rs",
        MANIFEST,
        ".metaobjects/.gen-state/.fingerprint-rust.json",
    ];
    let before: Vec<_> = files.iter().map(|f| p.mtime(f)).collect();
    tick();
    let r = gen_ok(&p);
    assert_eq!(r.outcome, Outcome::Skipped);
    assert!(!r.manifest_written);
    assert_eq!(r.files, Default::default());
    let names: Vec<&str> = r.timings.phases.iter().map(|t| t.name).collect();
    assert_eq!(
        names,
        [STAGE_LOAD, STAGE_PLAN, STAGE_SKIP],
        "a skip renders and writes nothing"
    );
    let after: Vec<_> = files.iter().map(|f| p.mtime(f)).collect();
    assert_eq!(before, after, "a skipped run moves no timestamp");
}

#[test]
fn identical_bytes_are_never_rewritten_and_an_unchanged_manifest_is_never_saved() {
    let p = Scratch::project("noop", &shop_files());
    gen_ok(&p);
    let order = p.mtime("generated/shop/src/order.rs");
    let manifest = p.mtime(MANIFEST);
    tick();
    // --force renders everything, so every file is compared; none may be written.
    let r = gen_with(&p, |o| o.force = true).unwrap();
    assert_eq!(r.outcome, Outcome::Generated);
    assert_eq!(r.files.created + r.files.overwritten, 0);
    assert!(r.files.unchanged > 0);
    assert!(!r.manifest_written);
    assert_eq!(p.mtime("generated/shop/src/order.rs"), order);
    assert_eq!(p.mtime(MANIFEST), manifest);
}

#[test]
fn a_changed_model_rewrites_only_the_file_that_changed_and_saves_the_manifest_once() {
    let p = Scratch::project("delta", &shop_files());
    gen_ok(&p);
    let order = p.mtime("generated/shop/src/order.rs");
    let address = p.mtime("generated/shop/src/address.rs");
    tick();
    let edited = common::SHOP.replace(
        r#"{ "field.string": { "name": "type" } },"#,
        r#"{ "field.string": { "name": "type" } },
    { "field.string": { "name": "channel" } },"#,
    );
    p.write("metaobjects/meta.shop.json", &edited);
    let r = gen_ok(&p);
    assert_eq!(r.outcome, Outcome::Generated);
    assert_eq!(r.files.overwritten, 1, "{:?}", r.files);
    assert_eq!(r.files.created, 0);
    assert!(r.manifest_written, "one changed hash is one manifest save");
    assert!(
        p.read("generated/shop/src/order.rs")
            .contains("pub channel: Option<String>")
    );
    assert!(p.mtime("generated/shop/src/order.rs") > order);
    assert_eq!(p.mtime("generated/shop/src/address.rs"), address);
}

#[test]
fn a_hand_edited_generated_file_is_refused_and_the_run_stores_no_key() {
    let p = Scratch::project("edited", &shop_files());
    gen_ok(&p);
    let path = "generated/shop/src/address.rs";
    let edited = format!("{}\n// my edit\n", p.read(path));
    p.write(path, &edited);
    let e = gen_ok_err(&p);
    match e {
        RunError::Refused(paths) => assert_eq!(paths, vec![path.to_string()]),
        other => panic!("expected a refusal, got {other}"),
    }
    assert_eq!(p.read(path), edited, "the edit is left in place");
    assert!(
        !p.exists(&format!(".metaobjects/.gen-state/{FINGERPRINT_FILE}")),
        "a refused run is not a current one"
    );
}

fn gen_ok_err(p: &Scratch) -> RunError {
    gen_with(p, |_| {}).expect_err("the run fails")
}

#[test]
fn an_existing_file_nobody_recorded_is_refused_not_adopted() {
    let p = Scratch::project("unrecorded", &shop_files());
    p.write("generated/shop/Cargo.toml", "# somebody else's\n");
    match gen_ok_err(&p) {
        RunError::Refused(paths) => {
            assert_eq!(paths, vec!["generated/shop/Cargo.toml".to_string()])
        }
        other => panic!("expected a refusal, got {other}"),
    }
}

#[test]
fn a_package_that_goes_away_has_its_generated_files_removed() {
    let p = Scratch::project("orphan", &shop_files());
    gen_ok(&p);
    assert!(p.exists("generated/shop_billing/src/invoice.rs"));
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    let r = gen_ok(&p);
    assert!(r.files.removed >= 4, "{:?}", r.files);
    assert!(
        !p.exists("generated/shop_billing"),
        "the emptied crate directory is gone too"
    );
    assert!(p.exists("generated/shop/src/order.rs"));
    assert!(!p.read(MANIFEST).contains("shop_billing"));
}

#[test]
fn an_orphan_with_a_hand_edit_is_kept_with_a_warning() {
    let p = Scratch::project("orphan-edited", &shop_files());
    gen_ok(&p);
    p.write("generated/shop_billing/src/invoice.rs", "// mine\n");
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    let r = gen_ok(&p);
    assert!(p.exists("generated/shop_billing/src/invoice.rs"));
    assert!(
        r.warnings.iter().any(|w| w.contains("invoice.rs")),
        "{:?}",
        r.warnings
    );
}

#[test]
fn naming_an_entity_limits_the_run_and_never_skips_or_stores_a_key() {
    let p = Scratch::project("named", &shop_files());
    gen_ok(&p);
    let key = p.read(&format!(".metaobjects/.gen-state/{FINGERPRINT_FILE}"));
    let address = p.mtime("generated/shop/src/address.rs");
    tick();
    let r = gen_with(&p, |o| o.entities = vec!["Order".to_string()]).unwrap();
    assert_eq!(r.outcome, Outcome::Generated, "a named run never skips");
    assert_eq!(r.files.created + r.files.overwritten, 0);
    assert_eq!(r.files.removed, 0, "a named run sweeps nothing");
    assert_eq!(p.mtime("generated/shop/src/address.rs"), address);
    assert_eq!(
        p.read(&format!(".metaobjects/.gen-state/{FINGERPRINT_FILE}")),
        key,
        "the full-run key is left as it was found"
    );
    let e = gen_with(&p, |o| o.entities = vec!["Nope".to_string()]).expect_err("unknown entity");
    assert!(
        e.to_string()
            .contains("no entity or value object named Nope"),
        "{e}"
    );
}

#[test]
fn a_load_error_stops_the_run_before_anything_is_written() {
    let p = Scratch::project("bad", &[("metaobjects/meta.bad.json", "{ not json")]);
    let e = gen_with(&p, |_| {}).expect_err("the model does not load");
    assert!(matches!(e, RunError::Load(_)), "{e}");
    assert!(!p.exists("generated"));
    assert!(!p.exists(".metaobjects/.gen-state"));
}

#[test]
fn the_output_directory_must_be_inside_the_project() {
    let p = Scratch::project("outside", &shop_files());
    let e = gen_with(&p, |o| o.out_dir = PathBuf::from("../elsewhere")).expect_err("outside");
    assert!(e.to_string().contains("ERR_OUT_DIR_OUTSIDE_PROJECT"), "{e}");
}

#[test]
fn two_name_collisions_and_a_crate_cycle_are_reported_not_emitted() {
    // Two objects that become one Rust type.
    let dup = r#"{ "metadata.root": { "package": "dup", "children": [
      { "object.entity": { "name": "order_line", "children": [{ "field.long": { "name": "id" } }] } },
      { "object.entity": { "name": "OrderLine", "children": [{ "field.long": { "name": "id" } }] } }
    ] } }"#;
    let p = Scratch::project("dup", &[("metaobjects/meta.dup.json", dup)]);
    let e = gen_with(&p, |_| {}).expect_err("collision");
    assert!(e.to_string().contains("ERR_NAME_COLLISION"), "{e}");

    // Two packages that refer to each other cannot be two crates.
    let a = r#"{ "metadata.root": { "package": "ca", "children": [
      { "object.entity": { "name": "A", "children": [
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "b", "@objectRef": "cb::B" } } ] } } ] } }"#;
    let b = r#"{ "metadata.root": { "package": "cb", "children": [
      { "object.entity": { "name": "B", "children": [
        { "field.long": { "name": "id" } },
        { "field.object": { "name": "a", "@objectRef": "ca::A" } } ] } } ] } }"#;
    let p = Scratch::project(
        "cycle",
        &[
            ("metaobjects/meta.a.json", a),
            ("metaobjects/meta.b.json", b),
        ],
    );
    let e = gen_with(&p, |_| {}).expect_err("cycle");
    assert!(e.to_string().contains("ERR_CRATE_CYCLE"), "{e}");
    assert!(!p.exists("generated"));
}
