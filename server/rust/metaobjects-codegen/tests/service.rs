//! The `service` generator on SQLite: the service crates build, are formatted, and answer the
//! rules corpus's scenarios through the generated service, with no HTTP in between.
//!
//! The model, the seed and the hand-written pieces (the actor, the policy, the bodies, the hook
//! and the event hook) are the rules corpus's (`fixtures/api-contract-conformance/rules/`, its
//! README). Each scenario of its `scenarios/` runs on a fresh in-memory database; the probe
//! prints each call's answer (the wire code of a refusal, or the fields the scenario asserts),
//! and the oracle is what the scenario expects. The settings variants are generated too: what
//! each changes is which methods the service has and what a create checks.

mod common;

use common::{
    Scratch, assert_builds, assert_formatted, assert_pinned, generate_all, generated_workspace,
    run_probe,
};

const RULES: &str = "../../../fixtures/api-contract-conformance/rules";

fn rules_project(tag: &str, config: Option<&str>) -> Scratch {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(RULES);
    let model = std::fs::read_to_string(dir.join("meta.json")).unwrap();
    let mut files = vec![("metaobjects/meta.json", model)];
    if let Some(variant) = config {
        let path = dir
            .join("settings")
            .join(variant)
            .join(".metaobjects/config.json");
        files.push((
            ".metaobjects/config.json",
            std::fs::read_to_string(path).unwrap(),
        ));
    }
    let files: Vec<(&str, &str)> = files.iter().map(|(p, t)| (*p, t.as_str())).collect();
    Scratch::project(tag, &files)
}

const PROBE_DEPENDENCIES: &str = "acme_purchasing = { path = \"../out/acme_purchasing\" }\n\
    acme_purchasing_contract = { path = \"../out/acme_purchasing_contract\" }\n\
    acme_purchasing_rules = { path = \"../out/acme_purchasing_rules\" }\n\
    acme_purchasing_service = { path = \"../out/acme_purchasing_service\" }\n\
    acme_purchasing_store = { path = \"../out/acme_purchasing_store\" }\n\
    meta_store = { path = \"../out/meta_store\" }\n\
    serde = \"1\"\n\
    serde_json = \"1\"\n\
    sqlx = { version = \"0.8\", default-features = false, features = [\"sqlite\", \"runtime-tokio\"] }\n\
    tokio = { version = \"1\", features = [\"rt\", \"macros\"] }\n";

/// The rules corpus's hand-written pieces, shared with the transport's runner.
const RULES_PIECES: &str = include_str!("common/rules_pieces.rs");

const PROBE_MAIN: &str = r##"
type Service = PurchasingService<sqlx::SqlitePool, Actor, Grants, Bodies, Hooks, Audit>;

/// A fresh database holding the corpus's seed, and the service over it.
async fn fresh() -> Service {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../schema.sql")).execute(&pool).await.unwrap();
    PurchasingService::new(pool, Grants, Bodies).with_hooks(Hooks).with_events(Audit)
}

/// The answer as the scenario asserts it: the wire code of a refusal, or the row's fields.
fn show<T: serde::Serialize>(label: &str, out: Result<T, ServiceError>, fields: &[&str]) {
    match out {
        Err(e) => println!("{label} {} {}", e.status(), e.code()),
        Ok(v) => {
            let v = serde_json::to_value(&v).unwrap();
            let picked: serde_json::Map<String, Value> = if fields.is_empty() {
                v.as_object().cloned().unwrap_or_default()
            } else {
                fields.iter().map(|f| (f.to_string(), v[*f].clone())).collect()
            };
            println!("{label} ok {}", Value::Object(picked));
        }
    }
}

async fn status(s: &Service, label: &str, id: i64) {
    show(label, s.get_purchase_request(id).await, &["id", "title", "status"]);
}

async fn audit(s: &Service, label: &str) {
    let page = s.list_audit_entry(&Query::default(), false).await.unwrap();
    let details: Vec<String> = page.rows.iter().map(|r| format!("{}:{}", r.kind, r.detail)).collect();
    println!("{label} {details:?}");
}

fn decision(approve: bool, note: Option<&str>) -> acme_purchasing_contract::operations::DecideInput {
    serde_json::from_value(json!({ "approve": approve, "note": note })).unwrap()
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let ann_submit = || actor("ann", &["acme::purchasing.PurchaseRequest.submit"]);
    let rita = || actor("rita", &["purchasing.decide"]);

    // create-starts-in-initial-state
    let s = fresh().await;
    let body = |status: Option<&str>| -> acme_purchasing::PurchaseRequestCreate {
        let mut b = json!({ "title": "Phone", "amountCents": 50000 });
        if let Some(st) = status {
            b["status"] = json!(st);
        }
        serde_json::from_value(b).unwrap()
    };
    show("create-other-state", s.create_purchase_request(None, body(Some("approved"))).await, &[]);
    show("create", s.create_purchase_request(None, body(None)).await, &["id", "title", "status"]);

    // declared-command-transitions
    let s = fresh().await;
    let row = &["id", "status"];
    show("decide-approve", s.decide(Some(&rita()), 2, decision(true, None)).await, row);
    show("decide-reject", s.decide(Some(&rita()), 3, decision(false, Some("too large"))).await, row);
    show("decide-no-actor", s.decide(None, 2, decision(true, None)).await, row);
    audit(&s, "decide-audit").await;

    // declared-error-rolls-back
    let s = fresh().await;
    show("decide-no-note", s.decide(Some(&rita()), 2, decision(false, None)).await, row);
    status(&s, "decide-no-note-after", 2).await;
    show("decide-approved", s.decide(Some(&rita()), 5, decision(true, None)).await, row);

    // declared-permission-is-asked
    let s = fresh().await;
    let derived = actor("ann", &["acme::purchasing.PurchaseRequest.reopen"]);
    show("reopen-derived", s.reopen_purchase_request(Some(&derived), 4).await, row);
    let declared = actor("ann", &["purchasing.reopen"]);
    show("reopen-declared", s.reopen_purchase_request(Some(&declared), 4).await, row);

    // derived-command-forbidden
    let s = fresh().await;
    show("submit-other-grant", s.submit_purchase_request(Some(&rita()), 1).await, row);
    show("submit-no-actor", s.submit_purchase_request(None, 1).await, row);
    show("submit-missing", s.submit_purchase_request(None, 99).await, row);
    status(&s, "submit-forbidden-after", 1).await;

    // derived-command-moves-the-row
    let s = fresh().await;
    show("submit", s.submit_purchase_request(Some(&ann_submit()), 1).await, &["id", "title", "status"]);
    audit(&s, "submit-audit").await;

    // event-refusal-rolls-back
    let s = fresh().await;
    let no_audit = actor("no-audit", &["acme::purchasing.PurchaseRequest.submit"]);
    show("submit-no-audit", s.submit_purchase_request(Some(&no_audit), 1).await, row);
    status(&s, "submit-no-audit-after", 1).await;
    audit(&s, "submit-no-audit-audit").await;

    // hook-refusal-rolls-back
    let s = fresh().await;
    let patch = |v: Value| -> acme_purchasing::PurchaseRequestPatch { serde_json::from_value(v).unwrap() };
    show("update-refused", s.update_purchase_request(None, 1, patch(json!({ "title": "REFUSE" }))).await, row);
    status(&s, "update-refused-after", 1).await;

    // invalid-transition
    let s = fresh().await;
    show("submit-submitted", s.submit_purchase_request(Some(&ann_submit()), 2).await, row);
    audit(&s, "submit-submitted-audit").await;

    // public-command-needs-no-actor
    let s = fresh().await;
    show("cancel", s.cancel_purchase_request(None, 2).await, row);
    show("cancel-approved", s.cancel_purchase_request(None, 5).await, row);

    // public-query
    let s = fresh().await;
    show("totals", s.request_totals(None).await, &[]);

    // state-managed-update
    let s = fresh().await;
    let change = json!({ "status": "approved", "title": "Laptop Pro" });
    show("update-other-state", s.update_purchase_request(None, 1, patch(change)).await, row);
    let same = json!({ "status": "draft", "title": "Laptop Pro" });
    show("update-same-state", s.update_purchase_request(None, 1, patch(same)).await, &["id", "title", "status"]);

    // transition-condition-failed
    let s = fresh().await;
    show("decide-over-limit", s.decide(Some(&rita()), 3, decision(true, None)).await, row);
    status(&s, "decide-over-limit-after", 3).await;

    // A list: ordered by the key, 50 rows when it names no limit, and the count on request.
    let s = fresh().await;
    let page = s.list_purchase_request(&Query::default(), true).await.unwrap();
    let ids: Vec<i64> = page.rows.iter().map(|r| r.id).collect();
    println!("list {ids:?} {:?}", page.total);

    // The `_in` form runs inside a caller's transaction: rolled back, nothing stays.
    let s = fresh().await;
    let mut tx = s.db.begin().await.unwrap();
    s.cancel_purchase_request_in(&mut *tx, None, 1).await.unwrap();
    tx.rollback().await.unwrap();
    status(&s, "in-rolled-back", 1).await;
}
"##;

const SCHEMA: &str = r#"CREATE TABLE "purchase_requests" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "title" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "limit_cents" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE "audit_entries" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL
);
INSERT INTO "purchase_requests" ("id", "title", "amount_cents", "limit_cents", "status") VALUES
    (1, 'Laptop', 120000, 200000, 'draft'),
    (2, 'Desk', 30000, 50000, 'submitted'),
    (3, 'Server', 900000, 100000, 'submitted'),
    (4, 'Chair', 15000, NULL, 'rejected'),
    (5, 'Monitor', 40000, 50000, 'approved');
"#;

/// What each scenario expects, as the probe prints it.
const EXPECTED: &str = r#"create-other-state 409 state_managed
create ok {"id":6,"status":"draft","title":"Phone"}
decide-approve ok {"id":2,"status":"approved"}
decide-reject ok {"id":3,"status":"rejected"}
decide-no-actor 403 forbidden
decide-audit ["transition:PurchaseRequest 2 approve submitted->approved by rita", "transition:PurchaseRequest 3 reject submitted->rejected by rita"]
decide-no-note 409 note_required
decide-no-note-after ok {"id":2,"status":"submitted","title":"Desk"}
decide-approved 409 invalid_transition
reopen-derived 403 forbidden
reopen-declared ok {"id":4,"status":"draft"}
submit-other-grant 403 forbidden
submit-no-actor 403 forbidden
submit-missing 404 not_found
submit-forbidden-after ok {"id":1,"status":"draft","title":"Laptop"}
submit ok {"id":1,"status":"submitted","title":"Laptop"}
submit-audit ["transition:PurchaseRequest 1 submit draft->submitted by ann"]
submit-no-audit 409 audit_unavailable
submit-no-audit-after ok {"id":1,"status":"draft","title":"Laptop"}
submit-no-audit-audit []
update-refused 409 title_refused
update-refused-after ok {"id":1,"status":"draft","title":"Laptop"}
submit-submitted 409 invalid_transition
submit-submitted-audit []
cancel ok {"id":2,"status":"cancelled"}
cancel-approved 409 invalid_transition
totals ok {"count":5,"totalCents":1105000}
update-other-state 409 state_managed
update-same-state ok {"id":1,"status":"draft","title":"Laptop Pro"}
decide-over-limit 409 transition_condition_failed
decide-over-limit-after ok {"id":3,"status":"submitted","title":"Server"}
list [1, 2, 3, 4, 5] Some(5)
in-rolled-back ok {"id":1,"status":"draft","title":"Laptop"}
"#;

#[test]
fn the_service_crates_build_are_formatted_and_answer_the_rules_scenarios_on_sqlite() {
    let p = rules_project("service-rules", None);
    generate_all(&p, &[]);
    let ws = generated_workspace(
        "service-rules-ws",
        &p,
        Some((PROBE_DEPENDENCIES, &format!("{RULES_PIECES}{PROBE_MAIN}"))),
    );
    ws.write("probe/schema.sql", SCHEMA);
    assert_formatted(&ws);
    assert_builds(&ws, "the service crates");
    let out = run_probe(&ws);
    assert_pinned(&ws);
    let got: Vec<&str> = out.lines().collect();
    let want: Vec<&str> = EXPECTED.lines().collect();
    for (g, w) in got.iter().zip(&want) {
        assert_eq!(g, w);
    }
    assert_eq!(got.len(), want.len(), "{out}");
}

/// The text of one generated file of a variant's service crate.
fn service_text(variant: &str, file: &str) -> String {
    let p = rules_project(&format!("service-{variant}"), Some(variant));
    generate_all(&p, &[]);
    p.read(&format!("generated/acme_purchasing_service/src/{file}"))
}

#[test]
fn commands_all_gives_a_claimed_transition_its_own_command_too() {
    let text = service_text("commands-all", "purchase_request.rs");
    for t in ["submit", "approve", "reject", "cancel", "reopen"] {
        assert!(
            text.contains(&format!("pub async fn {t}_purchase_request(")),
            "{t}:\n{text}"
        );
    }
}

#[test]
fn commands_none_derives_no_command_and_the_declared_command_still_moves() {
    let text = service_text("commands-none", "purchase_request.rs");
    assert!(!text.contains("Transition::"), "{text}");
    let ops = service_text("commands-none", "operations.rs");
    assert!(ops.contains("meta_service::make_move("), "{ops}");
}

#[test]
fn create_any_lets_a_create_start_in_any_state() {
    let text = service_text("create-any", "purchase_request.rs");
    assert!(!text.contains("INITIAL"), "{text}");
    let default = rules_project("service-default", None);
    generate_all(&default, &[]);
    let text = default.read("generated/acme_purchasing_service/src/purchase_request.rs");
    assert!(text.contains("rules::status::INITIAL"), "{text}");
}

const TPH_DEPENDENCIES: &str = "acme_auth = { path = \"../out/acme_auth\" }\n\
    acme_auth_service = { path = \"../out/acme_auth_service\" }\n\
    serde_json = \"1\"\n\
    sqlx = { version = \"0.8\", default-features = false, features = [\"sqlite\", \"runtime-tokio\"] }\n\
    tokio = { version = \"1\", features = [\"rt\", \"macros\"] }\n";

const TPH_MAIN: &str = r##"
use acme_auth_service::AuthService;
use serde_json::json;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"CREATE TABLE "auths" (
            "id" INTEGER PRIMARY KEY NOT NULL,
            "type" TEXT NOT NULL,
            "reference" TEXT NOT NULL,
            "issued_currency" TEXT,
            "auto_created_at" TEXT,
            "auto_updated_at" TEXT,
            "quantity" INTEGER,
            "coupon_amount" TEXT,
            "approver" TEXT
        );
        INSERT INTO "auths" ("id", "type", "reference", "auto_created_at", "auto_updated_at", "quantity")
            VALUES (1, 'Bridge', 'REF-1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', 3);"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let s: AuthService<_, ()> = AuthService::new(pool);

    // A create stamps both, whatever the caller sent: the two are the one instant.
    let body: acme_auth::BridgeAuthCreate = serde_json::from_value(json!({
        "reference": "REF-2", "quantity": 1, "autoCreatedAt": "1999-01-01T00:00:00.000Z"
    }))
    .unwrap();
    let row = s.create_bridge_auth(None, body).await.unwrap();
    let created = row.auto_created_at.clone().unwrap();
    println!("create-stamped {}", created.starts_with("20") && !created.starts_with("2000"));
    println!("create-same {}", row.auto_created_at == row.auto_updated_at);

    // An update bumps onUpdate and leaves onCreate.
    let patch: acme_auth::BridgeAuthPatch =
        serde_json::from_value(json!({ "reference": "REF-1b" })).unwrap();
    let row = s.update_bridge_auth(None, 1, patch).await.unwrap();
    println!("update-created {}", row.auto_created_at.as_deref().unwrap());
    println!("update-bumped {}", row.auto_updated_at.as_deref() != Some("2000-01-01T00:00:00.000Z"));
}
"##;

#[test]
fn the_service_stamps_auto_set_timestamps_on_create_and_update() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/api-contract-conformance/tph/meta.json");
    let model = std::fs::read_to_string(dir).unwrap();
    let p = Scratch::project("service-autoset", &[("metaobjects/meta.json", &model)]);
    generate_all(&p, &[]);
    let ws = generated_workspace("service-autoset-ws", &p, Some((TPH_DEPENDENCIES, TPH_MAIN)));
    assert_builds(&ws, "the auth service crate");
    let out = run_probe(&ws);
    assert_pinned(&ws);
    assert_eq!(
        out,
        "create-stamped true\ncreate-same true\nupdate-created 2000-01-01T00:00:00.000Z\nupdate-bumped true\n"
    );
}
