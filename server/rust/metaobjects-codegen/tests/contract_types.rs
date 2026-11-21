//! The `contract-types` generator (ADR-0067 layer 1): what a package's declared operations take,
//! return and answer an error with, and the wire error contract.
//!
//! The model is `fixtures/codegen-noop/rules/with`: the command `decide` takes the value object
//! `DecisionInput` and declares the business errors `over_budget` and `already_decided`; the
//! query `openRequests` returns a list of the projection `RequestSummary` (`id`, `title`), and
//! `requestSummary` returns one. The wire codes and statuses are the REST contract's
//! (docs/features/api-contract.md, ADR-0066 §6). A probe crate reads and writes JSON through the
//! generated types, so the oracle is the compiler and serde, not the generator's text.

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

const PROBE_DEPENDENCIES: &str = "acme_purchasing_contract = { path = \"../out/acme_purchasing_contract\" }\n\
    meta_contract = { path = \"../out/meta_contract\" }\n\
    serde_json = \"1\"\n";

const PROBE_MAIN: &str = r##"
use acme_purchasing_contract::operations::{
    DecideBusinessError, DecideError, DecideInput, OpenRequestsError, OpenRequestsOutput,
    RequestSummaryOutput,
};
use meta_contract::{ConstraintKind, ErrorCode, OperationCode, ValidationErrorBody};

fn main() {
    // The input is the model's value object, with its own validate().
    let input: DecideInput = serde_json::from_str(r#"{"requestId": 7, "comment": "ok"}"#).unwrap();
    println!("input {:?} {:?} {}", input.request_id, input.comment, input.validate().len());

    let rows: OpenRequestsOutput = serde_json::from_str(r#"[{"id": 1, "title": "Desk"}, {"id": 2}]"#).unwrap();
    println!("rows {} {:?}", rows.len(), rows[0].title);
    let one: RequestSummaryOutput = serde_json::from_str(r#"{"id": 3, "title": "Chair"}"#).unwrap();
    println!("one {}", one.id);

    // An operation's error code is a fixed one or one of its own, and both are the bare code.
    let business: DecideError = serde_json::from_str(r#"{"error": "over_budget"}"#).unwrap();
    println!("business {:?} {}", business.error, serde_json::to_string(&business).unwrap());
    let fixed: DecideError = serde_json::from_str(r#"{"error": "not_found", "message": "gone"}"#).unwrap();
    println!("fixed {:?} {:?}", fixed.error, fixed.message);
    assert_eq!(business.error, OperationCode::Business(DecideBusinessError::OverBudget));
    assert!(serde_json::from_str::<DecideError>(r#"{"error": "nonsense"}"#).is_err());
    // A query that declares no business error takes only the fixed codes.
    let forbidden: OpenRequestsError = serde_json::from_str(r#"{"error": "forbidden"}"#).unwrap();
    println!("query {:?}", forbidden.error);
    assert!(serde_json::from_str::<OpenRequestsError>(r#"{"error": "over_budget"}"#).is_err());
    println!("codes {:?}", DecideBusinessError::ALL.iter().map(|e| e.code()).collect::<Vec<_>>());

    for c in ErrorCode::SHELL.iter().chain(ErrorCode::CONTRACT) {
        println!("status {} {:?}", c.code(), c.status());
    }
    for k in [ConstraintKind::Unique, ConstraintKind::ForeignKey, ConstraintKind::Check, ConstraintKind::NotNull] {
        println!("constraint {} {}", serde_json::to_string(&k).unwrap(), k.status());
    }
    let v: ValidationErrorBody = serde_json::from_str(
        r#"{"error": "validation", "issues": [{"code": "too_big", "path": ["lines", 0, "qty"], "message": "too big"}]}"#,
    )
    .unwrap();
    println!("validation {:?} {}", v.error, serde_json::to_string(&v.issues[0].path).unwrap());
}
"##;

const EXPECTED: &str = "\
input Some(7) Some(\"ok\") 0
rows 2 Some(\"Desk\")
one 3
business Business(OverBudget) {\"error\":\"over_budget\"}
fixed Fixed(NotFound) Some(\"gone\")
query Fixed(Forbidden)
codes [\"over_budget\", \"already_decided\"]
status not_found Some(404)
status forbidden Some(403)
status invalid_transition Some(409)
status transition_condition_failed Some(409)
status state_managed Some(409)
status validation Some(400)
status invalid_json Some(400)
status invalid_id Some(400)
status method_not_allowed Some(405)
status constraint_violation None
status internal Some(500)
constraint \"unique\" 409
constraint \"foreign_key\" 409
constraint \"check\" 400
constraint \"not_null\" 400
validation Validation [\"lines\",0,\"qty\"]
";

#[test]
fn the_contract_crate_builds_is_formatted_and_reads_the_wire_forms_the_contract_names() {
    let p = project("contract-types", "with");
    generate_all(&p, &[]);
    let ws = generated_workspace(
        "contract-types-ws",
        &p,
        Some((PROBE_DEPENDENCIES, PROBE_MAIN)),
    );
    assert_formatted(&ws);
    assert_builds(&ws, "the contract crate");
    assert_eq!(run_probe(&ws), EXPECTED);
}

#[test]
fn a_model_without_declared_operations_gets_no_contract_crate() {
    let p = project("contract-types-without", "without");
    generate_all(&p, &[]);
    assert!(p.exists("generated/acme_purchasing/Cargo.toml"));
    assert!(!p.exists("generated/acme_purchasing_contract"));
    assert!(!p.exists("generated/meta_contract"));
}
