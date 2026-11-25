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
use metaobjects_codegen::{
    Change, ChangeKind, EntityGenerator, Generator, RunError, RunOptions, RunReport, VerifyReport,
    run, verify,
};

const MANIFEST: &str = ".metaobjects/.gen-state/.hashes/shop.json";

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
    let marker = r#"{ "field.string": { "name": "tags", "isArray": true } },"#;
    assert!(
        common::SHOP.contains(marker),
        "the shop model no longer has the line this edits"
    );
    let edited = common::SHOP.replace(
        marker,
        r#"{ "field.string": { "name": "tags", "isArray": true } },
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
        RunError::Refused(r) => assert_eq!(r.edited, vec![path.to_string()]),
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
        RunError::Refused(r) => {
            assert_eq!(r.edited, vec!["generated/shop/Cargo.toml".to_string()])
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
fn an_orphan_with_a_hand_edit_is_never_deleted_and_fails_the_run_by_name() {
    // The cross-port rule: a recorded file no generator emits any more is deleted only while
    // it is still what a run wrote. One that was edited stays, stays recorded, and fails the
    // run, so the next run reports it again and no skip key hides it.
    let p = Scratch::project("orphan-edited", &shop_files());
    gen_ok(&p);
    let orphan = "generated/shop_billing/src/invoice.rs";
    p.write(orphan, "// mine\n");
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    for _ in 0..2 {
        match gen_ok_err(&p) {
            RunError::Refused(r) => {
                assert!(r.edited.is_empty(), "{r:?}");
                assert_eq!(r.orphans, vec![orphan.to_string()]);
            }
            other => panic!("expected a refusal, got {other}"),
        }
        assert_eq!(p.read(orphan), "// mine\n", "the edit is left in place");
        // The object is gone, so nothing places the orphan any more: it is filed under the root.
        assert!(
            p.read(".metaobjects/.gen-state/.hashes/.root.json")
                .contains(orphan),
            "and it stays recorded"
        );
        assert!(
            !p.exists(&format!(".metaobjects/.gen-state/{FINGERPRINT_FILE}")),
            "a refused run is not a current one"
        );
    }
    // Its pristine neighbours went in the first run.
    assert!(!p.exists("generated/shop_billing/Cargo.toml"));
    // Deleting it is the remedy: the next run forgets the record and succeeds.
    std::fs::remove_file(p.path().join(orphan)).unwrap();
    gen_ok(&p);
    assert!(!p.read(MANIFEST).contains("shop_billing"));
}

#[test]
fn a_file_the_manifest_does_not_record_is_a_stranger_the_sweep_never_touches() {
    let p = Scratch::project("stranger", &shop_files());
    gen_ok(&p);
    p.write(
        "generated/shop/src/mine.rs",
        "// hand-written, never generated\n",
    );
    p.write("generated/notes.md", "kept\n");
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    let r = gen_ok(&p);
    assert!(r.files.removed >= 4, "{:?}", r.files);
    assert_eq!(
        p.read("generated/shop/src/mine.rs"),
        "// hand-written, never generated\n"
    );
    assert_eq!(p.read("generated/notes.md"), "kept\n");
}

#[test]
fn a_run_narrowed_to_some_generators_sweeps_nothing() {
    let p = Scratch::project("narrow-sweep", &shop_files());
    gen_ok(&p);
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    let r = gen_with(&p, |o| o.generators = Some(vec!["entity".to_string()])).unwrap();
    assert_eq!(r.files.removed, 0);
    assert!(p.exists("generated/shop_billing/src/invoice.rs"));
}

#[test]
fn the_change_report_names_what_changed_and_which_crates_to_rebuild() {
    let p = Scratch::project("changes", &shop_files());
    let first = gen_ok(&p);
    assert_eq!(first.changes.len(), first.files.created);
    assert!(first.changes.iter().all(|c| c.kind == ChangeKind::Created));
    assert_eq!(
        first.changed_roots(),
        vec![
            "meta_support".to_string(),
            "shop".to_string(),
            "shop_billing".to_string()
        ]
    );

    // One field added to one value object: one file rewritten, in one crate.
    p.write(
        "metaobjects/meta.shop.json",
        &common::SHOP.replace(
            r#"{ "field.string": { "name": "zipCode" } }"#,
            r#"{ "field.string": { "name": "zipCode" } }, { "field.string": { "name": "city" } }"#,
        ),
    );
    let second = gen_ok(&p);
    assert_eq!(
        second.changes,
        vec![Change {
            path: "generated/shop/src/address.rs".to_string(),
            kind: ChangeKind::Updated
        }]
    );
    assert_eq!(second.changed_roots(), vec!["shop".to_string()]);

    // A package removed: every one of its files is reported as removed.
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    let third = gen_ok(&p);
    assert!(!third.changes.is_empty());
    assert!(third.changes.iter().all(|c| c.kind == ChangeKind::Removed));
    assert_eq!(third.changed_roots(), vec!["shop_billing".to_string()]);

    // Nothing changed: the report is empty.
    let fourth = gen_with(&p, |o| o.force = true).unwrap();
    assert!(fourth.changes.is_empty() && fourth.changed_roots().is_empty());
}

fn check(p: &Scratch, tweak: impl FnOnce(&mut RunOptions)) -> VerifyReport {
    let mut opts = RunOptions::new(p.path());
    tweak(&mut opts);
    verify(&opts, &generators()).unwrap_or_else(|e| panic!("verify failed: {e}"))
}

/// Every file under the project with its bytes, so "verify wrote nothing" is an equality.
fn snapshot(p: &Scratch) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn walk(
        dir: &std::path::Path,
        base: &std::path::Path,
        out: &mut std::collections::BTreeMap<String, Vec<u8>>,
    ) {
        for e in std::fs::read_dir(dir).unwrap().filter_map(Result::ok) {
            let path = e.path();
            if path.is_dir() {
                walk(&path, base, out);
            } else {
                let rel = path
                    .strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.insert(rel, std::fs::read(&path).unwrap());
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    walk(p.path(), p.path(), &mut out);
    out
}

#[test]
fn verify_before_any_gen_reports_every_file_missing_and_writes_nothing() {
    let p = Scratch::project("verify-fresh", &shop_files());
    let before = snapshot(&p);
    let r = check(&p, |_| {});
    assert!(r.rendered && !r.in_sync());
    assert_eq!(r.missing.len(), r.checked);
    assert!(r.drifted.is_empty() && r.extra.is_empty());
    assert_eq!(
        snapshot(&p),
        before,
        "verify writes nothing: no file, no manifest, no key"
    );
}

#[test]
fn verify_after_gen_is_in_sync_and_answers_from_the_key_unless_told_to_render() {
    let p = Scratch::project("verify-clean", &shop_files());
    let generated = gen_ok(&p);
    let before = snapshot(&p);
    let local = check(&p, |_| {});
    assert!(
        local.in_sync() && !local.rendered,
        "a local run answers from the key"
    );
    assert_eq!(local.checked, generated.files.created);
    let full = check(&p, |o| o.force = true);
    assert!(
        full.in_sync() && full.rendered,
        "--full (and CI) always render"
    );
    assert_eq!(full.checked, generated.files.created);
    assert_eq!(snapshot(&p), before);
}

#[test]
fn verify_names_a_drifted_a_missing_and_an_extra_file() {
    let p = Scratch::project("verify-drift", &shop_files());
    gen_ok(&p);
    // drifted: an edit by hand. missing: a deleted file. extra: a package that went away,
    // one of whose files was also edited.
    p.write("generated/shop/src/address.rs", "// edited\n");
    std::fs::remove_file(p.path().join("generated/shop/src/category.rs")).unwrap();
    p.write(
        "generated/shop_billing/src/invoice.rs",
        "// edited orphan\n",
    );
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    let before = snapshot(&p);
    let r = check(&p, |_| {});
    assert!(r.rendered && !r.in_sync());
    assert_eq!(r.drifted, vec!["generated/shop/src/address.rs".to_string()]);
    assert_eq!(
        r.missing,
        vec!["generated/shop/src/category.rs".to_string()]
    );
    let edited: Vec<&str> = r
        .extra
        .iter()
        .filter(|x| x.edited)
        .map(|x| x.path.as_str())
        .collect();
    assert_eq!(edited, vec!["generated/shop_billing/src/invoice.rs"]);
    assert!(
        r.extra
            .iter()
            .any(|x| !x.edited && x.path == "generated/shop_billing/Cargo.toml")
    );
    assert_eq!(snapshot(&p), before);

    // A narrowed verify cannot tell an orphan from another generator's file: no extras.
    let narrow = check(&p, |o| o.generators = Some(vec!["entity".to_string()]));
    assert!(narrow.extra.is_empty());
    assert_eq!(narrow.drifted.len(), 1);
}

#[test]
fn verify_reports_exactly_what_gen_then_fixes() {
    // The gate and the sweep agree, so "regenerate" is a remedy that cannot loop.
    let p = Scratch::project("verify-agrees", &shop_files());
    gen_ok(&p);
    std::fs::remove_file(p.path().join("metaobjects/meta.billing.json")).unwrap();
    std::fs::remove_file(p.path().join("generated/shop/src/category.rs")).unwrap();
    assert!(!check(&p, |_| {}).in_sync());
    gen_ok(&p);
    assert!(check(&p, |o| o.force = true).in_sync());
}

#[test]
fn an_owned_generator_crate_is_an_input_of_the_skip_key() {
    // ADR-0064 `owned-generator-edited`: the engine cannot see inside an owned generator's
    // build, so its sources are hashed into the key and an edit regenerates.
    let p = Scratch::project("owned-input", &shop_files());
    p.write("codegen/Cargo.toml", "[package]\nname = \"codegen\"\n");
    p.write("codegen/main.rs", "fn main() {}\n");
    p.write("codegen/generators/entity.rs", "// v1\n");
    gen_ok(&p);
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);
    assert!(!check(&p, |_| {}).rendered);
    p.write("codegen/target/debug/junk", "build output is not an input");
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);
    p.write("codegen/generators/entity.rs", "// v2\n");
    assert!(
        check(&p, |_| {}).rendered,
        "verify must render after an owned generator edit"
    );
    let r = gen_ok(&p);
    assert_eq!(r.outcome, Outcome::Generated);
    assert_eq!(r.no_skip_reason, Some("an input changed"));
}

#[test]
fn every_source_of_an_owned_crate_is_an_input_and_its_build_output_is_not() {
    // The generator list is the adopter's file, so it may pull in a module the scaffold never
    // wrote (`mod util;`). An edit there changes what the owned generators emit; a skip that
    // did not see it would report "nothing changed" over stale output.
    let p = Scratch::project("owned-module", &shop_files());
    p.write("codegen/Cargo.toml", "[package]\nname = \"codegen\"\n");
    p.write("codegen/main.rs", "mod util;\nfn main() {}\n");
    p.write("codegen/util.rs", "// v1\n");
    p.write("codegen/generators/entity.rs", "// the owned generator\n");
    gen_ok(&p);
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);

    // What cargo writes on its own is no change: the build directory and the lockfile.
    p.write("codegen/target/debug/util.rs", "build output");
    p.write("codegen/Cargo.lock", "version = 4\n");
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);
    assert!(!check(&p, |_| {}).rendered);

    // An edit to the module beside the list.
    p.write("codegen/util.rs", "// v2\n");
    assert!(
        check(&p, |_| {}).rendered,
        "verify must not answer from the stored key after an owned module changed"
    );
    let r = gen_ok(&p);
    assert_eq!(r.outcome, Outcome::Generated);
    assert_eq!(r.no_skip_reason, Some("an input changed"));
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);

    // A new file anywhere in the crate, and one that only shares a skipped name deeper down.
    p.write("codegen/support/mod.rs", "// a new module\n");
    assert_eq!(gen_ok(&p).outcome, Outcome::Generated);
    p.write(
        "codegen/support/target/notes.rs",
        "// a source that happens to sit in `target`\n",
    );
    assert_eq!(gen_ok(&p).outcome, Outcome::Generated);
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);
}

#[test]
fn a_crate_the_owned_crate_reaches_by_path_is_an_input_and_an_engine_crate_is_not() {
    // A pack's generators, linked from a checkout: cargo rebuilds the owned binary from their
    // source, and their version does not move when their code does. A skip that did not see
    // an edit there would report "nothing changed" over stale output.
    let p = Scratch::project("owned-path-deps", &shop_files());
    // The real engine checkout, as `eject --engine <checkout>` writes it.
    let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.write(
        "codegen/Cargo.toml",
        &format!(
            "[package]\nname = \"codegen\"\n\n[[bin]]\nname = \"codegen\"\npath = \"main.rs\"\n\n\
             [dependencies]\n\
             metaobjects = {{ path = {:?} }}\n\
             metaobjects-codegen = {{ path = {:?} }}\n\
             metaobjects-fork = {{ path = \"../fork-of-engine/metaobjects\" }}\n\
                 linked-generators = {{ path = '../ws/linked' }} # path = \"../commented-out\"\n\n\
             [dev-dependencies]\nscratch-only = {{ path = \"../dev-only\" }}\n\n\
             [patch.crates-io]\nforked = {{ path = \"../fork\" }}\n",
            engine.join("../metaobjects"),
            engine,
        ),
    );
    p.write("codegen/main.rs", "fn main() {}\n");
    // The linked crate is a member of a workspace and inherits one dependency from its root.
    p.write(
        "ws/Cargo.toml",
        "[workspace]\nmembers = [\"linked\"]\n\n[workspace.dependencies]\nshared = { path = \"shared\" }\n",
    );
    p.write(
        "ws/linked/Cargo.toml",
        "[package]\nname = \"linked-generators\"\n\n[dependencies.deeper]\npath = \"../deeper\"\n\n\
         [dependencies]\nshared = { workspace = true }\n",
    );
    for dir in [
        "ws/linked",
        "ws/deeper",
        "ws/shared",
        "fork",
        "dev-only",
        "commented-out",
    ] {
        if dir != "ws/linked" {
            p.write(&format!("{dir}/Cargo.toml"), "[package]\nname = \"dep\"\n");
        }
        p.write(&format!("{dir}/src/lib.rs"), "// v1\n");
    }
    // Another checkout of a crate named like the engine's: not the engine that runs.
    p.write(
        "fork-of-engine/metaobjects/Cargo.toml",
        "[package]\nname = \"metaobjects\"\n",
    );
    p.write("fork-of-engine/metaobjects/src/lib.rs", "// v1\n");
    gen_ok(&p);
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);

    // An edit to the linked crate's source, to a crate it reaches by path in turn, to one it
    // inherits from its workspace, to a patched crate, and to a crate that only shares an
    // engine crate's name.
    for dir in [
        "ws/linked",
        "ws/deeper",
        "ws/shared",
        "fork",
        "fork-of-engine/metaobjects",
    ] {
        p.write(&format!("{dir}/src/lib.rs"), "// v2\n");
        let r = gen_ok(&p);
        assert_eq!(
            r.outcome,
            Outcome::Generated,
            "an edit to {dir} must regenerate"
        );
        assert_eq!(r.no_skip_reason, Some("an input changed"));
        assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);
    }

    // Not inputs: the linked crate's build output, a dev-dependency, which is not built into
    // the owned binary, and a path that only a comment names. (The real engine crates are not
    // either: the engine's own source hash covers them; `engine.rs` tests that directly.)
    p.write("ws/linked/target/debug/out.rs", "build output");
    p.write("dev-only/src/lib.rs", "// v2\n");
    p.write("commented-out/src/lib.rs", "// v2\n");
    assert_eq!(gen_ok(&p).outcome, Outcome::Skipped);
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
fn a_named_run_emits_every_file_of_the_selected_crate_and_nothing_of_the_others() {
    let p = Scratch::project("named-crate", &shop_files());
    gen_ok(&p);
    std::fs::remove_file(p.path().join("generated/shop/src/currency.rs")).unwrap();
    std::fs::remove_file(p.path().join("generated/shop_billing/src/invoice.rs")).unwrap();
    let r = gen_with(&p, |o| o.entities = vec!["Order".to_string()]).unwrap();
    // `Order`'s crate is the unit: its shared enum file comes back, the untouched
    // `shop_billing` crate does not.
    assert!(p.exists("generated/shop/src/currency.rs"));
    assert!(!p.exists("generated/shop_billing/src/invoice.rs"));
    assert_eq!(r.files.created, 1, "{:?}", r.files);
}

#[test]
fn a_named_run_restores_a_deleted_file_of_a_dependency_crate() {
    // `Invoice` sits in `shop_billing`, whose manifest depends on the `shop` crate; the
    // shared enum the emitted crate imports lives there, so a named run of `Invoice`
    // must bring that dependency crate's deleted file back.
    let p = Scratch::project("named-dep", &shop_files());
    gen_ok(&p);
    std::fs::remove_file(p.path().join("generated/shop/src/currency.rs")).unwrap();
    tick();
    let r = gen_with(&p, |o| o.entities = vec!["Invoice".to_string()]).unwrap();
    assert!(p.exists("generated/shop/src/currency.rs"));
    assert_eq!(r.files.created, 1, "{:?}", r.files);
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
fn the_project_root_is_not_an_output_directory_and_nothing_is_written() {
    let p = Scratch::project("root-out", &shop_files());
    for out in [".", ""] {
        let e = gen_with(&p, |o| o.out_dir = PathBuf::from(out)).expect_err("the project root");
        assert!(e.to_string().contains("ERR_OUT_DIR_OUTSIDE_PROJECT"), "{e}");
        assert!(e.to_string().contains("sub-directory"), "{e}");
    }
    assert!(!p.exists(".metaobjects/.gen-state"));
    assert!(!p.exists("shop"));
    assert!(!p.exists("Cargo.toml"));
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

#[test]
fn a_flag_naming_an_opt_in_generator_with_no_list_is_refused_not_ignored() {
    let p = Scratch::project("opt-in-flag", &shop_files());
    let e = gen_with(&p, |o| {
        o.generators = Some(vec!["service-routes".to_string()])
    })
    .unwrap_err()
    .to_string();
    assert!(e.contains("the generator service-routes is opt-in"), "{e}");
    assert!(!p.exists("generated"), "a refused run writes nothing");
}
