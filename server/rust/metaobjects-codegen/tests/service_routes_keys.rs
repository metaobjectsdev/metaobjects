//! The transport over keys that are not `long`, and the route collisions `gen` refuses.
//!
//! The api-contract corpora key every entity by a `long`; this model keys one by text and one
//! by an `int`, so each route reads its key into the type the service takes. The compile gate
//! leaves the transport out (it is opt-in, and no port's gate builds its route tier), so this
//! test lists it and builds it.
//!
//! The tests that build their output share one target directory, where two workspaces' crates
//! of one name overwrite each other: each builds a package of its own.

mod common;

use std::path::PathBuf;

use common::{
    Scratch, assert_builds, assert_formatted, assert_pinned, cargo, generated_workspace, run_probe,
};
use metaobjects_codegen::generator_list::{GENERATOR_LIST_FILE, scaffold};
use metaobjects_codegen::{RunOptions, run, shipped_generators};

const KEYS: &str = r#"{ "metadata.root": { "package": "keys", "children": [
  { "object.entity": { "name": "Country", "children": [
    { "source.rdb": { "@table": "countries" } },
    { "field.string": { "name": "code", "@maxLength": 2 } },
    { "identity.primary": { "name": "pk", "@fields": ["code"] } },
    { "field.string": { "name": "title", "@required": true } },
    { "field.enum": { "name": "status", "@values": ["open", "closed"], "@default": "open", "children": [
      { "transition.action": { "name": "close", "@from": ["open"], "@to": "closed", "@public": true } }
    ] } }
  ] } },
  { "object.entity": { "name": "Region", "children": [
    { "source.rdb": { "@table": "regions" } },
    { "field.int": { "name": "id" } },
    { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
    { "field.string": { "name": "title", "@required": true } }
  ] } }
] } }"#;

fn project(tag: &str, model: &str) -> Scratch {
    let p = Scratch::project(tag, &[("metaobjects/meta.keys.json", model)]);
    p.write(GENERATOR_LIST_FILE, &scaffold(true));
    p
}

fn gen_run(p: &Scratch) -> Result<(), String> {
    let mut opts = RunOptions::new(p.path());
    opts.out_dir = PathBuf::from("generated");
    run(&opts, &shipped_generators())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[test]
fn text_and_int_keys_build_through_the_transport() {
    let p = project("routes-keys", KEYS);
    gen_run(&p).unwrap_or_else(|e| panic!("gen failed: {e}"));
    let lib = p.read("generated/keys_http/src/lib.rs");
    assert!(
        lib.contains("let id = id.as_str();"),
        "a text key is borrowed:\n{lib}"
    );
    assert!(
        lib.contains("let id: i32 = meta_http::int_key(&id)?;"),
        "an int key is read as an i32:\n{lib}"
    );
    let ws = generated_workspace("routes-keys-ws", &p, None);
    assert_builds(&ws, "the transport over text and int keys");
}

/// The keys model as the package `package`, with `api` among the root's children.
fn with_api(package: &str, api: &str) -> String {
    let model = KEYS.replacen(
        "\"package\": \"keys\"",
        &format!("\"package\": \"{package}\""),
        1,
    );
    let at = model.rfind("\n] } }").expect("the root's close");
    format!("{}{api}{}", &model[..at], &model[at..])
}

#[test]
fn a_declared_route_over_a_derived_one_is_refused() {
    // An API whose query takes the list route's own path and method.
    let api = r#",
  { "api.operational": { "name": "admin", "children": [
    { "operation.query": { "name": "allCountries", "@outputRef": "Country", "@many": true, "@public": true, "children": [
      { "binding.rest": { "@method": "GET", "@path": "/countries" } }
    ] } }
  ] } }"#;
    let e = gen_run(&project("routes-collide", &with_api("keys", api))).unwrap_err();
    assert!(
        e.contains("ERR_NAME_COLLISION") && e.contains("GET /countries"),
        "{e}"
    );
}

/// A get by key at the key's own name, where the derived route for the same row says `{id}`.
const BY_CODE: &str = r#",
  { "api.operational": { "name": "admin", "children": [
    { "operation.query": { "name": "byCode", "@outputRef": "Country", "@public": true, "children": [
      { "binding.rest": { "@method": "GET", "@path": "/countries/{code}" } }
    ] } }
  ] } }"#;

#[test]
fn a_declared_route_that_differs_from_a_derived_one_by_a_placeholder_name_is_refused() {
    // To axum the two paths are one route, and it refuses to mount the second.
    let e = gen_run(&project("routes-placeholder", &with_api("keys", BY_CODE))).unwrap_err();
    assert!(
        e.contains("ERR_NAME_COLLISION") && e.contains("get_country") && e.contains("by_code"),
        "{e}"
    );
}

/// A command on one country at the key's own name. The derived item route has no `POST`, so
/// the command and that route are mounted together.
const PUBLISH: &str = r#",
  { "object.value": { "name": "PublishInput", "children": [
    { "field.string": { "name": "code", "extends": "Country.code" } }
  ] } },
  { "api.operational": { "name": "admin", "children": [
    { "operation.command": { "name": "publish", "@inputRef": "PublishInput", "@outputRef": "Country", "@public": true, "children": [
      { "binding.rest": { "@path": "/countries/{code}" } }
    ] } }
  ] } }"#;

const PUBLISH_DEPENDENCIES: &str = "mounted = { path = \"../out/mounted\" }\n\
    mounted_contract = { path = \"../out/mounted_contract\" }\n\
    mounted_http = { path = \"../out/mounted_http\" }\n\
    mounted_service = { path = \"../out/mounted_service\" }\n\
    axum = { version = \"0.8\", default-features = false, features = [\"http1\", \"tokio\"] }\n\
    http-body-util = \"0.1\"\n\
    serde_json = \"1\"\n\
    sqlx = { version = \"0.8\", default-features = false, features = [\"sqlite\", \"runtime-tokio\"] }\n\
    tokio = { version = \"1\", features = [\"rt\", \"macros\"] }\n\
    tower = { version = \"0.5\", default-features = false, features = [\"util\"] }\n";

const PUBLISH_MAIN: &str = r##"
use axum::body::Body;
use axum::http::Request;
use http_body_util::BodyExt;
use tower::ServiceExt;

struct Bodies;

impl mounted_service::MountedBodies<(), sqlx::SqliteConnection> for Bodies {
    async fn publish<'a>(
        &'a self,
        _input: &'a mounted_contract::operations::PublishInput,
        _row: &'a mounted::Country,
        _cx: mounted_service::Cx<'a, (), sqlx::SqliteConnection>,
    ) -> mounted_service::PublishAnswer {
        Ok(())
    }
}

/// What `method uri` answers: the status, the error code, and two fields of the row.
async fn call(app: &axum::Router, method: &str, uri: &str, body: &'static str) -> String {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let answer = app.clone().oneshot(request).await.unwrap();
    let status = answer.status().as_u16();
    let text = answer.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&text);
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    format!("{status} {} {} {}", v["error"], v["code"], v["title"])
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"CREATE TABLE "countries" (
            "code" TEXT PRIMARY KEY NOT NULL,
            "title" TEXT NOT NULL,
            "status" TEXT NOT NULL
        );
        INSERT INTO "countries" ("code", "title", "status") VALUES ('FR', 'France', 'open');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let app = axum::Router::new().nest(
        "/api",
        mounted_http::router(mounted_service::MountedService::new(pool, Bodies), ()),
    );
    for (method, uri, body) in [
        ("POST", "/api/countries/FR", "{}"),
        ("GET", "/api/countries/FR", ""),
        ("POST", "/api/countries/XX", "{}"),
    ] {
        println!("{method} {uri} {}", call(&app, method, uri, body).await);
    }
}
"##;

/// `cargo check` accepts every generated crate and reports nothing for one of them: a file
/// under `out/` neither fails nor warns.
fn assert_generated_crates_are_silent(ws: &Scratch) {
    let check = cargo(ws.path(), &["check", "--workspace", "--all-targets", "-q"]);
    let said = String::from_utf8_lossy(&check.stderr);
    let ours: Vec<&str> = said.lines().filter(|l| l.contains("--> out/")).collect();
    assert!(
        check.status.success() && ours.is_empty(),
        "cargo check on the generated crates:\n{said}"
    );
}

#[test]
fn a_declared_route_that_shares_a_derived_paths_shape_under_another_method_serves_with_it() {
    let p = project("routes-merge", &with_api("mounted", PUBLISH));
    gen_run(&p).unwrap_or_else(|e| panic!("gen failed: {e}"));
    let ws = generated_workspace(
        "routes-merge-ws",
        &p,
        Some((PUBLISH_DEPENDENCIES, PUBLISH_MAIN)),
    );
    assert_formatted(&ws);
    assert_generated_crates_are_silent(&ws);
    assert_pinned(&ws);
    assert_eq!(
        run_probe(&ws),
        "POST /api/countries/FR 200 null \"FR\" \"France\"\n\
         GET /api/countries/FR 200 null \"FR\" \"France\"\n\
         POST /api/countries/XX 404 \"not_found\" null null\n"
    );
}
