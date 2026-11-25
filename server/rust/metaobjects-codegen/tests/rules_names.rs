//! The `rules-names` generator (ADR-0067 layer 0): the names a model's rules declare and derive,
//! as types hand-written code can name.
//!
//! The model is `fixtures/codegen-noop/rules/with`, the one every port's rules-inert test reads:
//! `PurchaseRequest.status` is a lifecycle (draft, submitted, approved, rejected) with the
//! transitions `submit`, `approve` and `reject`; the API `Purchasing` declares the command
//! `decide` (it claims `approve` and `reject`), and the queries `openRequests` (`@public`) and
//! `requestSummary`. The expected names below are read off that model and the derivation rules
//! of ADR-0066 (a derived permission is `<package>.<operation>` or
//! `<package>.<Entity>.<transition>`), not off the generator. A probe crate uses them, so the
//! oracle is the compiler and the values the probe prints.

mod common;

use common::{
    Scratch, assert_builds, assert_formatted, generate_all, generated_workspace, run_probe,
};

const MODEL_FILE: &str = "meta.purchasing.json";

fn project(tag: &str, variant: &str) -> Scratch {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/codegen-noop/rules")
        .join(variant)
        .join(MODEL_FILE);
    let model =
        std::fs::read_to_string(&fixture).unwrap_or_else(|e| panic!("{}: {e}", fixture.display()));
    Scratch::project(tag, &[(&format!("metaobjects/{MODEL_FILE}"), &model)])
}

const PROBE_DEPENDENCIES: &str = "acme_purchasing = { path = \"../out/acme_purchasing\" }\n\
    acme_purchasing_rules = { path = \"../out/acme_purchasing_rules\" }\n";

const PROBE_MAIN: &str = r#"
use acme_purchasing::PurchaseRequestStatus;
use acme_purchasing_rules::purchase_request::{Command, status};
use acme_purchasing_rules::{BusinessError, Operation, OperationKind, Permission, ShellError};

fn main() {
    // The state type is the model's own enum, so a value read off a record compares directly.
    let draft: PurchaseRequestStatus = status::INITIAL;
    println!("field {}", status::FIELD);
    println!("initial {draft:?}");
    println!("states {:?}", status::STATES);
    println!("terminal {:?}", status::TERMINAL);
    for t in status::Transition::ALL {
        println!("transition {} {:?} -> {:?}", t.name(), t.from(), t.to());
    }
    for c in Command::ALL {
        println!(
            "command {} on {} asks {:?}",
            c.name(),
            c.lifecycle(),
            c.permission().map(Permission::name)
        );
    }
    for o in Operation::ALL {
        println!(
            "operation {} {} asks {:?} transitions {:?} errors {:?}",
            o.name(),
            o.kind().as_str(),
            o.permission().map(Permission::name),
            o.transitions(),
            o.errors().iter().map(|e| e.code()).collect::<Vec<_>>()
        );
    }
    assert_eq!(Operation::OpenRequests.kind(), OperationKind::Query);
    println!("permissions {:?}", Permission::ALL.iter().map(|p| p.name()).collect::<Vec<_>>());
    println!("errors {:?}", BusinessError::ALL.iter().map(|e| e.code()).collect::<Vec<_>>());
    println!("shell {:?}", ShellError::ALL.iter().map(|e| e.code()).collect::<Vec<_>>());
}
"#;

const EXPECTED: &str = "\
field status
initial Draft
states [Draft, Submitted, Approved, Rejected]
terminal [Approved, Rejected]
transition submit [Draft] -> Submitted
transition approve [Submitted] -> Approved
transition reject [Submitted] -> Rejected
command submit on status asks Some(\"acme::purchasing.PurchaseRequest.submit\")
operation decide command asks Some(\"purchasing.decide\") transitions [\"approve\", \"reject\"] errors [\"over_budget\", \"already_decided\"]
operation openRequests query asks None transitions [] errors []
operation requestSummary query asks Some(\"acme::purchasing.requestSummary\") transitions [] errors []
permissions [\"acme::purchasing.PurchaseRequest.submit\", \"acme::purchasing.requestSummary\", \"purchasing.decide\"]
errors [\"already_decided\", \"over_budget\"]
shell [\"not_found\", \"forbidden\", \"invalid_transition\", \"transition_condition_failed\", \"state_managed\"]
";

#[test]
fn the_rules_crate_builds_is_formatted_and_names_what_the_model_declares_and_derives() {
    let p = project("rules-names", "with");
    generate_all(&p, &[]);
    let ws = generated_workspace("rules-names-ws", &p, Some((PROBE_DEPENDENCIES, PROBE_MAIN)));
    assert_formatted(&ws);
    assert_builds(&ws, "the rules crate");
    assert_eq!(run_probe(&ws), EXPECTED);
}

#[test]
fn a_model_without_the_rules_vocabulary_gets_no_rules_crate() {
    let p = project("rules-names-without", "without");
    generate_all(&p, &[]);
    assert!(p.exists("generated/acme_purchasing/Cargo.toml"));
    assert!(!p.exists("generated/acme_purchasing_rules"));
}
