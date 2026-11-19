//! `cargo meta gen` as cargo runs it: the real `cargo-meta` binary, started the way cargo
//! starts an external subcommand (`cargo-meta meta gen ...`) and the way a person might
//! (`cargo-meta gen ...`).

use std::path::PathBuf;
use std::process::{Command, Output};

const MODEL: &str = r#"{ "metadata.root": { "package": "shop", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "field.long": { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"] } },
    { "field.string": { "name": "note" } }
  ] } }
] } }"#;

struct Project(PathBuf);

impl Project {
    fn new(tag: &str) -> Self {
        let base = std::env::var_os("DEV_SCRATCH")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("mo-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".metaobjects")).unwrap();
        std::fs::create_dir_all(dir.join("metaobjects")).unwrap();
        std::fs::write(
            dir.join(".metaobjects/config.json"),
            r#"{ "schema_version": 1 }"#,
        )
        .unwrap();
        std::fs::write(dir.join("metaobjects/meta.shop.json"), MODEL).unwrap();
        Project(dir)
    }

    fn run(&self, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_cargo-meta"))
            .args(args)
            .current_dir(&self.0)
            .output()
            .expect("cargo-meta starts")
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

#[test]
fn cargo_meta_gen_writes_the_crate_then_skips() {
    let p = Project::new("gen");
    let first = p.run(&["meta", "gen", "--timings"]);
    assert!(first.status.success(), "{}", text(&first.stderr));
    let out = text(&first.stdout);
    assert!(out.contains("gen: 4 files (4 created"), "{out}");
    assert!(out.contains("render") && out.contains("write"), "{out}");
    let order = std::fs::read_to_string(p.0.join("generated/shop/src/order.rs")).unwrap();
    assert!(order.contains("pub struct Order"), "{order}");
    assert!(order.contains("pub note: Option<String>"), "{order}");

    let second = p.run(&["meta", "gen", "--timings"]);
    assert!(second.status.success());
    let out = text(&second.stdout);
    assert!(out.contains("skipped, nothing changed"), "{out}");
    assert!(
        !out.contains("render"),
        "a skipped run has no render stage: {out}"
    );
}

#[test]
fn the_direct_spelling_works_and_out_moves_the_output() {
    let p = Project::new("direct");
    let r = p.run(&["gen", "--out", "crates"]);
    assert!(r.status.success(), "{}", text(&r.stderr));
    assert!(p.0.join("crates/shop/Cargo.toml").exists());
    assert!(!p.0.join("generated").exists());
}

#[test]
fn a_hand_edit_makes_the_run_fail_and_name_the_file() {
    let p = Project::new("edit");
    assert!(p.run(&["meta", "gen"]).status.success());
    let file = p.0.join("generated/shop/src/order.rs");
    std::fs::write(&file, "// mine\n").unwrap();
    let r = p.run(&["meta", "gen"]);
    assert_eq!(r.status.code(), Some(1));
    assert!(
        text(&r.stderr).contains("generated/shop/src/order.rs"),
        "{}",
        text(&r.stderr)
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "// mine\n");
}

#[test]
fn a_model_that_does_not_load_exits_1_and_writes_nothing() {
    let p = Project::new("bad");
    std::fs::write(p.0.join("metaobjects/meta.shop.json"), "{ nope").unwrap();
    let r = p.run(&["meta", "gen"]);
    assert_eq!(r.status.code(), Some(1));
    assert!(
        text(&r.stderr).contains("Nothing was written"),
        "{}",
        text(&r.stderr)
    );
    assert!(!p.0.join("generated").exists());
}

#[test]
fn usage_errors_exit_2_and_help_exits_0() {
    let p = Project::new("usage");
    assert_eq!(p.run(&["meta", "verify"]).status.code(), Some(2));
    assert_eq!(p.run(&["meta", "gen", "--nope"]).status.code(), Some(2));
    let h = p.run(&["meta", "--help"]);
    assert!(h.status.success());
    assert!(text(&h.stdout).contains("cargo meta gen"));
}
