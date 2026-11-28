//! The shared REST contract (`fixtures/api-contract-conformance/`) over HTTP, through the
//! generated transport: each sub-corpus is generated with the shipped generators, its
//! `service-routes` router is served by a probe on SQLite (the corpus's seed applied fresh for
//! every scenario), and every scenario's requests are sent to it and checked against what the
//! scenario expects.
//!
//! The Rust lane runs `core` (the root corpus), `write-through`, `secret-fields`, `list-query`
//! and `rules` with its settings variants. The rest are on [`LEDGER`]: what each needs is a
//! capability the Rust port does not have yet, and `docs/ports/rust.md` lists the same set.

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use common::{
    Scratch, assert_builds, assert_formatted, assert_pinned, cargo, generate_all,
    generated_workspace, target_dir,
};
use metaobjects_codegen::generator_list::GENERATOR_LIST_FILE;
use saphyr::{LoadableYamlNode, Scalar, Yaml};
use serde_json::Value;

/// The sub-corpora the Rust lane does not run, and what each needs.
const LEDGER: &[(&str, &str)] = &[
    ("tph", "single-table inheritance routes"),
    ("secret-fields/tph", "single-table inheritance routes"),
    (
        "m2m",
        "many-to-many traversal and junction writes on the served store",
    ),
    ("jsonb", "value objects stored as jsonb"),
    ("projection", "view-only projections"),
    ("report", "view-backed reports"),
    ("decimal", "decimal columns on the wire"),
    ("duration", "duration columns on the wire"),
    (
        "api-settings",
        "the api block's pagination and unknown-field settings",
    ),
    ("enum-default", "an enum's declared default on create"),
];

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/api-contract-conformance")
}

/// One sub-corpus as the runner serves it.
struct Corpus {
    tag: &'static str,
    /// Its directory under the corpus root (`""` for the root corpus).
    dir: &'static str,
    /// The `.metaobjects/config.json` the project takes, relative to the corpus root.
    config: Option<&'static str>,
    /// The scenarios' directory, relative to the corpus root.
    scenarios: &'static str,
    /// The SQLite tables (and views) the model's sources name.
    schema: &'static str,
    /// The probe's `corpus` module: `TABLES` (each seed key and the store's table) and `app`.
    module: &'static str,
    crates: &'static [&'static str],
}

const ROOT_CONFIG: &str = ".metaobjects/config.json";

const CORE_SCHEMA: &str = r#"CREATE TABLE "authors" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "bio" TEXT,
    "createdAt" TEXT NOT NULL,
    "issuedCurrency" TEXT,
    "autoCreatedAt" TEXT,
    "autoUpdatedAt" TEXT
);
"#;

const CORE_MODULE: &str = r#"
pub const TABLES: &[(&str, &meta_store::Table)] = &[("rows", &acme_blog_store::author::TABLE)];

pub fn app(pool: sqlx::SqlitePool) -> axum::Router {
    acme_blog_http::router(acme_blog_service::BlogService::<_, ()>::new(pool), ())
}
"#;

const WRITE_THROUGH_SCHEMA: &str = r#"CREATE TABLE "customers" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL
);
CREATE TABLE "orders" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "customerId" INTEGER NOT NULL REFERENCES "customers" ("id")
);
CREATE VIEW "v_order_with_customer" AS
    SELECT o."id" AS "id", o."customerId" AS "customerId", c."name" AS "customerName"
    FROM "orders" o JOIN "customers" c ON c."id" = o."customerId";
"#;

const WRITE_THROUGH_MODULE: &str = r#"
pub const TABLES: &[(&str, &meta_store::Table)] = &[
    ("customers", &acme_orders_store::customer::TABLE),
    ("orders", &acme_orders_store::order::TABLE),
];

pub fn app(pool: sqlx::SqlitePool) -> axum::Router {
    acme_orders_http::router(acme_orders_service::OrdersService::<_, ()>::new(pool), ())
}
"#;

const SECRET_SCHEMA: &str = r#"CREATE TABLE "accounts" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT,
    "pinHash" TEXT,
    "role" TEXT
);
"#;

const SECRET_MODULE: &str = r#"
pub const TABLES: &[(&str, &meta_store::Table)] = &[("rows", &acme_secrets_store::account::TABLE)];

pub fn app(pool: sqlx::SqlitePool) -> axum::Router {
    acme_secrets_http::router(acme_secrets_service::SecretsService::<_, ()>::new(pool), ())
}
"#;

const LIST_QUERY_SCHEMA: &str = r#"CREATE TABLE "parts" (
    "id" INTEGER PRIMARY KEY NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL UNIQUE,
    "category" TEXT NOT NULL,
    "stock" INTEGER NOT NULL,
    "notes" TEXT
);
"#;

const LIST_QUERY_MODULE: &str = r#"
pub const TABLES: &[(&str, &meta_store::Table)] = &[("rows", &acme_stockroom_store::part::TABLE)];

pub fn app(pool: sqlx::SqlitePool) -> axum::Router {
    acme_stockroom_http::router(acme_stockroom_service::StockroomService::<_, ()>::new(pool), ())
}
"#;

const RULES_SCHEMA: &str = r#"CREATE TABLE "purchase_requests" (
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
"#;

/// The rules corpus's actor, read from `x-actor` and `x-grants`, and its service.
const RULES_MODULE: &str = r#"
pub const TABLES: &[(&str, &meta_store::Table)] =
    &[("purchaseRequests", &acme_purchasing_store::purchase_request::TABLE)];

fn header(h: &axum::http::HeaderMap, name: &str) -> String {
    h.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// `x-actor` names the actor (absent or empty: none), `x-grants` lists what it holds.
fn read_actor(h: &axum::http::HeaderMap) -> Option<Actor> {
    let name = header(h, "x-actor");
    if name.is_empty() {
        return None;
    }
    let grants = header(h, "x-grants");
    let grants: Vec<&str> = grants.split(',').map(str::trim).filter(|g| !g.is_empty()).collect();
    Some(actor(&name, &grants))
}

pub fn app(pool: sqlx::SqlitePool) -> axum::Router {
    let service =
        PurchasingService::new(pool, Grants, Bodies).with_hooks(Hooks).with_events(Audit);
    acme_purchasing_http::router(service, meta_http::ActorFn(read_actor))
}
"#;

const RULES_CRATES: &[&str] = &[
    "acme_purchasing",
    "acme_purchasing_contract",
    "acme_purchasing_rules",
    "acme_purchasing_service",
    "acme_purchasing_store",
    "acme_purchasing_http",
];

fn corpora() -> Vec<Corpus> {
    let rules = |tag, config, scenarios| Corpus {
        tag,
        dir: "rules",
        config,
        scenarios,
        schema: RULES_SCHEMA,
        module: RULES_MODULE,
        crates: RULES_CRATES,
    };
    vec![
        Corpus {
            tag: "core",
            dir: "",
            config: Some(ROOT_CONFIG),
            scenarios: "scenarios",
            schema: CORE_SCHEMA,
            module: CORE_MODULE,
            crates: &["acme_blog_store", "acme_blog_service", "acme_blog_http"],
        },
        Corpus {
            tag: "write-through",
            dir: "write-through",
            config: Some(ROOT_CONFIG),
            scenarios: "write-through/scenarios",
            schema: WRITE_THROUGH_SCHEMA,
            module: WRITE_THROUGH_MODULE,
            crates: &[
                "acme_orders_store",
                "acme_orders_service",
                "acme_orders_http",
            ],
        },
        Corpus {
            tag: "secret-fields",
            dir: "secret-fields",
            config: Some(ROOT_CONFIG),
            scenarios: "secret-fields/scenarios",
            schema: SECRET_SCHEMA,
            module: SECRET_MODULE,
            crates: &[
                "acme_secrets_store",
                "acme_secrets_service",
                "acme_secrets_http",
            ],
        },
        Corpus {
            tag: "list-query",
            dir: "list-query",
            config: Some(ROOT_CONFIG),
            scenarios: "list-query/scenarios",
            schema: LIST_QUERY_SCHEMA,
            module: LIST_QUERY_MODULE,
            crates: &[
                "acme_stockroom_store",
                "acme_stockroom_service",
                "acme_stockroom_http",
            ],
        },
        rules("rules", None, "rules/scenarios"),
        rules(
            "rules-commands-all",
            Some("rules/settings/commands-all/.metaobjects/config.json"),
            "rules/settings/commands-all/scenarios",
        ),
        rules(
            "rules-commands-none",
            Some("rules/settings/commands-none/.metaobjects/config.json"),
            "rules/settings/commands-none/scenarios",
        ),
        rules(
            "rules-create-any",
            Some("rules/settings/create-any/.metaobjects/config.json"),
            "rules/settings/create-any/scenarios",
        ),
    ]
}

/// What every probe runs: a fresh in-memory database holding the corpus's tables and seed, and
/// the corpus's router under `/api`, on a port it prints.
const PROBE_MAIN: &str = r#"
mod corpus;

use serde_json::Value;
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

async fn seed(pool: &SqlitePool) {
    let seed: Value = serde_json::from_str(include_str!("../seed.json")).unwrap();
    for (key, table) in corpus::TABLES {
        let Some(rows) = seed[*key].as_array() else { continue };
        for row in rows {
            let row = row.as_object().unwrap();
            let columns: Vec<String> = row
                .keys()
                .map(|k| {
                    let c = table.columns.iter().find(|c| c.field == k).unwrap();
                    format!("\"{}\"", c.column)
                })
                .collect();
            let marks = vec!["?"; columns.len()].join(", ");
            let sql =
                format!("INSERT INTO \"{}\" ({}) VALUES ({marks})", table.name, columns.join(", "));
            let mut q = sqlx::query(&sql);
            for v in row.values() {
                q = match v {
                    Value::Null => q.bind(None::<String>),
                    Value::Bool(b) => q.bind(i64::from(*b)),
                    Value::Number(n) if n.is_i64() => q.bind(n.as_i64().unwrap()),
                    Value::Number(n) => q.bind(n.as_f64().unwrap()),
                    Value::String(s) => q.bind(s.clone()),
                    other => q.bind(other.to_string()),
                };
            }
            q.execute(pool).await.unwrap();
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!("../schema.sql")).execute(&pool).await.unwrap();
    if std::env::var_os("PROBE_EMPTY").is_none() {
        seed(&pool).await;
    }
    let app = axum::Router::new().nest("/api", corpus::app(pool));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!("{}", listener.local_addr().unwrap());
    use std::io::Write;
    std::io::stdout().flush().unwrap();
    axum::serve(listener, app).await.unwrap();
}
"#;

fn probe_dependencies(c: &Corpus) -> String {
    let mut deps: Vec<String> = c
        .crates
        .iter()
        .chain(&["meta_http", "meta_store"])
        .map(|name| format!("{name} = {{ path = \"../out/{name}\" }}\n"))
        .collect();
    deps.push(
        "axum = { version = \"0.8\", default-features = false, features = [\"http1\", \"tokio\"] }\n"
            .to_string(),
    );
    deps.push("serde = \"1\"\nserde_json = \"1\"\n".to_string());
    deps.push(
        "sqlx = { version = \"0.8\", default-features = false, features = [\"sqlite\", \"runtime-tokio\"] }\n"
            .to_string(),
    );
    deps.push(
        "tokio = { version = \"1\", features = [\"rt\", \"macros\", \"net\"] }\n".to_string(),
    );
    deps.concat()
}

fn json_of(y: &Yaml) -> Value {
    match y {
        Yaml::Value(Scalar::Null) => Value::Null,
        Yaml::Value(Scalar::Boolean(b)) => Value::Bool(*b),
        Yaml::Value(Scalar::Integer(i)) => Value::from(*i),
        Yaml::Value(Scalar::FloatingPoint(f)) => Value::from(f.into_inner()),
        Yaml::Value(Scalar::String(s)) => Value::String(s.to_string()),
        Yaml::Sequence(items) => Value::Array(items.iter().map(json_of).collect()),
        Yaml::Mapping(map) => Value::Object(
            map.iter()
                .map(|(k, v)| {
                    let key = match json_of(k) {
                        Value::String(s) => s,
                        other => other.to_string(),
                    };
                    (key, json_of(v))
                })
                .collect(),
        ),
        other => panic!("a scenario holds no {other:?}"),
    }
}

/// Every scenario of a directory, by file stem, in name order.
fn scenarios(dir: &Path) -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let path = e.unwrap().path();
        if path.extension().and_then(|x| x.to_str()) != Some("yaml") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let docs = Yaml::load_from_str(&text).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        out.push((stem, json_of(&docs[0])));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// A served probe, stopped when dropped.
struct Server {
    child: Child,
    addr: String,
}

impl Server {
    fn start(binary: &Path, empty: bool) -> Server {
        let mut cmd = Command::new(binary);
        cmd.stdout(Stdio::piped()).stderr(Stdio::inherit());
        if empty {
            cmd.env("PROBE_EMPTY", "1");
        }
        let mut child = cmd.spawn().expect("the probe starts");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        Server {
            child,
            addr: line.trim().to_string(),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One HTTP/1.1 exchange: the status and the body.
fn send(
    addr: &str,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> (u16, String) {
    let mut stream = TcpStream::connect(addr).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: probe\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(b) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    stream.write_all(req.as_bytes()).unwrap();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let chunked = head.lines().any(|l| {
        l.to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked")
    });
    let body = if chunked {
        dechunk(rest)
    } else {
        rest.to_string()
    };
    (status, body)
}

fn dechunk(mut rest: &str) -> String {
    let mut out = String::new();
    while let Some((size, after)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&after[..n]);
        rest = &after[n + 2..];
    }
    out
}

/// What a response breaks of `expect`, or nothing.
fn check(status: u16, text: &str, expect: &Value) -> Vec<String> {
    let mut faults = Vec::new();
    let want = expect["status"].as_u64().unwrap_or(0) as u16;
    if status != want {
        faults.push(format!("status {status}, expected {want}"));
    }
    let Some(spec) = expect.get("body").and_then(Value::as_object) else {
        return faults;
    };
    if spec.get("empty") == Some(&Value::Bool(true)) {
        if !text.trim().is_empty() {
            faults.push(format!("a body where none was expected: {text}"));
        }
        return faults;
    }
    let body: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            faults.push(format!("the body is not JSON: {text:?}"));
            return faults;
        }
    };
    let mut fault = |ok: bool, what: String| {
        if !ok {
            faults.push(what);
        }
    };
    for (key, want) in spec {
        match key.as_str() {
            "equals" => fault(&body == want, format!("body {body}, expected {want}")),
            "length" => fault(
                body.as_array().map(Vec::len) == want.as_u64().map(|n| n as usize),
                format!("length of {body}, expected {want}"),
            ),
            "ids" | "names" => {
                let field = if key == "ids" { "id" } else { "name" };
                let got: Vec<Value> = body
                    .as_array()
                    .map(|rows| rows.iter().map(|r| r[field].clone()).collect())
                    .unwrap_or_default();
                fault(
                    &Value::Array(got.clone()) == want,
                    format!("{key} {got:?}, expected {want}"),
                );
            }
            "row" => {
                for (k, v) in want.as_object().unwrap() {
                    fault(
                        &body[k] == v,
                        format!("row.{k} is {}, expected {v}", body[k]),
                    );
                }
            }
            "hasId" => fault(body["id"].is_number(), format!("no numeric id in {body}")),
            "envelope" => fault(
                body["rows"].is_array() && body.get("total").is_some(),
                format!("not an envelope: {body}"),
            ),
            "rowsLength" => fault(
                body["rows"].as_array().map(Vec::len) == want.as_u64().map(|n| n as usize),
                format!("rows length of {body}, expected {want}"),
            ),
            "total" => fault(
                &body["total"] == want,
                format!("total {}, expected {want}", body["total"]),
            ),
            "error" => fault(
                &body["error"] == want,
                format!("error {}, expected {want}", body["error"]),
            ),
            "field" => fault(
                &body["field"] == want,
                format!("field {}, expected {want}", body["field"]),
            ),
            "absent" => {
                for k in want.as_array().unwrap() {
                    let k = k.as_str().unwrap();
                    fault(body.get(k).is_none(), format!("{k} is present in {body}"));
                }
            }
            "unset" => {
                for k in want.as_array().unwrap() {
                    let k = k.as_str().unwrap();
                    fault(body[k].is_null(), format!("{k} is set in {body}"));
                }
            }
            "fieldsEqual" | "fieldsNotEqual" => {
                let names: Vec<&str> = want
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                let same = names.windows(2).all(|w| body[w[0]] == body[w[1]]);
                let ok = if key == "fieldsEqual" { same } else { !same };
                fault(ok, format!("{key} {names:?} in {body}"));
            }
            "issues" => {
                let issues = body["issues"].as_array().cloned().unwrap_or_default();
                for w in want.as_array().unwrap() {
                    let found = issues
                        .iter()
                        .any(|i| w.as_object().unwrap().iter().all(|(k, v)| &i[k] == v));
                    fault(found, format!("no issue {w} in {body}"));
                }
            }
            other => panic!("the runner does not know the assertion {other:?}"),
        }
    }
    faults
}

fn run_scenario(binary: &Path, name: &str, doc: &Value) -> Vec<String> {
    let empty = doc["setup"]["truncate"] == Value::Bool(true);
    let server = Server::start(binary, empty);
    let mut faults = Vec::new();
    for r in doc["requests"].as_array().unwrap() {
        let id = r["id"].as_str().unwrap_or("?");
        let method = r["method"].as_str().unwrap();
        let path = r["path"].as_str().unwrap();
        let headers: Vec<(String, String)> = r["headers"]
            .as_object()
            .map(|h| {
                h.iter()
                    .map(|(k, v)| {
                        (
                            k.clone(),
                            v.as_str().map_or_else(|| v.to_string(), str::to_string),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let body = match (r.get("rawBody"), r.get("body")) {
            (Some(raw), _) => Some(raw.as_str().unwrap().to_string()),
            (None, Some(b)) => Some(b.to_string()),
            _ => None,
        };
        let (status, text) = send(&server.addr, method, path, &headers, body.as_deref());
        for f in check(status, &text, &r["expect"]) {
            faults.push(format!("{name} {id} {method} {path}: {f}"));
        }
    }
    faults
}

fn run_corpus(c: &Corpus) {
    let root = corpus_dir();
    let dir = root.join(c.dir);
    let mut files = vec![(
        "metaobjects/meta.json".to_string(),
        std::fs::read_to_string(dir.join("meta.json")).unwrap(),
    )];
    if let Some(config) = c.config {
        files.push((
            ROOT_CONFIG.to_string(),
            std::fs::read_to_string(root.join(config)).unwrap(),
        ));
    }
    // The transport is opt-in: the project lists it, as `cargo meta init --transport` does.
    files.push((
        GENERATOR_LIST_FILE.to_string(),
        common::crate_generator_list(),
    ));
    let files: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, t)| (p.as_str(), t.as_str()))
        .collect();
    let project = Scratch::project(&format!("api-{}", c.tag), &files);
    generate_all(&project, &[]);
    let deps = probe_dependencies(c);
    let ws = generated_workspace(
        &format!("api-{}-ws", c.tag),
        &project,
        Some((&deps, PROBE_MAIN)),
    );
    // Each corpus's probe is its own package, so their binaries never overwrite each other.
    let package = format!("probe_{}", c.tag.replace('-', "_"));
    ws.write(
        "probe/Cargo.toml",
        &format!(
            "[package]\nname = \"{package}\"\nversion = \"0.0.0\"\nedition = \"2021\"\npublish = false\n\n[dependencies]\n{deps}"
        ),
    );
    let pieces = if c.dir == "rules" {
        include_str!("common/rules_pieces.rs")
    } else {
        ""
    };
    ws.write(
        "probe/src/corpus.rs",
        &format!("#![allow(dead_code, unused_imports)]\n{pieces}{}", c.module),
    );
    ws.write("probe/schema.sql", c.schema);
    ws.write(
        "probe/seed.json",
        &std::fs::read_to_string(dir.join("seed.json")).unwrap(),
    );
    if c.tag == "core" {
        assert_formatted(&ws);
    }
    assert_builds(&ws, &format!("the {} corpus", c.tag));
    let built = cargo(ws.path(), &["build", "-q", "-p", &package]);
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    assert_pinned(&ws);
    let binary = target_dir().join("debug").join(&package);
    let mut faults = Vec::new();
    let list = scenarios(&root.join(c.scenarios));
    assert!(!list.is_empty(), "{} has no scenarios", c.scenarios);
    let mut requests = 0;
    for (name, doc) in &list {
        requests += doc["requests"].as_array().map_or(0, Vec::len);
        faults.extend(run_scenario(&binary, name, doc));
    }
    eprintln!("{}: {} scenarios, {requests} requests", c.tag, list.len());
    assert!(
        faults.is_empty(),
        "{} corpus:\n{}",
        c.tag,
        faults.join("\n")
    );
}

#[test]
fn the_generated_transport_answers_the_shared_rest_contract() {
    for c in corpora() {
        run_corpus(&c);
    }
}

#[test]
fn every_sub_corpus_is_run_or_ledgered() {
    let mut run: Vec<String> = corpora().iter().map(|c| c.dir.to_string()).collect();
    run.extend(LEDGER.iter().map(|(d, _)| d.to_string()));
    for e in std::fs::read_dir(corpus_dir()).unwrap() {
        let e = e.unwrap();
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.path().is_dir() || name == "scenarios" || name.starts_with('.') {
            continue;
        }
        assert!(
            run.contains(&name),
            "the sub-corpus {name} is neither run nor on the ledger"
        );
    }
}
