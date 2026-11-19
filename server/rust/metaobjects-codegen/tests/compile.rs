//! The generated crates build, are rustfmt-clean, and speak the wire form the model says.
//!
//! The small two-package model and the public fitness model are generated through the real
//! run engine into one scratch Cargo workspace, which `cargo check` builds with the real
//! compiler. A probe crate (hand-written here) then uses the generated types: it serializes
//! an order to JSON, parses it back, and walks a recursive structure and a cross-crate
//! reference, so a wrong `serde` attribute or a missing `Box` fails here and not in an
//! adopter's build.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::{FITNESS, Scratch, shop_files};
use metaobjects_codegen::{EntityGenerator, Generator, RunOptions, run};

fn target_dir() -> PathBuf {
    // The workspace's own target directory, so serde and its derive build once and later runs
    // reuse them. A separate sub-directory keeps this off the outer `cargo test`'s lock.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/gen-check")
}

fn cargo(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .args(args)
        .current_dir(dir)
        .env("CARGO_TARGET_DIR", target_dir())
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .output()
        .expect("cargo runs")
}

fn generate(project: &Scratch) {
    let generators: Vec<Box<dyn Generator>> = vec![Box::new(EntityGenerator)];
    let mut opts = RunOptions::new(project.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &generators).unwrap_or_else(|e| panic!("gen failed: {e}"));
}

fn copy_tree(from: &Path, to: &Path) {
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

/// A scratch workspace holding a copy of `from`'s `generated` tree, pinned to the
/// repository's lockfile so `--offline` resolves the same serde.
fn locked_ws(tag: &str, from: &Path) -> Scratch {
    let ws = Scratch::new(tag);
    copy_tree(&from.join("generated"), &ws.path().join("out"));
    ws.write(
        "Cargo.toml",
        "[workspace]\nresolver = \"2\"\nmembers = [\"out/*\"]\n",
    );
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../Cargo.lock"),
        ws.path().join("Cargo.lock"),
    )
    .unwrap();
    ws
}

const PROBE_MAIN: &str = r#"
use shop::{Address, Category, Currency, Order, OrderStatus};
use shop_billing::Invoice;

fn main() {
    let order = Order {
        id: 7,
        created_at: "2026-01-02T03:04:05Z".to_string(),
        status: OrderStatus::InFlight,
        currency: Currency::GbpPound,
        total: 1999,
        tax_rate: None,
        r#type: Some("rush".to_string()),
        tags: Some(vec!["a".to_string(), "b".to_string()]),
        attributes: None,
        ship_to: Address { street: "1 Main".to_string(), zip_code: Some("90210".to_string()) },
        bill_to: None,
        history: None,
    };
    let json = serde_json::to_string(&order).unwrap();
    println!("{json}");
    let back: Order = serde_json::from_str(&json).unwrap();
    assert_eq!(back, order);

    let parent = Category {
        id: 1,
        created_at: "t".to_string(),
        title: "root".to_string(),
        parent: None,
        subcategories: None,
    };
    let child = Category {
        id: 2,
        created_at: "t".to_string(),
        title: "leaf".to_string(),
        parent: Some(Box::new(parent)),
        subcategories: Some(Vec::new()),
    };
    let child_json = serde_json::to_string(&child).unwrap();
    assert_eq!(serde_json::from_str::<Category>(&child_json).unwrap(), child);

    let invoice = Invoice { id: 9, order, currency: Some(Currency::Eur) };
    println!("{}", serde_json::to_string(&invoice).unwrap());
    assert_eq!(OrderStatus::Done.as_str(), "done");
    assert!(serde_json::from_str::<OrderStatus>("\"IN-FLIGHT\"").is_err());
}
"#;

#[test]
fn generated_crates_compile_are_formatted_and_round_trip_through_serde() {
    let shop = Scratch::project("compile-shop", &shop_files());
    generate(&shop);
    let fitness = Scratch::project(
        "compile-fitness",
        &[("metaobjects/meta.fitness.json", FITNESS)],
    );
    generate(&fitness);

    let ws = Scratch::new("compile-ws");
    copy_tree(&shop.path().join("generated"), &ws.path().join("shop-out"));
    copy_tree(
        &fitness.path().join("generated"),
        &ws.path().join("fitness-out"),
    );
    ws.write(
        "Cargo.toml",
        "[workspace]\nresolver = \"2\"\nmembers = [\"shop-out/*\", \"fitness-out/*\", \"probe\"]\n",
    );
    // The scratch workspace resolves the same serde the repository does.
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../Cargo.lock"),
        ws.path().join("Cargo.lock"),
    )
    .unwrap();
    ws.write(
        "probe/Cargo.toml",
        "[package]\nname = \"probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\npublish = false\n\n\
         [dependencies]\nshop = { path = \"../shop-out/shop\" }\n\
         shop_billing = { path = \"../shop-out/shop_billing\" }\n\
         fitness = { path = \"../fitness-out/fitness\" }\nserde_json = \"1\"\n",
    );
    ws.write("probe/src/main.rs", PROBE_MAIN);

    // rustfmt: the generated files must already be in their formatted form.
    for lib in [
        "shop-out/shop",
        "shop-out/shop_billing",
        "fitness-out/fitness",
    ] {
        let out = Command::new("rustfmt")
            .args(["--check", "--edition", "2021", "src/lib.rs"])
            .current_dir(ws.path().join(lib))
            .output()
            .expect("rustfmt runs");
        assert!(
            out.status.success(),
            "{lib} is not rustfmt-clean:\n{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    let check = cargo(
        ws.path(),
        &["check", "--offline", "--workspace", "--all-targets", "-q"],
    );
    assert!(
        check.status.success(),
        "cargo check failed:\n{}",
        String::from_utf8_lossy(&check.stderr)
    );

    let probe = cargo(ws.path(), &["run", "--offline", "-q", "-p", "probe"]);
    assert!(
        probe.status.success(),
        "the probe failed:\n{}",
        String::from_utf8_lossy(&probe.stderr)
    );
    let stdout = String::from_utf8_lossy(&probe.stdout);
    let mut lines = stdout.lines();
    assert_eq!(
        lines.next().unwrap(),
        r#"{"id":7,"createdAt":"2026-01-02T03:04:05Z","status":"IN_FLIGHT","currency":"gbp_pound","total":1999,"taxRate":null,"type":"rush","tags":["a","b"],"attributes":null,"shipTo":{"street":"1 Main","zipCode":"90210"},"billTo":null,"history":null}"#
    );
    assert!(
        lines
            .next()
            .unwrap()
            .starts_with(r#"{"id":9,"order":{"id":7,"#)
    );
}

#[test]
fn a_named_first_run_leaves_a_crate_the_real_compiler_accepts() {
    // The regression: a named run on a never-generated project used to write lib.rs
    // declaring every module of the crate while emitting only the named struct's file,
    // so the crate could not build. The oracle is `cargo check` itself: the crate the
    // run leaves behind must compile.
    let p = Scratch::project("compile-named", &shop_files());
    let generators: Vec<Box<dyn Generator>> = vec![Box::new(EntityGenerator)];
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    opts.entities = vec!["Order".to_string()];
    run(&opts, &generators).unwrap_or_else(|e| panic!("named gen failed: {e}"));
    // The whole crate came out: the shared enum beside the named struct, and nothing
    // of the crate that holds no named object.
    assert!(p.exists("generated/shop/src/currency.rs"));
    assert!(p.exists("generated/shop/src/order.rs"));
    assert!(!p.exists("generated/shop_billing"));

    let ws = locked_ws("compile-named-ws", p.path());
    let check = cargo(ws.path(), &["check", "--offline", "--workspace", "-q"]);
    assert!(
        check.status.success(),
        "cargo check failed on a named first run's crate:\n{}",
        String::from_utf8_lossy(&check.stderr)
    );
}

#[test]
fn a_named_first_run_across_a_crate_dependency_leaves_a_buildable_workspace() {
    // `Invoice` lives in `shop_billing`, whose manifest declares a path dependency on the
    // `shop` crate (Invoice.order and Invoice.currency both reach into `shop`), so the run
    // must emit that dependency crate too or its own output cannot build. The oracle is
    // `cargo check` itself.
    let p = Scratch::project("compile-named-dep", &shop_files());
    let generators: Vec<Box<dyn Generator>> = vec![Box::new(EntityGenerator)];
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    opts.entities = vec!["Invoice".to_string()];
    run(&opts, &generators).unwrap_or_else(|e| panic!("named gen failed: {e}"));
    assert!(p.exists("generated/shop_billing/src/invoice.rs"));
    assert!(
        p.exists("generated/shop/src/order.rs"),
        "the dependency crate came out too"
    );

    let ws = locked_ws("compile-named-dep-ws", p.path());
    let check = cargo(ws.path(), &["check", "--offline", "--workspace", "-q"]);
    assert!(
        check.status.success(),
        "cargo check failed on a named first run across a crate dependency:\n{}",
        String::from_utf8_lossy(&check.stderr)
    );
}

#[test]
fn a_named_first_run_follows_a_three_deep_crate_dependency_chain() {
    // A depends on B depends on C, one crate each; naming an object of A must bring out
    // all three crates, or the chain's middle manifest points at a crate that is not there.
    let a = r#"{ "metadata.root": { "package": "chain::a", "children": [
      { "object.entity": { "name": "A", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } },
        { "field.object": { "name": "b", "@required": true, "@objectRef": "chain::b::B" } }
      ] } } ] } }"#;
    let b = r#"{ "metadata.root": { "package": "chain::b", "children": [
      { "object.entity": { "name": "B", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } },
        { "field.object": { "name": "c", "@required": true, "@objectRef": "chain::c::C" } }
      ] } } ] } }"#;
    let c = r#"{ "metadata.root": { "package": "chain::c", "children": [
      { "object.entity": { "name": "C", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ] } } ] } }"#;
    let p = Scratch::project(
        "compile-chain",
        &[
            ("metaobjects/meta.chain-a.json", a),
            ("metaobjects/meta.chain-b.json", b),
            ("metaobjects/meta.chain-c.json", c),
        ],
    );
    let generators: Vec<Box<dyn Generator>> = vec![Box::new(EntityGenerator)];
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    opts.entities = vec!["A".to_string()];
    run(&opts, &generators).unwrap_or_else(|e| panic!("named gen failed: {e}"));
    for crate_file in [
        "generated/chain_a/src/a.rs",
        "generated/chain_b/src/b.rs",
        "generated/chain_c/src/c.rs",
    ] {
        assert!(p.exists(crate_file), "{crate_file} is missing");
    }

    let ws = locked_ws("compile-chain-ws", p.path());
    let check = cargo(ws.path(), &["check", "--offline", "--workspace", "-q"]);
    assert!(
        check.status.success(),
        "cargo check failed on a named first run's dependency chain:\n{}",
        String::from_utf8_lossy(&check.stderr)
    );
}
