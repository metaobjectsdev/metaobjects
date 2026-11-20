//! The shared generation-skip corpus (ADR-0064), run against the Rust engine.
//!
//! `fixtures/codegen-skip-conformance/cases.json` lists, for each kind of change, what the next
//! `gen` must do (skip: render and write nothing; or regenerate) and what a local
//! `verify --codegen` may do (answer from the stored key, or render). Every port runs every
//! case against its own project shape, and this runner asks both questions, each on a fresh
//! project. A case id this runner does not know FAILS, so a case added for the other ports
//! reaches this one.
//!
//! Where Rust differs it says so below, in the one table of `Fit` values:
//! - `Applies` runs the case and checks the corpus's `gen` and `verify` columns.
//! - `NotApplicable` names why the case cannot arise (there are no templates and no merge
//!   engine in the Rust port).
//! - `generated-file-edited` runs, and "regenerate" means the run is attempted and the edited file
//!   is REFUSED (the run fails and names it): Rust has no three-way merge, as Python has none.

mod common;

use std::thread::sleep;
use std::time::Duration;

use common::{Scratch, shop_files};
use metaobjects_codegen::engine::{OWNED_GENERATORS_DIR, OWNED_MAIN, OWNED_MANIFEST, VerifyReport};
use metaobjects_codegen::generator::{EmittedFile, GenContext, GenError};
use metaobjects_codegen::{EntityGenerator, Generator, Outcome, RunError, RunOptions, run, verify};
use serde_json::{Value, json};

const CASES: &str = include_str!("../../../../fixtures/codegen-skip-conformance/cases.json");

enum Fit {
    Applies,
    NotApplicable(&'static str),
}

fn fit(id: &str) -> Fit {
    match id {
        "template-edited" | "template-added" => Fit::NotApplicable(
            "the Rust port has no templates (the prompt pillar is a later phase)",
        ),
        "hand-edit-kept" => Fit::NotApplicable(
            "a hand edit is never kept: with no merge engine, the run refuses the file instead",
        ),
        _ => Fit::Applies,
    }
}

/// The entity generator with the knobs the corpus needs to turn.
struct Probe {
    identity: &'static str,
    cacheable: bool,
    extras: Vec<String>,
    fail: bool,
}

impl Default for Probe {
    fn default() -> Self {
        Probe {
            identity: "entity",
            cacheable: true,
            extras: Vec::new(),
            fail: false,
        }
    }
}

impl Generator for Probe {
    fn name(&self) -> &str {
        "entity"
    }
    fn identity(&self) -> String {
        format!("{}:{}", EntityGenerator.identity(), self.identity)
    }
    fn cacheable(&self) -> bool {
        self.cacheable
    }
    fn extra_inputs(&self) -> Vec<String> {
        self.extras.clone()
    }
    fn generate(&self, ctx: &GenContext<'_>) -> Result<Vec<EmittedFile>, GenError> {
        if self.fail {
            return Err(GenError::new(
                "ERR_PROBE",
                "the probe generator was told to fail",
            ));
        }
        EntityGenerator.generate(ctx)
    }
}

type RunResult = Result<metaobjects_codegen::RunReport, RunError>;

/// Which of the corpus's two questions a case is being asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ask {
    /// What the next `gen` does.
    Gen,
    /// What a local `verify --codegen` does, before any further `gen`.
    Verify,
}

enum Answer {
    Gen(RunResult),
    Verify(Result<VerifyReport, RunError>),
}

impl Ask {
    fn go(self, p: &Scratch, probe: Probe, tweak: impl FnOnce(&mut RunOptions)) -> Answer {
        match self {
            Ask::Gen => Answer::Gen(go(p, probe, tweak)),
            Ask::Verify => {
                let mut opts = RunOptions::new(p.path());
                tweak(&mut opts);
                Answer::Verify(verify(&opts, &[Box::new(probe) as Box<dyn Generator>]))
            }
        }
    }
}

fn go(p: &Scratch, probe: Probe, tweak: impl FnOnce(&mut RunOptions)) -> RunResult {
    let mut opts = RunOptions::new(p.path());
    tweak(&mut opts);
    run(&opts, &[Box::new(probe) as Box<dyn Generator>])
}

fn tick() {
    sleep(Duration::from_millis(30));
}

fn shop_json() -> Value {
    serde_json::from_str(common::SHOP).unwrap()
}

fn children_mut(doc: &mut Value) -> &mut Vec<Value> {
    doc["metadata.root"]["children"].as_array_mut().unwrap()
}

fn object_named<'a>(doc: &'a mut Value, name: &str) -> &'a mut Value {
    children_mut(doc)
        .iter_mut()
        .find(|c| {
            c.as_object()
                .is_some_and(|o| o.values().any(|b| b["name"] == name))
        })
        .unwrap_or_else(|| panic!("no object {name}"))
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
}

fn add_field(doc: &mut Value, object: &str, field: Value) {
    object_named(doc, object)["children"]
        .as_array_mut()
        .unwrap()
        .push(field);
}

fn write_json(p: &Scratch, rel: &str, doc: &Value) {
    p.write(rel, &serde_json::to_string_pretty(doc).unwrap());
}

const SHOP_FILE: &str = "metaobjects/meta.shop.json";
const BILLING_FILE: &str = "metaobjects/meta.billing.json";
const KEY_FILE: &str = ".metaobjects/.gen-state/.fingerprint-rust.json";

/// Apply the case's change and run the next `gen`.
fn next_run(id: &str, p: &Scratch, ask: Ask) -> Answer {
    match id {
        "no-change" => ask.go(p, Probe::default(), |_| {}),
        "metadata-touched" => {
            tick();
            p.write(SHOP_FILE, &p.read(SHOP_FILE));
            ask.go(p, Probe::default(), |_| {})
        }
        "unrelated-file-edited" => {
            p.write("README.md", "# notes\nedited\n");
            ask.go(p, Probe::default(), |_| {})
        }
        "metadata-reformatted" => {
            // serde_json sorts keys and re-indents: other whitespace, other key order.
            let doc = shop_json();
            write_json(p, SHOP_FILE, &doc);
            assert_ne!(p.read(SHOP_FILE), common::SHOP);
            ask.go(p, Probe::default(), |_| {})
        }
        "metadata-moved" => {
            let mut doc = shop_json();
            let moved = {
                let kids = children_mut(&mut doc);
                let at = kids
                    .iter()
                    .position(|c| {
                        c.as_object()
                            .is_some_and(|o| o.values().any(|b| b["name"] == "Category"))
                    })
                    .unwrap();
                kids.remove(at)
            };
            write_json(p, SHOP_FILE, &doc);
            p.write(
                "metaobjects/meta.category.json",
                &serde_json::to_string_pretty(&json!({
                    "metadata.root": { "package": "shop", "children": [moved] }
                }))
                .unwrap(),
            );
            ask.go(p, Probe::default(), |_| {})
        }
        "metadata-edited" => {
            let mut doc = shop_json();
            add_field(
                &mut doc,
                "Address",
                json!({ "field.string": { "name": "country" } }),
            );
            write_json(p, SHOP_FILE, &doc);
            ask.go(p, Probe::default(), |_| {})
        }
        "metadata-added" => {
            p.write(
                "metaobjects/meta.extra.json",
                r#"{ "metadata.root": { "package": "shop", "children": [
                  { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "text" } } ] } } ] } }"#,
            );
            ask.go(p, Probe::default(), |_| {})
        }
        "metadata-removed" => {
            std::fs::remove_file(p.path().join(BILLING_FILE)).unwrap();
            ask.go(p, Probe::default(), |_| {})
        }
        "parent-edited" => {
            let mut doc = shop_json();
            add_field(
                &mut doc,
                "Base",
                json!({ "field.string": { "name": "owner" } }),
            );
            write_json(p, SHOP_FILE, &doc);
            ask.go(p, Probe::default(), |_| {})
        }
        // Rust has no codegen config file: the generator set and each generator's identity
        // (its options) are the config, and a changed identity is a changed config.
        "config-edited" => ask.go(
            p,
            Probe {
                identity: "options-changed",
                ..Probe::default()
            },
            |_| {},
        ),
        "project-config-edited" => {
            p.write(
                ".metaobjects/config.json",
                r#"{ "schema_version": 1, "sources": [{ "path": "metaobjects" }] }"#,
            );
            ask.go(p, Probe::default(), |_| {})
        }
        "engine-changed" => {
            // The engine's identity is its built source hash, a compile-time constant a test
            // cannot change; what can be shown is that a stored key from a different engine
            // build no longer matches.
            let mut key: Value = serde_json::from_str(&p.read(KEY_FILE)).unwrap();
            key["fingerprint"] = json!("0".repeat(64));
            p.write(KEY_FILE, &serde_json::to_string_pretty(&key).unwrap());
            ask.go(p, Probe::default(), |_| {})
        }
        "selection-changed" => ask.go(p, Probe::default(), |o| o.strict = true),
        "declared-extra-edited" => {
            // The stored run must have declared the extra; rerun once with it, then edit it.
            p.write("seed.txt", "one");
            let first = go(
                p,
                Probe {
                    extras: vec!["seed.txt".into()],
                    ..Probe::default()
                },
                |_| {},
            );
            assert_eq!(first.unwrap().outcome, Outcome::Generated);
            p.write("seed.txt", "two");
            ask.go(
                p,
                Probe {
                    extras: vec!["seed.txt".into()],
                    ..Probe::default()
                },
                |_| {},
            )
        }
        "uncacheable-generator" => ask.go(
            p,
            Probe {
                cacheable: false,
                ..Probe::default()
            },
            |_| {},
        ),
        "generated-file-deleted" => {
            std::fs::remove_file(p.path().join("generated/shop/src/order.rs")).unwrap();
            ask.go(p, Probe::default(), |_| {})
        }
        "generated-file-edited" => {
            let path = "generated/shop/src/order.rs";
            p.write(path, &format!("{}// by hand\n", p.read(path)));
            ask.go(p, Probe::default(), |_| {})
        }
        "fingerprint-missing" => {
            std::fs::remove_file(p.path().join(KEY_FILE)).unwrap();
            ask.go(p, Probe::default(), |_| {})
        }
        "force" => ask.go(p, Probe::default(), |o| o.force = true),
        // `CI` is read by the command line, which turns it into `--full` for `verify` and
        // leaves `gen` alone (`ci_forces_render` in the CLI's own tests pins that half).
        "ci" => ask.go(p, Probe::default(), |o| o.force = ask == Ask::Verify),
        "owned-generator-edited" => {
            // The stored run must have seen the owned crate; own one, run, then edit it.
            p.write(OWNED_MANIFEST, "[package]\nname = \"codegen\"\n");
            p.write(OWNED_MAIN, "fn main() {}\n");
            let copy = format!("{OWNED_GENERATORS_DIR}/entity.rs");
            p.write(&copy, "// the owned generator\n");
            let owned = go(p, Probe::default(), |_| {}).unwrap();
            assert_eq!(
                owned.outcome,
                Outcome::Generated,
                "owning a generator is a changed input"
            );
            let again = go(p, Probe::default(), |_| {}).unwrap();
            assert_eq!(
                again.outcome,
                Outcome::Skipped,
                "an untouched owned crate is no change"
            );
            p.write(&copy, "// the owned generator, edited\n");
            ask.go(p, Probe::default(), |_| {})
        }
        "failed-run" => {
            let original = p.read(SHOP_FILE);
            let mut doc = shop_json();
            add_field(
                &mut doc,
                "Address",
                json!({ "field.string": { "name": "country" } }),
            );
            write_json(p, SHOP_FILE, &doc);
            let failed = go(
                p,
                Probe {
                    fail: true,
                    ..Probe::default()
                },
                |_| {},
            );
            assert!(
                matches!(failed, Err(RunError::Generator(_))),
                "the probe run must fail"
            );
            p.write(SHOP_FILE, &original);
            ask.go(p, Probe::default(), |_| {})
        }
        other => panic!(
            "the skip-conformance corpus has a case this port does not know: {other}. \
             Add it to `fit` (and `next_run`) so it reaches the Rust port."
        ),
    }
}

#[test]
fn every_case_in_the_shared_corpus_behaves_as_it_says() {
    let corpus: Value = serde_json::from_str(CASES).unwrap();
    assert_eq!(corpus["version"], 1, "the corpus changed shape");
    let cases = corpus["cases"].as_array().unwrap();
    assert!(cases.len() >= 25);
    let mut ran = 0;
    for case in cases {
        let id = case["id"].as_str().unwrap();
        match fit(id) {
            Fit::NotApplicable(why) => {
                assert!(!why.is_empty());
                continue;
            }
            Fit::Applies => {}
        }
        let fresh = |tag: &str| {
            let p = Scratch::project(&format!("skip-{tag}-{id}"), &shop_files());
            let first = go(&p, Probe::default(), |_| {})
                .unwrap_or_else(|e| panic!("{id}: first run failed: {e}"));
            assert_eq!(first.outcome, Outcome::Generated, "{id}");
            assert!(p.exists(KEY_FILE), "{id}: the first run must store a key");
            tick();
            p
        };

        let p = fresh("gen");
        let Answer::Gen(result) = next_run(id, &p, Ask::Gen) else {
            panic!("{id}: asked for gen, answered verify");
        };
        match case["gen"].as_str().unwrap() {
            "skip" => {
                let r =
                    result.unwrap_or_else(|e| panic!("{id}: expected a skip, the run failed: {e}"));
                assert_eq!(r.outcome, Outcome::Skipped, "{id}: {}", case["change"]);
                assert_eq!(r.files, Default::default(), "{id}: a skip writes nothing");
                assert!(!r.manifest_written, "{id}: a skip saves no manifest");
            }
            "regenerate" if id == "generated-file-edited" => match result {
                Err(RunError::Refused(r)) => {
                    assert_eq!(r.edited, vec!["generated/shop/src/order.rs".to_string()])
                }
                other => panic!("{id}: expected the edited file to be refused, got {other:?}"),
            },
            "regenerate" => {
                let r = result.unwrap_or_else(|e| panic!("{id}: the run failed: {e}"));
                assert_eq!(r.outcome, Outcome::Generated, "{id}: {}", case["change"]);
            }
            other => panic!("{id}: unknown gen expectation {other}"),
        }

        // The same change on a second project, asked of `verify` before any further `gen`.
        let p = fresh("verify");
        let Answer::Verify(result) = next_run(id, &p, Ask::Verify) else {
            panic!("{id}: asked for verify, answered gen");
        };
        match (case["verify"].as_str().unwrap(), result) {
            // A failing generator cannot be rendered; the failure is the render attempt.
            ("must-render", Err(RunError::Generator(_))) => {}
            ("must-render", Ok(report)) => {
                assert!(
                    report.rendered,
                    "{id}: verify must render: {}",
                    case["change"]
                )
            }
            ("may-answer-no-drift", Ok(report)) => {
                assert!(
                    !report.rendered,
                    "{id}: this port answers from the stored key"
                );
                assert!(
                    report.drifted.is_empty()
                        && report.missing.is_empty()
                        && report.extra.is_empty(),
                    "{id}: nothing drifted: {}",
                    case["change"]
                );
            }
            (expected, other) => panic!("{id}: verify should {expected}, got {other:?}"),
        }
        ran += 1;
    }
    assert!(
        ran >= 22,
        "only {ran} cases ran; the table of not-applicable cases has grown too far"
    );
}

#[test]
fn a_run_that_regenerates_stores_a_key_that_the_next_run_skips_on() {
    let p = Scratch::project("skip-after-regen", &shop_files());
    go(&p, Probe::default(), |_| {}).unwrap();
    let mut doc = shop_json();
    add_field(
        &mut doc,
        "Address",
        json!({ "field.string": { "name": "country" } }),
    );
    write_json(&p, SHOP_FILE, &doc);
    assert_eq!(
        go(&p, Probe::default(), |_| {}).unwrap().outcome,
        Outcome::Generated
    );
    assert_eq!(
        go(&p, Probe::default(), |_| {}).unwrap().outcome,
        Outcome::Skipped
    );
}

#[test]
fn the_engine_identity_is_a_content_hash() {
    let h = metaobjects_codegen::engine::ENGINE_SOURCE_HASH;
    assert_eq!(h.len(), 64);
    assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
}
