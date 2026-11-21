//! The `repository` generator on SQLite: the store crates build, are formatted, and read and
//! write through the model's own types.
//!
//! The first model is the persistence corpus's (`fixtures/persistence-conformance/canonical`),
//! with its committed SQLite schema; the rows and the values expected back are the corpus's own
//! scenarios (`filter-range-and`, `roundtrip-all-types`, `tph-insert-then-find-by-id`,
//! `roundtrip-int-enum-array`), read through the wire forms of
//! `fixtures/persistence-conformance/normalization.md`. The second is the rules model pair's
//! `PurchaseRequest`, whose `status` lifecycle gets the guarded update (ADR-0066 §6 step 5).
//! A probe crate drives the generated functions on an in-memory database; the oracle is what
//! the corpus and the SQL semantics say comes back, not the generator's text.

mod common;

use common::{
    Scratch, assert_builds, assert_formatted, assert_pinned, generate_all, generated_workspace,
    run_probe,
};

const CANONICAL: &str = "../../../fixtures/persistence-conformance/canonical";

fn fitness_project(tag: &str) -> Scratch {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(CANONICAL);
    let read =
        |rel: &str| std::fs::read_to_string(dir.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
    // The corpus's schema is written under the `literal` column strategy.
    Scratch::project(
        tag,
        &[
            (
                ".metaobjects/config.json",
                r#"{ "schema_version": 1, "naming": { "columns": "literal" } }"#,
            ),
            ("metaobjects/meta.fitness.json", &read("meta.fitness.json")),
            (
                "templates/fitness/coach-note.mustache",
                &read("prompts/fitness/coach-note.mustache"),
            ),
        ],
    )
}

const PROBE_DEPENDENCIES: &str = "fitness = { path = \"../out/fitness\" }\n\
    fitness_store = { path = \"../out/fitness_store\" }\n\
    meta_store = { path = \"../out/meta_store\" }\n\
    serde = \"1\"\n\
    serde_json = \"1\"\n\
    sqlx = { version = \"0.8\", default-features = false, features = [\"sqlite\", \"runtime-tokio\"] }\n\
    tokio = { version = \"1\", features = [\"rt\", \"macros\"] }\n";

const PROBE_MAIN: &str = r##"
use fitness_store::{all_types, bridge_auth, coupon_auth, int_enum_array, person, program};
use meta_store::{Filter, Query, Sort};
use serde_json::json;
use sqlx::Connection;

fn show<T: serde::Serialize>(label: &str, value: &T) {
    println!("{label} {}", serde_json::to_string(value).unwrap());
}

fn by_id() -> Vec<Sort> {
    vec![Sort { field: "id".into(), descending: false }]
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut c = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(include_str!("../schema.sql")).execute(&mut c).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO "programs" ("id", "title", "priceCents", "status", "created_ts") VALUES
            (1, 'Foundations', 4999, 'PUBLISHED', '2026-05-01T10:00:00'),
            (2, 'Strength',    7999, 'PUBLISHED', '2026-05-02T10:00:00'),
            (3, 'Mobility',    2999, 'DRAFT',     '2026-05-03T10:00:00'),
            (4, 'Archived',    1999, 'ARCHIVED',  '2026-05-04T10:00:00');"#,
    )
    .execute(&mut c)
    .await
    .unwrap();

    // filter-range-and: the explicit `and` of two bounds on one field.
    let range = Query {
        filter: Some(
            Filter::from_json(&json!({ "and": [
                { "priceCents": { "gte": 3000 } },
                { "priceCents": { "lte": 7000 } }
            ] }))
            .unwrap(),
        ),
        sort: by_id(),
        ..Query::default()
    };
    show("range", &program::list(&mut c, &range).await.unwrap());
    let published = Filter::from_json(&json!({ "status": { "eq": "PUBLISHED" } })).unwrap();
    show("count", &program::count(&mut c, Some(&published)).await.unwrap());
    let titles = Query {
        filter: Some(Filter::from_json(&json!({ "title": { "in": ["Strength", "Archived"] }, "status": { "ne": "ARCHIVED" } })).unwrap()),
        ..Query::default()
    };
    show("in", &program::list(&mut c, &titles).await.unwrap());
    let page = Query {
        sort: vec![Sort { field: "priceCents".into(), descending: true }],
        limit: Some(2),
        offset: Some(1),
        ..Query::default()
    };
    show("page", &program::list(&mut c, &page).await.unwrap().iter().map(|p| p.id).collect::<Vec<_>>());
    let nothing = Query { filter: Some(Filter::from_json(&json!({ "id": { "in": [] } })).unwrap()), ..Query::default() };
    show("empty-in", &program::list(&mut c, &nothing).await.unwrap().len());
    println!("unknown {}", program::list(&mut c, &Query { filter: Some(Filter::from_json(&json!({ "nope": { "eq": 1 } })).unwrap()), ..Query::default() }).await.unwrap_err());

    // update and delete by key.
    let patch: fitness::ProgramPatch = serde_json::from_value(json!({ "title": "Mobility II" })).unwrap();
    show("update", &program::update(&mut c, 3, &patch).await.unwrap());
    show("update-missing", &program::update(&mut c, 99, &patch).await.unwrap());
    show("delete", &program::delete(&mut c, 4).await.unwrap());
    show("delete-again", &program::delete(&mut c, 4).await.unwrap());
    show("gone", &program::get(&mut c, 4).await.unwrap());

    // roundtrip-all-types, the first row: written through the create body, read back by the
    // key the database generated.
    let body: fitness::AllTypesCreate = serde_json::from_value(json!({
        "sVal": "hello", "iVal": 42, "lVal": 9007199254740991_i64, "dVal": 0.125, "fVal": 1.5,
        "decVal": "123.456", "bVal": true, "dateVal": "2026-06-03", "timeVal": "14:30:00.123",
        "tsVal": "2026-06-03T14:30:00.123", "tsTzVal": "2026-06-03T14:30:00.123Z",
        "moneyVal": 199900, "enumVal": "MEDIUM", "intEnumVal": "PUBLISHED",
        "uuidVal": "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "uriVal": "https://example.com/a/b?q=1",
        "inetVal": "192.168.1.1", "inet6Val": "2001:db8::1", "durationVal": "P1DT0.5S",
        "settings": { "theme": "dark", "notify": true, "retries": 3 },
        "labels": [{ "key": "alpha", "weight": 10 }, { "key": "beta", "weight": 20 }]
    }))
    .unwrap();
    let created = all_types::create(&mut c, &body).await.unwrap();
    let read = all_types::get(&mut c, &created.id).await.unwrap().unwrap();
    assert_eq!(read, created);
    let mut row = serde_json::to_value(&read).unwrap();
    row.as_object_mut().unwrap().remove("id");
    show("all-types", &row);

    // tph-insert-then-find-by-id: a subtype's create sets its discriminator, and a get is
    // scoped to the subtype.
    let bridge: fitness::BridgeAuthCreate = serde_json::from_value(json!({ "reference": "REF-1", "quantity": 5 })).unwrap();
    show("bridge", &bridge_auth::create(&mut c, &bridge).await.unwrap());
    let coupon: fitness::CouponAuthCreate = serde_json::from_value(json!({ "reference": "REF-2", "couponAmount": "12.50" })).unwrap();
    show("coupon", &coupon_auth::create(&mut c, &coupon).await.unwrap());
    show("bridge-1", &bridge_auth::get(&mut c, 1).await.unwrap());
    show("bridge-2", &bridge_auth::get(&mut c, 2).await.unwrap());
    show("bridges", &bridge_auth::count(&mut c, None).await.unwrap());

    // roundtrip-int-enum-array: an int-backed enum and an array of one store integers.
    let arrays: fitness::IntEnumArrayCreate = serde_json::from_value(json!({ "state": "PUBLISHED", "history": ["DRAFT", "ARCHIVED", "PUBLISHED"] })).unwrap();
    let a = int_enum_array::create(&mut c, &arrays).await.unwrap();
    let stored: (i64, String) = sqlx::query_as(r#"SELECT "state", "history" FROM "int_enum_arrays""#).fetch_one(&mut c).await.unwrap();
    show("int-enum", &a);
    println!("int-enum-stored {} {}", stored.0, stored.1);

    // m2n-symmetric-self-join and m2n-directed-self-join: a symmetric row answers from both
    // sides and a row relating a person to herself answers once; a directed one from one side.
    sqlx::raw_sql(
        r#"INSERT INTO "people" ("id", "name") VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol'), (4, 'Dave');
           INSERT INTO "friendships" ("personAId", "personBId") VALUES (1, 2), (3, 1), (2, 4), (1, 1);
           INSERT INTO "follows" ("followerId", "followeeId") VALUES (1, 2), (1, 3), (2, 1);"#,
    )
    .execute(&mut c)
    .await
    .unwrap();
    let ids = |mut rows: Vec<fitness::Person>| -> Vec<i64> {
        rows.sort_by_key(|p| p.id);
        rows.into_iter().map(|p| p.id).collect()
    };
    show("friends-1", &ids(person::friends_of(&mut c, 1).await.unwrap()));
    show("friends-4", &ids(person::friends_of(&mut c, 4).await.unwrap()));
    show("following-1", &ids(person::following_of(&mut c, 1).await.unwrap()));
    show("following-3", &ids(person::following_of(&mut c, 3).await.unwrap()));
}
"##;

#[test]
fn the_store_crates_build_are_formatted_and_read_and_write_the_corpus_rows_on_sqlite() {
    let p = fitness_project("repository-sqlite");
    generate_all(&p, &[]);
    let ws = generated_workspace(
        "repository-sqlite-ws",
        &p,
        Some((PROBE_DEPENDENCIES, PROBE_MAIN)),
    );
    let schema = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(CANONICAL)
            .join("schema.sqlite.sql"),
    )
    .unwrap();
    ws.write("probe/schema.sql", &schema);
    assert_formatted(&ws);
    assert_builds(&ws, "the store crates");
    let out = run_probe(&ws);
    assert_pinned(&ws);
    let mut lines = std::collections::BTreeMap::new();
    for line in out.lines() {
        let (label, rest) = line.split_once(' ').unwrap();
        lines.insert(label.to_string(), rest.to_string());
    }
    let json = |label: &str| -> serde_json::Value {
        serde_json::from_str(&lines[label])
            .unwrap_or_else(|e| panic!("{label}: {e}: {}", lines[label]))
    };
    use serde_json::json;
    // The rows of filter-range-and's first query, as the model types write them.
    assert_eq!(
        json("range"),
        json!([{ "id": 1, "title": "Foundations", "priceCents": 4999, "status": "PUBLISHED", "createdAt": "2026-05-01T10:00:00" }])
    );
    assert_eq!(json("count"), json!(2));
    assert_eq!(
        json("in"),
        json!([{ "id": 2, "title": "Strength", "priceCents": 7999, "status": "PUBLISHED", "createdAt": "2026-05-02T10:00:00" }])
    );
    // By price, highest first: 7999 (2), 4999 (1), 2999 (3), 1999 (4); skip one, take two.
    assert_eq!(json("page"), json!([1, 3]));
    assert_eq!(json("empty-in"), json!(0));
    assert_eq!(lines["unknown"], "Program has no field `nope`");
    assert_eq!(json("update")["title"], json!("Mobility II"));
    assert_eq!(json("update")["priceCents"], json!(2999));
    assert_eq!(json("update-missing"), json!(null));
    assert_eq!(json("delete"), json!(true));
    assert_eq!(json("delete-again"), json!(false));
    assert_eq!(json("gone"), json!(null));
    // roundtrip-all-types's expected row, in the model's own wire forms: a 64-bit integer and a
    // float stay JSON numbers here (the corpus's runners stringify them; the values agree).
    assert_eq!(
        json("all-types"),
        json!({
            "sVal": "hello", "iVal": 42, "lVal": 9007199254740991_i64, "dVal": 0.125, "fVal": 1.5,
            "decVal": "123.456", "bVal": true, "dateVal": "2026-06-03", "timeVal": "14:30:00.123",
            "tsVal": "2026-06-03T14:30:00.123", "tsTzVal": "2026-06-03T14:30:00.123Z",
            "moneyVal": 199900, "enumVal": "MEDIUM", "intEnumVal": "PUBLISHED",
            "uuidVal": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "uriVal": "https://example.com/a/b?q=1",
            "inetVal": "192.168.1.1", "inet6Val": "2001:db8::1", "durationVal": "PT24H0.5S",
            "settings": { "notify": true, "retries": 3, "theme": "dark" },
            "labels": [{ "key": "alpha", "weight": 10 }, { "key": "beta", "weight": 20 }]
        })
    );
    assert_eq!(
        json("bridge"),
        json!({ "id": 1, "type": "Bridge", "reference": "REF-1", "quantity": 5 })
    );
    assert_eq!(
        json("coupon"),
        json!({ "id": 2, "type": "Coupon", "reference": "REF-2", "couponAmount": "12.5" })
    );
    assert_eq!(json("bridge-1"), json("bridge"));
    assert_eq!(
        json("bridge-2"),
        json!(null),
        "a get is scoped to its subtype"
    );
    assert_eq!(json("bridges"), json!(1));
    assert_eq!(
        json("int-enum")["history"],
        json!(["DRAFT", "ARCHIVED", "PUBLISHED"])
    );
    assert_eq!(json("int-enum")["state"], json!("PUBLISHED"));
    // `@intValueMap` { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 }: the database holds the integers.
    assert_eq!(lines["int-enum-stored"], "5 [0,9,5]");
    // The corpus's expected people, by id.
    assert_eq!(json("friends-1"), json!([1, 2, 3]));
    assert_eq!(json("friends-4"), json!([2]));
    assert_eq!(json("following-1"), json!([2, 3]));
    assert_eq!(json("following-3"), json!([]));
}

const PURCHASING_DEPENDENCIES: &str = "acme_purchasing = { path = \"../out/acme_purchasing\" }\n\
    acme_purchasing_store = { path = \"../out/acme_purchasing_store\" }\n\
    serde_json = \"1\"\n\
    sqlx = { version = \"0.8\", default-features = false, features = [\"sqlite\", \"runtime-tokio\"] }\n\
    tokio = { version = \"1\", features = [\"rt\", \"macros\"] }\n";

const PURCHASING_MAIN: &str = r##"
use acme_purchasing::PurchaseRequestStatus as S;
use acme_purchasing_store::purchase_request as store;
use sqlx::Connection;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut c = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        r#"CREATE TABLE "purchase_requests" (
            "id" INTEGER PRIMARY KEY NOT NULL,
            "title" TEXT,
            "amount_cents" INTEGER,
            "status" TEXT NOT NULL DEFAULT 'draft'
        );"#,
    )
    .execute(&mut c)
    .await
    .unwrap();
    let body: acme_purchasing::PurchaseRequestCreate =
        serde_json::from_value(serde_json::json!({ "id": 1, "title": "Desk" })).unwrap();
    let row = store::create(&mut c, &body).await.unwrap();
    println!("created {:?}", row.status);
    println!("submit {}", store::transition_status(&mut c, 1, &[S::Draft], S::Submitted).await.unwrap());
    // The second writer to try the same move finds the row already moved, and loses.
    println!("submit-again {}", store::transition_status(&mut c, 1, &[S::Draft], S::Submitted).await.unwrap());
    println!("approve {}", store::transition_status(&mut c, 1, &[S::Submitted], S::Approved).await.unwrap());
    println!("missing {}", store::transition_status(&mut c, 9, &[S::Submitted], S::Approved).await.unwrap());
    println!("now {:?}", store::get(&mut c, 1).await.unwrap().unwrap().status);
}
"##;

#[test]
fn the_guarded_update_moves_a_row_only_from_the_states_its_transition_leaves() {
    let model = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../fixtures/codegen-noop/rules/with/meta.purchasing.json"),
    )
    .unwrap();
    let p = Scratch::project(
        "repository-lifecycle",
        &[("metaobjects/meta.purchasing.json", &model)],
    );
    generate_all(&p, &[]);
    let ws = generated_workspace(
        "repository-lifecycle-ws",
        &p,
        Some((PURCHASING_DEPENDENCIES, PURCHASING_MAIN)),
    );
    assert_builds(&ws, "the purchasing store crate");
    let out = run_probe(&ws);
    assert_pinned(&ws);
    assert_eq!(
        out,
        "created Some(Draft)\nsubmit true\nsubmit-again false\napprove true\nmissing false\nnow Some(Approved)\n"
    );
}
