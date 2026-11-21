//! `cargo meta` as cargo runs it: the real `cargo-meta` binary, started the way cargo starts
//! an external subcommand (`cargo-meta meta gen ...`) and the way a person might
//! (`cargo-meta gen ...`). The whole loop is here: `init`, `gen`, `verify`, `eject` and
//! `eject --undo`, with the exit statuses the other ports' tools share.

use std::path::PathBuf;
use std::process::{Command, Output};

const MODEL: &str = r#"{ "metadata.root": { "package": "shop", "children": [
  { "object.entity": { "name": "Order", "children": [
    { "source.rdb": { "@table": "orders" } },
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

    /// An empty directory: no project yet.
    fn empty(tag: &str) -> Self {
        let p = Self::new(tag);
        std::fs::remove_dir_all(p.0.join(".metaobjects")).unwrap();
        std::fs::remove_dir_all(p.0.join("metaobjects")).unwrap();
        p
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_env(args, &[])
    }

    fn run_env(&self, args: &[&str], env: &[(&str, &str)]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_cargo-meta"))
            .args(args)
            .current_dir(&self.0)
            // The suite's own environment must not decide what a test sees.
            .env_remove("CI")
            // An owned generator crate is a real cargo build: keep it in the workspace's
            // target directory so the engine builds once across runs, and unoptimized.
            .env(
                "CARGO_TARGET_DIR",
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/owned-check"),
            )
            .env("CARGO_PROFILE_DEV_OPT_LEVEL", "0")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .envs(env.iter().copied())
            .output()
            .expect("cargo-meta starts")
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.0.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    fn write(&self, rel: &str, text: &str) {
        let path = self.0.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn exists(&self, rel: &str) -> bool {
        self.0.join(rel).exists()
    }

    /// Every generated file with its bytes.
    fn generated(&self) -> std::collections::BTreeMap<String, String> {
        fn walk(
            dir: &std::path::Path,
            base: &std::path::Path,
            out: &mut std::collections::BTreeMap<String, String>,
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
                    out.insert(rel, std::fs::read_to_string(&path).unwrap());
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(&self.0.join("generated"), &self.0, &mut out);
        out
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

fn ok(o: &Output) -> String {
    assert!(
        o.status.success(),
        "exit {:?}\n{}\n{}",
        o.status.code(),
        text(&o.stdout),
        text(&o.stderr)
    );
    text(&o.stdout)
}

#[test]
fn cargo_meta_gen_writes_the_crates_then_skips() {
    let p = Project::new("gen");
    let out = ok(&p.run(&["meta", "gen", "--timings"]));
    assert!(out.contains("gen: ") && out.contains(" created"), "{out}");
    assert!(out.contains("render") && out.contains("write"), "{out}");
    assert!(
        out.contains("  created generated/shop/src/order.rs"),
        "{out}"
    );
    assert!(
        out.contains("changed crates: ") && out.contains("cargo check -p "),
        "{out}"
    );
    let order = p.read("generated/shop/src/order.rs");
    assert!(order.contains("pub struct Order"), "{order}");
    assert!(order.contains("pub note: Option<String>"), "{order}");

    let out = ok(&p.run(&["meta", "gen"]));
    assert!(out.contains("skipped, nothing changed"), "{out}");
    assert!(
        !out.contains("changed crates"),
        "a skip reports no change: {out}"
    );
}

#[test]
fn the_direct_spelling_works_and_out_moves_the_output() {
    let p = Project::new("direct");
    ok(&p.run(&["gen", "--out", "crates"]));
    assert!(p.exists("crates/shop/Cargo.toml"));
    assert!(!p.exists("generated"));
    // verify takes the same --out, or it would look in the default place.
    ok(&p.run(&["verify", "--out", "crates"]));
    assert_eq!(p.run(&["verify"]).status.code(), Some(1));
}

#[test]
fn a_hand_edit_makes_gen_fail_and_name_the_file() {
    let p = Project::new("edit");
    ok(&p.run(&["meta", "gen"]));
    p.write("generated/shop/src/order.rs", "// mine\n");
    let r = p.run(&["meta", "gen", "--force"]);
    assert_eq!(r.status.code(), Some(1));
    assert!(
        text(&r.stderr).contains("generated/shop/src/order.rs"),
        "{}",
        text(&r.stderr)
    );
    assert_eq!(p.read("generated/shop/src/order.rs"), "// mine\n");
}

#[test]
fn a_model_that_does_not_load_exits_1_and_writes_nothing() {
    let p = Project::new("broken");
    p.write("metaobjects/meta.shop.json", "{ not json");
    for command in ["gen", "verify"] {
        let r = p.run(&["meta", command]);
        assert_eq!(r.status.code(), Some(1), "{command}");
        assert!(!text(&r.stderr).is_empty());
    }
    assert!(!p.exists("generated"));
}

#[test]
fn usage_errors_exit_2_and_help_exits_0() {
    let p = Project::new("usage");
    assert_eq!(p.run(&["meta", "frobnicate"]).status.code(), Some(2));
    let r = p.run(&["meta", "gen", "--nope"]);
    assert_eq!(r.status.code(), Some(2));
    assert!(
        text(&r.stderr).contains("unknown flag --nope for `cargo meta gen`. Valid flags: --force,"),
        "{}",
        text(&r.stderr)
    );
    assert!(!p.exists("generated"), "a usage error writes nothing");
    let h = p.run(&["meta", "--help"]);
    assert!(h.status.success());
    assert!(text(&h.stdout).contains("cargo meta gen"));
    let v = p.run(&["meta", "--version"]);
    assert_eq!(text(&v.stdout), concat!(env!("CARGO_PKG_VERSION"), "\n"));
}

#[test]
fn init_scaffolds_a_project_that_loads_and_never_overwrites() {
    let p = Project::empty("init");
    let out = ok(&p.run(&["meta", "init"]));
    for rel in [
        ".metaobjects/config.json",
        ".metaobjects/.gitignore",
        "metaobjects/meta.app.yaml",
        "metaobjects.config.json",
    ] {
        assert!(out.contains(&format!("wrote {rel}")), "{out}");
        assert!(p.exists(rel));
    }
    assert!(out.contains("next: "), "{out}");
    let config: serde_json::Value =
        serde_json::from_str(&p.read(".metaobjects/config.json")).unwrap();
    assert_eq!(config["schema_version"], 1);
    assert_eq!(config["api"]["pagination"]["maxLimit"], 1000);

    // The scaffold is a project the tool itself accepts, and an empty model is in sync.
    ok(&p.run(&["meta", "gen"]));
    ok(&p.run(&["meta", "verify", "--full"]));

    // A second init changes nothing and says so.
    p.write(".metaobjects/config.json", "{ \"schema_version\": 1 }");
    let out = ok(&p.run(&["meta", "init"]));
    assert!(
        out.contains("kept .metaobjects/config.json (already exists)"),
        "{out}"
    );
    assert!(!out.contains("wrote "), "{out}");
    assert_eq!(
        p.read(".metaobjects/config.json"),
        "{ \"schema_version\": 1 }"
    );
}

#[test]
fn init_writes_the_generator_list_and_gen_list_shows_it_against_what_is_available() {
    let p = Project::empty("init-list");
    ok(&p.run(&["meta", "init"]));
    let list: serde_json::Value = serde_json::from_str(&p.read("metaobjects.config.json")).unwrap();
    assert_eq!(
        list["generators"],
        serde_json::json!(["entity", "client", "commands"])
    );
    let out = ok(&p.run(&["meta", "gen", "--list"]));
    assert!(
        out.contains("metaobjects.config.json runs: entity, client, commands"),
        "{out}"
    );
    assert_eq!(out.matches("[configured]").count(), 3, "{out}");
    // An edited list is never overwritten by a second init.
    p.write(
        "metaobjects.config.json",
        "{ \"generators\": [\"entity\"] }",
    );
    let out = ok(&p.run(&["meta", "init"]));
    assert!(
        out.contains("kept metaobjects.config.json (already exists)"),
        "{out}"
    );
    let out = ok(&p.run(&["meta", "gen", "--list"]));
    assert!(out.contains("runs: entity\n"), "{out}");
    assert_eq!(out.matches("[not configured]").count(), 2, "{out}");
}

#[test]
fn the_generator_list_changes_what_runs_without_an_eject() {
    let p = Project::new("list-narrows");
    ok(&p.run(&["meta", "gen"]));
    let full = p.generated();
    assert!(full.keys().any(|k| k.contains("shop_client/")), "{full:?}");
    assert!(full.keys().any(|k| k.contains("shop_cli/")), "{full:?}");

    // Leave `commands` out: its crates are swept, the rest is untouched.
    p.write(
        "metaobjects.config.json",
        "{ \"generators\": [\"entity\", \"client\"] }",
    );
    ok(&p.run(&["meta", "gen"]));
    let narrowed = p.generated();
    assert!(
        !narrowed.keys().any(|k| k.contains("shop_cli/")),
        "{narrowed:?}"
    );
    assert!(narrowed.keys().any(|k| k.contains("shop_client/")));
    ok(&p.run(&["meta", "verify", "--full"]));
    assert!(!p.exists("codegen"), "no eject happened");

    // `--generators` picks from the list, not past it.
    let out = p.run(&["meta", "gen", "--generators", "commands"]);
    assert_eq!(out.status.code(), Some(1));
    let err = text(&out.stderr);
    assert!(
        err.contains("commands is not in the \"generators\" list"),
        "{err}"
    );

    // Put it back and the crates come back.
    p.write(
        "metaobjects.config.json",
        "{ \"generators\": [\"entity\", \"client\", \"commands\"] }",
    );
    ok(&p.run(&["meta", "gen"]));
    assert_eq!(p.generated(), full);
}

#[test]
fn a_generator_list_that_cannot_be_used_fails_by_name_and_writes_nothing() {
    let p = Project::new("list-bad");
    for (list, wants) in [
        (
            "{ \"generators\": [\"nope\"] }",
            "\"nope\", which is not available",
        ),
        (
            "{ \"generators\": [\"client\"] }",
            "\"client\" without \"entity\"",
        ),
        (
            "{ \"generators\": [\"entity\"], \"layers\": [] }",
            "unknown key \"layers\"",
        ),
        ("{ \"generators\": ", "not valid JSON"),
    ] {
        p.write("metaobjects.config.json", list);
        for args in [
            vec!["meta", "gen"],
            vec!["meta", "verify"],
            vec!["meta", "gen", "--list"],
        ] {
            let out = p.run(&args);
            assert_eq!(out.status.code(), Some(1), "{list} {args:?}");
            let err = text(&out.stderr);
            assert!(err.contains(wants), "{list}: {err}");
            assert!(err.contains("metaobjects.config.json"), "{err}");
        }
        assert!(!p.exists("generated"), "nothing written for {list}");
    }
}

#[test]
fn init_does_not_add_an_empty_model_beside_one_that_exists() {
    let p = Project::new("init-existing");
    std::fs::remove_dir_all(p.0.join(".metaobjects")).unwrap();
    let out = ok(&p.run(&["meta", "init"]));
    assert!(out.contains("wrote .metaobjects/config.json"), "{out}");
    assert!(!p.exists("metaobjects/meta.app.yaml"));
    assert_eq!(p.run(&["meta", "init", "stray"]).status.code(), Some(2));
}

#[test]
fn verify_is_clean_after_gen_names_drift_and_writes_nothing() {
    let p = Project::new("verify");
    // Before any gen every file is missing.
    let r = p.run(&["meta", "verify"]);
    assert_eq!(r.status.code(), Some(1));
    assert!(
        text(&r.stderr).contains("  missing: generated/shop/src/order.rs"),
        "{}",
        text(&r.stderr)
    );
    assert!(
        !p.exists("generated") && !p.exists(".metaobjects/.gen-state"),
        "verify writes nothing"
    );

    ok(&p.run(&["meta", "gen"]));
    let out = ok(&p.run(&["meta", "verify"]));
    assert!(
        out.contains("unchanged since the last gen; pass --full"),
        "{out}"
    );
    let out = ok(&p.run(&["meta", "verify", "--codegen", "--full"]));
    assert!(
        out.contains("cargo meta verify: in sync (") && out.contains("file(s))."),
        "{out}"
    );
    // A build server always renders.
    let out = ok(&p.run_env(&["meta", "verify"], &[("CI", "true")]));
    assert!(out.contains("file(s))."), "{out}");

    p.write("generated/shop/src/order.rs", "// mine\n");
    let before = p.generated();
    let r = p.run(&["meta", "verify"]);
    assert_eq!(r.status.code(), Some(1));
    let err = text(&r.stderr);
    assert!(
        err.contains("error: generated code is out of sync with metadata."),
        "{err}"
    );
    assert!(
        err.contains("  drifted: generated/shop/src/order.rs"),
        "{err}"
    );
    assert!(
        err.contains("regenerate (cargo meta gen) and commit the result."),
        "{err}"
    );
    assert_eq!(p.generated(), before);

    assert_eq!(p.run(&["meta", "verify", "--db"]).status.code(), Some(2));
}

#[test]
fn an_object_that_goes_away_has_its_files_removed_unless_one_was_edited() {
    let two = MODEL.replace(
        "] } }\n] } }",
        "] } },\n  { \"object.value\": { \"name\": \"Tag\", \"children\": [ { \"field.string\": { \"name\": \"label\" } } ] } }\n] } }",
    );
    assert_ne!(two, MODEL);
    let p = Project::new("orphan");
    p.write("metaobjects/meta.shop.json", &two);
    ok(&p.run(&["meta", "gen"]));
    assert!(p.exists("generated/shop/src/tag.rs"));

    // Pristine: gen removes it and the change report says so.
    p.write("metaobjects/meta.shop.json", MODEL);
    let r = p.run(&["meta", "verify"]);
    assert!(
        text(&r.stderr).contains(
            "  extra:   generated/shop/src/tag.rs (no generator emits it any more; gen deletes it)"
        ),
        "{}",
        text(&r.stderr)
    );
    let out = ok(&p.run(&["meta", "gen"]));
    assert!(out.contains("  removed generated/shop/src/tag.rs"), "{out}");
    assert!(!p.exists("generated/shop/src/tag.rs"));
    ok(&p.run(&["meta", "verify", "--full"]));

    // Edited: gen refuses to delete it, exits 1, and keeps saying so until it is dealt with.
    p.write("metaobjects/meta.shop.json", &two);
    ok(&p.run(&["meta", "gen"]));
    p.write("generated/shop/src/tag.rs", "// my notes\n");
    p.write("metaobjects/meta.shop.json", MODEL);
    for _ in 0..2 {
        let r = p.run(&["meta", "gen"]);
        assert_eq!(r.status.code(), Some(1));
        assert!(
            text(&r.stderr).contains("generated/shop/src/tag.rs"),
            "{}",
            text(&r.stderr)
        );
        assert_eq!(p.read("generated/shop/src/tag.rs"), "// my notes\n");
    }
    let err = text(&p.run(&["meta", "verify"]).stderr);
    assert!(err.contains("and it was edited by hand)"), "{err}");
    assert!(
        err.contains("`cargo meta gen` will NOT delete them"),
        "{err}"
    );
    std::fs::remove_file(p.0.join("generated/shop/src/tag.rs")).unwrap();
    ok(&p.run(&["meta", "gen"]));
    ok(&p.run(&["meta", "verify", "--full"]));
}

#[test]
fn gen_list_names_the_generators_and_how_an_owned_copy_compares() {
    let p = Project::new("list");
    let out = ok(&p.run(&["meta", "gen", "--list"]));
    for name in ["entity", "client", "commands"] {
        assert!(
            out.lines().any(|l| l.starts_with(&format!("{name} - "))),
            "{out}"
        );
    }
    assert!(!out.contains("owned"), "{out}");
    assert!(!p.exists("generated"), "--list generates nothing");
    ok(&p.run(&["meta", "eject", "entity"]));
    let out = ok(&p.run(&["meta", "eject", "--list"]));
    assert!(out.contains("[owned: identical]"), "{out}");
    let copy = p.read("codegen/generators/entity.rs");
    p.write(
        "codegen/generators/entity.rs",
        &format!("{copy}\n// mine\n"),
    );
    let out = ok(&p.run(&["meta", "gen", "--list"]));
    assert!(
        out.contains("[owned: DIFFERS: 0 behind, 1 of your own]"),
        "{out}"
    );
}

/// The manifest `eject` writes names no machine: not the checkout the binary was built in, and
/// not the user's home. The default is the exact crates.io release; `--engine` is a choice.
#[test]
fn eject_writes_a_manifest_that_names_no_machine_and_takes_the_engine_by_flag() {
    let built_in = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let version = env!("CARGO_PKG_VERSION");

    let p = Project::new("eject-engine-default");
    let out = ok(&p.run(&["meta", "eject", "entity"]));
    let manifest = p.read("codegen/Cargo.toml");
    assert!(!manifest.contains(&built_in), "{manifest}");
    assert!(!out.contains(&built_in), "{out}");
    assert!(
        !manifest
            .lines()
            .any(|l| !l.starts_with('#') && l.contains("{ path =")),
        "{manifest}"
    );
    for name in ["metaobjects", "metaobjects-cli", "metaobjects-codegen"] {
        assert!(
            manifest.contains(&format!("{name} = \"={version}\"")),
            "{name}: {manifest}"
        );
    }
    assert!(
        out.contains(&format!("the engine is crates.io, exactly {version}")),
        "{out}"
    );

    // A checkout named relative to the project root is written relative to `codegen/`.
    let p = Project::new("eject-engine-path");
    ok(&p.run(&[
        "meta",
        "eject",
        "entity",
        "--engine",
        "../checkout/server/rust",
    ]));
    let manifest = p.read("codegen/Cargo.toml");
    assert!(
        manifest.contains("metaobjects = { path = \"../../checkout/server/rust/metaobjects\" }"),
        "{manifest}"
    );
    assert!(!manifest.contains(&built_in), "{manifest}");

    // A git revision.
    let p = Project::new("eject-engine-git");
    ok(&p.run(&[
        "meta",
        "eject",
        "entity",
        "--engine=https://example.com/mo.git#abc123",
    ]));
    let manifest = p.read("codegen/Cargo.toml");
    assert!(
        manifest.contains(
            "metaobjects-codegen = { git = \"https://example.com/mo.git\", rev = \"abc123\" }"
        ),
        "{manifest}"
    );
}

#[test]
fn eject_copies_the_generator_never_overwrites_and_undo_takes_back_only_identical_copies() {
    let p = Project::new("eject");
    assert_eq!(p.run(&["meta", "eject"]).status.code(), Some(2));
    let r = p.run(&["meta", "eject", "entity", "nope"]);
    assert_eq!(r.status.code(), Some(2));
    assert!(
        text(&r.stderr).contains(
            "unknown or non-ejectable generator(s): nope; ejectable: entity, client, commands"
        ),
        "{}",
        text(&r.stderr)
    );
    assert!(
        !p.exists("codegen"),
        "every name is checked before anything is written"
    );

    let out = ok(&p.run(&["meta", "eject", "entity"]));
    assert!(
        out.contains("ejected entity -> codegen/generators/entity.rs [created]"),
        "{out}"
    );
    for rel in [
        "codegen/Cargo.toml",
        "codegen/main.rs",
        "codegen/generators/entity.rs",
    ] {
        assert!(p.exists(rel), "{rel}");
    }
    assert!(
        p.read("codegen/main.rs")
            .contains("Box::new(generators::entity::EntityGenerator)")
    );

    // A second eject refuses; --force replaces the copy and still never touches the two
    // files the adopter owns outright.
    p.write("codegen/main.rs", "// my list\n");
    let r = p.run(&["meta", "eject", "entity"]);
    assert_eq!(r.status.code(), Some(1));
    assert!(
        text(&r.stderr).contains("already owned: codegen/generators/entity.rs"),
        "{}",
        text(&r.stderr)
    );
    p.write("codegen/generators/entity.rs", "// edited\n");
    let out = ok(&p.run(&["meta", "eject", "entity", "--force"]));
    assert!(out.contains("[replaced]"), "{out}");
    assert!(out.contains("replace `Box::new(metaobjects_codegen::EntityGenerator)` with `Box::new(generators::entity::EntityGenerator)`"), "{out}");
    assert_eq!(p.read("codegen/main.rs"), "// my list\n");
    assert!(
        p.read("codegen/generators/entity.rs")
            .contains("pub struct EntityGenerator")
    );

    // Undo: a copy that differs is refused by name; an identical one is removed.
    p.write("codegen/generators/entity.rs", "// edited\n");
    let r = p.run(&["meta", "eject", "--undo", "entity"]);
    assert_eq!(r.status.code(), Some(2));
    assert!(p.exists("codegen/generators/entity.rs"));
    let out = ok(&p.run(&["meta", "eject", "--undo"]));
    assert!(out.contains("nothing was removed"), "{out}");
    ok(&p.run(&["meta", "eject", "entity", "--force"]));
    let out = ok(&p.run(&["meta", "eject", "--undo"]));
    assert!(
        out.contains("removed codegen/generators/entity.rs"),
        "{out}"
    );
    assert!(out.contains("replace `Box::new(generators::entity::EntityGenerator)` with `Box::new(metaobjects_codegen::EntityGenerator)`"), "{out}");
    assert!(!p.exists("codegen/generators"));
    assert_eq!(
        p.read("codegen/main.rs"),
        "// my list\n",
        "undo never edits the list"
    );
    let r = p.run(&["meta", "eject", "--undo", "entity"]);
    assert_eq!(
        r.status.code(),
        Some(2),
        "nothing to undo for a named generator is a usage error"
    );
}

/// The ADR-0034 depth test. Ejected alone, the copy builds against the engine it was copied
/// from and writes byte-for-byte what the shipped generator writes; an edit to the copy
/// reaches the output through the same `cargo meta gen`; and `verify` runs the owned crate
/// too, so the gate and the generator can never disagree about what is current.
#[test]
fn an_ejected_generator_builds_and_writes_what_the_shipped_one_writes() {
    let shipped = Project::new("owned-shipped");
    ok(&shipped.run(&["meta", "gen"]));

    for crate_file in [
        "shop/src/order.rs",
        "shop_client/src/order.rs",
        "shop_cli/src/order.rs",
    ] {
        assert!(
            shipped.exists(&format!("generated/{crate_file}")),
            "every generator has output to compare"
        );
    }

    // Each generator ejected ALONE: a copy that leaned on a sibling generator's module, or on
    // anything outside the engine, would not build here.
    let own = |name: &str| {
        let p = Project::new(&format!("owned-{name}"));
        // Nothing is on crates.io yet, so the scratch crate builds against this checkout.
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        ok(&p.run(&["meta", "eject", name, "--engine", engine.to_str().unwrap()]));
        // The scratch crate resolves the versions the repository pins, without the network.
        std::fs::copy(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../Cargo.lock"),
            p.0.join("codegen/Cargo.lock"),
        )
        .unwrap();
        let out = ok(&p.run(&["meta", "gen"]));
        assert!(out.contains(" created"), "{out}");
        assert!(
            out.contains(&format!(
                "note: the owned copy of {name} is identical to the shipped generator"
            )),
            "{out}"
        );
        assert_eq!(p.generated(), shipped.generated(), "{name}");
        let out = ok(&p.run(&["meta", "gen"]));
        assert!(out.contains("skipped, nothing changed"), "{out}");
        ok(&p.run(&["meta", "verify", "--full"]));
        p
    };
    own("client");
    own("commands");
    let p = own("entity");

    // Own it: change what the copy emits.
    let copy = p.read("codegen/generators/entity.rs");
    let edited = copy.replace("pub const fn as_str(self)", "pub const fn wire_name(self)");
    assert_ne!(
        edited, copy,
        "the marker this test edits is still in the generator"
    );
    p.write("codegen/generators/entity.rs", &edited);
    // The gate sees the edit before gen runs: the output on disk is now stale.
    let stale = MODEL.replace(
        r#"{ "field.string": { "name": "note" } }"#,
        r#"{ "field.string": { "name": "note" } }, { "field.enum": { "name": "state", "@values": ["open", "done"] } }"#,
    );
    assert_ne!(stale, MODEL);
    p.write("metaobjects/meta.shop.json", &stale);
    assert_eq!(p.run(&["meta", "verify"]).status.code(), Some(1));
    let out = ok(&p.run(&["meta", "gen"]));
    assert!(
        out.contains("  updated generated/shop/src/order.rs"),
        "{out}"
    );
    assert!(
        !out.contains("note: the owned copy"),
        "an edited copy is not offered back: {out}"
    );
    let order = p.read("generated/shop/src/order.rs");
    assert!(
        order.contains("pub const fn wire_name(self)") && !order.contains("as_str"),
        "{order}"
    );
    ok(&p.run(&["meta", "verify"]));

    // An edit to the owned generator alone regenerates (ADR-0064, `owned-generator-edited`).
    p.write(
        "codegen/generators/entity.rs",
        &edited.replace("wire_name", "symbol"),
    );
    let out = ok(&p.run(&["meta", "gen"]));
    assert!(out.contains("did not skip: an input changed"), "{out}");
    assert!(
        p.read("generated/shop/src/order.rs")
            .contains("pub const fn symbol(self)")
    );
}

/// A stand-in owned crate with no dependencies, so the build is the compiler alone.
fn own_a_crate(p: &Project, package: &str, main: &str) {
    p.write(
        "codegen/Cargo.toml",
        &format!(
            "[package]\nname = \"{package}\"\nversion = \"0.0.0\"\nedition = \"2024\"\n\n\
             [[bin]]\nname = \"{package}\"\npath = \"main.rs\"\n\n[workspace]\n"
        ),
    );
    p.write("codegen/main.rs", main);
}

#[test]
fn an_owned_crate_that_breaks_exits_1_and_its_own_answers_pass_through() {
    // The contract is the one `docs/ports/rust.md` states: 0 in sync or done, 1 a failure or
    // drift, 2 a usage error. cargo answers 101 for a build that failed and Rust answers 101
    // for a panic; a script that reads 1 as "drift or failure" must not meet either.
    let broken = [
        (
            "panics",
            "fn main() {\n    panic!(\"a generator panicked\");\n}\n",
        ),
        (
            "does-not-compile",
            "fn main() {\n    let x: u32 = \"not a number\";\n}\n",
        ),
        (
            "exits-101",
            "fn main() {\n    std::process::exit(101);\n}\n",
        ),
        ("exits-3", "fn main() {\n    std::process::exit(3);\n}\n"),
    ];
    for (tag, main) in broken {
        let p = Project::new(&format!("owned-broken-{tag}"));
        own_a_crate(&p, &format!("codegen-{tag}"), main);
        for command in ["gen", "verify"] {
            let r = p.run(&["meta", command]);
            assert_eq!(
                r.status.code(),
                Some(1),
                "{tag}: `{command}` must fail with 1\n{}",
                text(&r.stderr)
            );
        }
        // What went wrong is still on the screen.
        let said = text(&p.run(&["meta", "gen"]).stderr);
        if tag == "panics" {
            assert!(said.contains("a generator panicked"), "{said}");
        }
        if tag == "does-not-compile" {
            assert!(said.contains("mismatched types"), "{said}");
        }
    }
    for code in [0, 1, 2] {
        let p = Project::new(&format!("owned-answers-{code}"));
        own_a_crate(
            &p,
            &format!("codegen-answers-{code}"),
            &format!("fn main() {{\n    std::process::exit({code});\n}}\n"),
        );
        assert_eq!(p.run(&["meta", "gen"]).status.code(), Some(code));
    }
}
