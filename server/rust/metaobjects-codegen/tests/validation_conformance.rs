//! The shared validation corpus, run through the generated `validate()`.
//!
//! `fixtures/validation-conformance/` pins, for every port, which create bodies the generated
//! input validation accepts. The Rust verdict of a case is: the payload deserializes into the
//! entity's generated create body AND `validate()` reports nothing. Deserializing is part of
//! the verdict because a missing required member, a wrong type or a malformed address is
//! refused by the type itself, before any check runs.
//!
//! The probe is built and run by the real compiler against the real generated crates, so the
//! verdicts are those of the code an adopter gets.

mod common;

use common::{
    Scratch, assert_builds, assert_formatted, generate_all, generated_workspace, run_probe,
};

const FIELD_MODEL: &str = include_str!("../../../../fixtures/validation-conformance/meta.json");
const FIELD_CASES: &str = include_str!("../../../../fixtures/validation-conformance/cases.json");
const CROSS_MODEL: &str =
    include_str!("../../../../fixtures/validation-conformance/meta.cross-field.json");
const CROSS_CASES: &str =
    include_str!("../../../../fixtures/validation-conformance/cross-field-cases.json");

/// The entity a case with no `entity` key is about (the corpus README).
const DEFAULT_ENTITY: &str = "Account";

/// Every entity the corpus has cases for, and the generated create body that judges them.
const JUDGES: &[(&str, &str)] = &[
    ("Account", "acme_auth::AccountCreate"),
    ("Ledger", "acme_auth::LedgerCreate"),
    ("Event", "acme_events::EventCreate"),
    ("Shift", "acme_events::ShiftCreate"),
];

const PROBE_DEPENDENCIES: &str = "acme_auth = { path = \"../out/acme_auth\" }\n\
    acme_events = { path = \"../out/acme_events\" }\n\
    serde = \"1\"\n\
    serde_json = \"1\"\n";

fn probe_main() -> String {
    let mut arms = String::new();
    for (entity, judge) in JUDGES {
        arms.push_str(&format!(
            "        {entity:?} => serde_json::from_value::<{judge}>(payload).map(|v| v.validate()).map_err(|e| e.to_string()),\n"
        ));
    }
    format!(
        r##"
fn judge(entity: &str, payload: serde_json::Value) -> Result<Vec<String>, String> {{
    let found = match entity {{
{arms}        other => panic!("the corpus has a case for {{other}}, which this runner does not judge"),
    }};
    found.map(|violations| violations.into_iter().map(|v| format!("{{}}: {{}}", v.rule, v.message)).collect())
}}

fn main() {{
    let mut wrong = 0;
    let mut ran = 0;
    for text in [include_str!("../cases.json"), include_str!("../cross-field-cases.json")] {{
        let file: serde_json::Value = serde_json::from_str(text).unwrap();
        for case in file["cases"].as_array().unwrap() {{
            let name = case["name"].as_str().unwrap();
            let entity = case["entity"].as_str().unwrap_or({DEFAULT_ENTITY:?});
            let expect = case["expectValid"].as_bool().unwrap();
            let verdict = judge(entity, case["payload"].clone());
            let valid = matches!(&verdict, Ok(found) if found.is_empty());
            ran += 1;
            if valid != expect {{
                wrong += 1;
                println!("WRONG {{name}} ({{entity}}): expected valid={{expect}}, got {{verdict:?}}");
            }}
        }}
    }}
    println!("ran {{ran}}");
    if wrong > 0 {{
        std::process::exit(1);
    }}
}}
"##
    )
}

#[test]
fn the_generated_validation_gives_the_corpus_verdict_for_every_case() {
    let project = Scratch::project(
        "validation",
        &[
            ("metaobjects/meta.validation.json", FIELD_MODEL),
            ("metaobjects/meta.cross-field.json", CROSS_MODEL),
        ],
    );
    generate_all(&project, &[]);
    let ws = generated_workspace(
        "validation-ws",
        &project,
        Some((PROBE_DEPENDENCIES, &probe_main())),
    );
    ws.write("probe/cases.json", FIELD_CASES);
    ws.write("probe/cross-field-cases.json", CROSS_CASES);
    assert_formatted(&ws);
    assert_builds(&ws, "the validation corpus models");

    // Every entity the corpus names has a judge, so a new one cannot be silently skipped.
    let mut expected = 0;
    for text in [FIELD_CASES, CROSS_CASES] {
        let file: serde_json::Value = serde_json::from_str(text).unwrap();
        for case in file["cases"].as_array().unwrap() {
            let entity = case["entity"].as_str().unwrap_or(DEFAULT_ENTITY);
            assert!(
                JUDGES.iter().any(|(name, _)| *name == entity),
                "no judge for {entity}"
            );
            expected += 1;
        }
    }
    let out = run_probe(&ws);
    assert_eq!(
        out.lines().last(),
        Some(format!("ran {expected}").as_str()),
        "{out}"
    );
}
