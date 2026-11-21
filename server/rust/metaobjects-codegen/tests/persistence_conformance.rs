//! The shared persistence corpus (`fixtures/persistence-conformance/queries`) through the
//! generated store crates, on a throwaway Postgres.
//!
//! The runner protocol is the corpus README's: per scenario a fresh database, the committed
//! `canonical/schema.postgres.sql`, the scenario's `seed-data`, then each query through the
//! port's persistence layer, normalized by `normalization.md` and compared with its `expect`.
//! Here the persistence layer is the code `repository` generates for `canonical/meta.fitness.json`:
//! a probe crate calls each entity's `list`, `count`, `get`, `create`, `update` and `delete`, and
//! the expected rows are the corpus's own, so the oracle is shared with every other port.
//!
//! Postgres runs in `docker run --rm` on a capped tmpfs with durability off, and is removed when
//! the test ends, pass or fail. Without docker the test says so and passes: it cannot run, and
//! the SQLite probe (`tests/repository.rs`) still covers the store. Scenarios this port does not
//! run yet are in [`LEDGER`] with the reason; the ledger only shrinks, because a scenario on it
//! that passes fails the test until it is taken off.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use saphyr::{LoadableYamlNode, Scalar, Yaml};
use serde_json::{Map, Value};

use common::{Scratch, assert_builds, assert_pinned, cargo, generate_all, generated_workspace};

const CORPUS: &str = "../../../fixtures/persistence-conformance";

const M2N: &str = "op: relate (many-to-many traversal) has no store function yet";

/// Scenarios not run yet, with what is missing. Shrink-only.
const LEDGER: &[(&str, &str)] = &[
    ("m2n-directed-self-join", M2N),
    ("m2n-hetero", M2N),
    ("m2n-symmetric-self-join", M2N),
];

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(CORPUS)
}

// ---- the throwaway Postgres ----------------------------------------------------------

/// A Postgres container, removed on drop.
struct Postgres {
    id: String,
    url: String,
}

impl Drop for Postgres {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "-f", "-v", &self.id])
            .output();
    }
}

fn docker(args: &[&str]) -> Option<String> {
    let out = Command::new("docker").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The image `MO_RUST_PG_IMAGE` names, by default `postgres:18-alpine`, whose data directory is
/// under `/var/lib/postgresql`: that is where the tmpfs goes.
fn start_postgres() -> Option<Postgres> {
    docker(&["info", "--format", "{{.ServerVersion}}"])?;
    let image = std::env::var("MO_RUST_PG_IMAGE").unwrap_or_else(|_| "postgres:18-alpine".into());
    let id = docker(&[
        "run",
        "-d",
        "--rm",
        "--label",
        "dev.metaobjects.rust-persistence-conformance=1",
        "--tmpfs",
        "/var/lib/postgresql:rw,size=2g",
        "-e",
        "POSTGRES_PASSWORD=test",
        "-p",
        "127.0.0.1::5432",
        &image,
        "-c",
        "fsync=off",
        "-c",
        "synchronous_commit=off",
        "-c",
        "full_page_writes=off",
    ])
    .unwrap_or_else(|| panic!("docker could not start {image}"));
    let mut pg = Postgres {
        id,
        url: String::new(),
    };
    let port = docker(&["port", &pg.id, "5432/tcp"]).expect("the published port");
    let port = port
        .lines()
        .next()
        .unwrap()
        .rsplit(':')
        .next()
        .unwrap()
        .to_string();
    let started = Instant::now();
    // Over TCP: the image's first, init-time server listens on the socket only.
    while docker(&[
        "exec",
        &pg.id,
        "pg_isready",
        "-q",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
    ])
    .is_none()
    {
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "Postgres did not come up"
        );
        std::thread::sleep(Duration::from_millis(250));
    }
    pg.url = format!("postgres://postgres:test@127.0.0.1:{port}");
    Some(pg)
}

// ---- the scenarios -------------------------------------------------------------------

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

/// Every query scenario Postgres runs, by file stem: an `engines:` list is exact, and without
/// one Postgres runs every scenario.
fn scenarios() -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for e in std::fs::read_dir(corpus().join("queries")).unwrap() {
        let path = e.unwrap().path();
        if path.extension().and_then(|x| x.to_str()) != Some("yaml") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        let docs = Yaml::load_from_str(&text).unwrap_or_else(|e| panic!("{path:?}: {e}"));
        let doc = json_of(&docs[0]);
        if let Some(engines) = doc.get("engines").and_then(Value::as_array)
            && !engines.iter().any(|e| e == "postgres")
        {
            continue;
        }
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        out.insert(stem, doc);
    }
    out
}

// ---- the probe -----------------------------------------------------------------------

const PROBE_DEPENDENCIES: &str = "fitness = { path = \"../out/fitness\" }\n\
    fitness_store = { path = \"../out/fitness_store\" }\n\
    meta_store = { path = \"../out/meta_store\" }\n\
    serde = { version = \"1\", features = [\"derive\"] }\n\
    serde_json = \"1\"\n\
    sqlx = { version = \"0.8\", default-features = false, features = [\"postgres\", \"runtime-tokio\"] }\n\
    tokio = { version = \"1\", features = [\"rt\", \"macros\"] }\n";

/// The probe: runs the scenarios in `argv[2]` against the server at `argv[1]` and prints one
/// JSON line per query, `{"ok": <normalized result>}` or `{"err": <message>}`. `ENTITIES` is
/// replaced by one dispatch arm per entity the store crate has.
const PROBE_MAIN: &str = r##"
use meta_store::{Filter, Kind, Query, Sort, Table};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use sqlx::{Connection, PgConnection};

type R = Result<Value, String>;

fn e(err: meta_store::StoreError) -> String {
    err.to_string()
}

fn filter(s: &Value) -> Result<Option<Filter>, String> {
    s.get("filter").map(|f| Filter::from_json(f).map_err(e)).transpose()
}

fn query(s: &Value) -> Result<Query, String> {
    let sort = s.get("sort").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .map(|i| Sort {
                field: i["field"].as_str().unwrap().to_string(),
                descending: i.get("dir").and_then(Value::as_str) == Some("desc"),
            })
            .collect()
    });
    Ok(Query {
        filter: filter(s)?,
        sort: sort.unwrap_or_default(),
        limit: s.get("limit").and_then(Value::as_u64),
        offset: s.get("offset").and_then(Value::as_u64),
    })
}

/// A write body: every key must be a field the table stores, a 64-bit integer given as its
/// base-10 text (the corpus's form for one past 2^53) becomes the number the model holds, and
/// a JSON value for a string the model keeps in a `jsonb` column becomes its text.
fn coerced(t: &Table, v: Option<&Value>) -> Result<Map<String, Value>, String> {
    let mut map = v.and_then(Value::as_object).cloned().unwrap_or_default();
    for (k, v) in map.iter_mut() {
        let column = t.column(k).map_err(e)?;
        if column.stored_as == Some("jsonb") && !v.is_string() && !v.is_null() {
            *v = Value::String(v.to_string());
        }
        if column.kind == Kind::Long {
            let one = |x: &mut Value| {
                if let Some(i) = x.as_str().and_then(|s| s.parse::<i64>().ok()) {
                    *x = Value::from(i);
                }
            };
            match v {
                Value::Array(items) => items.iter_mut().for_each(one),
                other => one(other),
            }
        }
    }
    Ok(map)
}

fn body<B: DeserializeOwned>(t: &Table, v: Option<&Value>) -> Result<B, String> {
    serde_json::from_value(Value::Object(coerced(t, v)?)).map_err(|err| err.to_string())
}

/// The normalized wire form of one row (normalization.md): a 64-bit integer and a float become
/// strings, the plain decimal of the float; the other kinds are already in their wire form.
thread_local! {
    /// The SQL type of each `table.column`, from `information_schema`: normalization.md is by
    /// the column's type, which for a view's aggregate is not always the field's (MIN of an
    /// INTEGER column is an INTEGER even on a `field.long`).
    static SQL_TYPES: std::cell::RefCell<std::collections::HashMap<String, String>> =
        Default::default();
}

fn sql_type(t: &Table, column: &str) -> Option<String> {
    SQL_TYPES.with(|m| m.borrow().get(&format!("{}.{column}", t.name)).cloned())
}

fn row(t: &Table, v: Value) -> Value {
    let Value::Object(mut map) = v else { return v };
    for (k, v) in map.iter_mut() {
        let Ok(column) = t.column(k) else { continue };
        if matches!(sql_type(t, column.column).as_deref(), Some("integer" | "smallint")) {
            continue;
        }
        // normalization.md is by SQL type: a jsonb column reads as JSON.
        if column.stored_as == Some("jsonb") {
            if let Some(parsed) = v.as_str().and_then(|x| serde_json::from_str(x).ok()) {
                *v = parsed;
            }
            continue;
        }
        let one = |x: &mut Value| match column.kind {
            Kind::Long => {
                if let Some(i) = x.as_i64() {
                    *x = Value::String(i.to_string());
                }
            }
            Kind::Double | Kind::Float => {
                if let Some(f) = x.as_f64() {
                    *x = Value::String(format!("{f}"));
                }
            }
            _ => {}
        };
        match v {
            Value::Array(items) if column.array => items.iter_mut().for_each(one),
            other => one(other),
        }
    }
    Value::Object(map)
}

fn out<T: serde::Serialize>(t: &Table, v: T) -> Value {
    match serde_json::to_value(v).unwrap() {
        Value::Array(rows) => Value::Array(rows.into_iter().map(|r| row(t, r)).collect()),
        other => row(t, other),
    }
}

/// The one value of a `by`: `{ id: 1 }`, or a projection's `{ programId: 1 }`.
fn by(s: &Value) -> &Value {
    s["by"].as_object().and_then(|m| m.values().next()).unwrap_or(&Value::Null)
}

fn key_i64(s: &Value) -> Result<i64, String> {
    let id = by(s);
    id.as_i64().or_else(|| id.as_str().and_then(|x| x.parse().ok())).ok_or("no integer id".into())
}

fn key_str(s: &Value) -> Result<String, String> {
    let id = by(s);
    Ok(id.as_str().map(str::to_string).unwrap_or_else(|| id.to_string()))
}

macro_rules! key {
    (i64, $v:expr) => { key_i64($v)? };
    (str, $v:expr) => { &key_str($v)? };
}

/// A create through the generated `create`; when the scenario names the key, which a create
/// body never carries (the key is generated), the body is still checked by its type and the
/// key is added to it on the same write path.
macro_rules! create {
    ($c:expr, $t:expr, $st:ident, $row:ident, $create:ident, $data:expr) => {{
        let map = coerced($t, $data)?;
        let b: fitness::$create =
            serde_json::from_value(Value::Object(map.clone())).map_err(|x| x.to_string())?;
        let mut v = serde_json::to_value(&b).unwrap();
        let key = $t.key.filter(|k| v.get(*k).is_none()).and_then(|k| map.get(k).map(|x| (k, x)));
        match key {
            Some((k, x)) => {
                v[k] = x.clone();
                meta_store::create::<fitness::$row, _, _>($c, $t, &v).await.map_err(e)?
            }
            None => $st::create($c, &b).await.map_err(e)?,
        }
    }};
}

macro_rules! entity {
    ($c:expr, $s:expr, $m:ident, read $(, $k:tt)?) => {{
        use fitness_store::$m as st;
        let t = &st::TABLE;
        match $s["op"].as_str().unwrap() {
            "list" => Ok(out(t, st::list($c, &query($s)?).await.map_err(e)?)),
            "count" => Ok(json!(st::count($c, filter($s)?.as_ref()).await.map_err(e)?)),
            $("get" => Ok(out(t, st::get($c, key!($k, $s)).await.map_err(e)?)),)?
            op => Err(format!("{op} on a read model")),
        }
    }};
    ($c:expr, $s:expr, $m:ident, $row:ident, $create:ident, nokey) => {{
        use fitness_store::$m as st;
        let t = &st::TABLE;
        match $s["op"].as_str().unwrap() {
            "list" => Ok(out(t, st::list($c, &query($s)?).await.map_err(e)?)),
            "count" => Ok(json!(st::count($c, filter($s)?.as_ref()).await.map_err(e)?)),
            "create" => {
                let b: fitness::$create = body(t, $s.get("data"))?;
                Ok(out(t, st::create($c, &b).await.map_err(e)?))
            }
            op => Err(format!("{op} on a keyless entity")),
        }
    }};
    ($c:expr, $s:expr, $m:ident, $row:ident, $create:ident, $patch:ident, $k:tt) => {{
        use fitness_store::$m as st;
        let t = &st::TABLE;
        match $s["op"].as_str().unwrap() {
            "list" => Ok(out(t, st::list($c, &query($s)?).await.map_err(e)?)),
            "count" => Ok(json!(st::count($c, filter($s)?.as_ref()).await.map_err(e)?)),
            "get" => Ok(out(t, st::get($c, key!($k, $s)).await.map_err(e)?)),
            "create" => Ok(out(t, create!($c, t, st, $row, $create, $s.get("data")))),
            "update" => {
                let p: fitness::$patch = body(t, $s.get("data"))?;
                match st::update($c, key!($k, $s), &p).await.map_err(e)? {
                    Some(r) => Ok(out(t, r)),
                    None => Err("no row to update".into()),
                }
            }
            "delete" => Ok(json!(st::delete($c, key!($k, $s)).await.map_err(e)?)),
            "roundtrip" => {
                let created = create!($c, t, st, $row, $create, $s.get("insert"));
                let created = serde_json::to_value(created).unwrap();
                let key = t.key.unwrap();
                let by = json!({ "by": { "id": created[key].clone() } });
                let read = st::get($c, key!($k, &by)).await.map_err(e)?.ok_or("not read back")?;
                let mut read = out(t, read);
                read.as_object_mut().unwrap().remove(key);
                Ok(read)
            }
            op => Err(format!("{op} is not run on this port")),
        }
    }};
}

async fn step(c: &mut PgConnection, s: &Value) -> R {
    match s["entity"].as_str().unwrap_or("") {
        ENTITIES
        other => Err(format!("no store for {other}")),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let url = &args[1];
    let scenarios: Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();
    let schema = std::fs::read_to_string(&args[3]).unwrap();
    let mut admin = PgConnection::connect(&format!("{url}/postgres")).await.unwrap();
    for (n, (name, scenario)) in scenarios.iter().enumerate() {
        let db = format!("s{n}");
        sqlx::raw_sql(&format!("CREATE DATABASE {db}")).execute(&mut admin).await.unwrap();
        let mut c = PgConnection::connect(&format!("{url}/{db}")).await.unwrap();
        sqlx::raw_sql(&schema).execute(&mut c).await.unwrap();
        if n == 0 {
            let types: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT table_name::text, column_name::text, data_type::text FROM information_schema.columns WHERE table_schema = 'public'",
            )
            .fetch_all(&mut c)
            .await
            .unwrap();
            SQL_TYPES.with(|m| {
                m.borrow_mut()
                    .extend(types.into_iter().map(|(t, col, ty)| (format!("{t}.{col}"), ty)))
            });
        }
        let seeded = match scenario.get("seed-data").and_then(Value::as_str) {
            Some(seed) => sqlx::raw_sql(seed).execute(&mut c).await.map(|_| ()).map_err(|x| x.to_string()),
            None => Ok(()),
        };
        for q in scenario["queries"].as_array().unwrap() {
            let got = match &seeded {
                Err(x) => Err(format!("seed: {x}")),
                Ok(()) => step(&mut c, q).await,
            };
            let line = match got {
                Ok(v) => json!({ "scenario": name, "query": q["name"], "ok": v }),
                Err(x) => json!({ "scenario": name, "query": q["name"], "err": x }),
            };
            println!("{line}");
        }
        c.close().await.unwrap();
        sqlx::raw_sql(&format!("DROP DATABASE {db}")).execute(&mut admin).await.unwrap();
    }
}
"##;

/// One dispatch arm per module of the generated store crate: its object, row, create and patch
/// types, and the key's type, read off the generated functions' signatures.
fn entity_arms(store: &Path) -> String {
    let mut arms = String::new();
    let mut files: Vec<_> = std::fs::read_dir(store.join("src"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.file_name().unwrap() != "lib.rs")
        .collect();
    files.sort();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        let module = f.file_stem().unwrap().to_string_lossy().into_owned();
        let object = text
            .split("object: \"")
            .nth(1)
            .and_then(|r| r.split('"').next())
            .expect("TABLE names its object")
            .to_string();
        let get = text.split("pub async fn get<").nth(1);
        let key = get.map(|g| {
            if g.split(')').next().unwrap().contains("id: &str") {
                "str"
            } else {
                "i64"
            }
        });
        if text.contains("writable: false") {
            let key = key.map(|k| format!(", {k}")).unwrap_or_default();
            arms.push_str(&format!(
                "        \"{object}\" => entity!(c, s, {module}, read{key}),\n"
            ));
            continue;
        }
        let tail = match key {
            Some(k) => format!("{object}Patch, {k}"),
            None => "nokey".into(),
        };
        arms.push_str(&format!(
            "        \"{object}\" => entity!(c, s, {module}, {object}, {object}Create, {tail}),\n"
        ));
    }
    arms
}

#[test]
fn the_persistence_corpus_reads_and_writes_through_the_generated_store_on_postgres() {
    let Some(pg) = start_postgres() else {
        println!("docker is not available: the persistence corpus is not run on Postgres");
        return;
    };
    let dir = corpus().join("canonical");
    let read = |rel: &str| std::fs::read_to_string(dir.join(rel)).unwrap();
    let p = Scratch::project(
        "persistence-pg",
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
    );
    generate_all(&p, &[]);
    let arms = entity_arms(&p.path().join("generated/fitness_store"));
    let main = PROBE_MAIN.replace("        ENTITIES\n", &arms);
    let ws = generated_workspace("persistence-pg-ws", &p, Some((PROBE_DEPENDENCIES, &main)));
    let all = scenarios();
    let map: Map<String, Value> = all.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    ws.write(
        "probe/scenarios.json",
        &serde_json::to_string(&map).unwrap(),
    );
    assert_builds(&ws, "the persistence probe");
    assert_pinned(&ws);
    let scenarios_path = ws.path().join("probe/scenarios.json");
    let schema_path = dir.join("schema.postgres.sql");
    let run = cargo(
        ws.path(),
        &[
            "run",
            "-q",
            "-p",
            "probe",
            "--",
            &pg.url,
            scenarios_path.to_str().unwrap(),
            schema_path.to_str().unwrap(),
        ],
    );
    let stdout = String::from_utf8_lossy(&run.stdout);
    assert!(
        run.status.success(),
        "the probe failed:\n{stdout}{}",
        String::from_utf8_lossy(&run.stderr)
    );

    let mut got: BTreeMap<(String, String), Value> = BTreeMap::new();
    for line in stdout.lines() {
        let v: Value = serde_json::from_str(line).unwrap();
        let key = (
            v["scenario"].as_str().unwrap().to_string(),
            v["query"].as_str().unwrap().to_string(),
        );
        got.insert(key, v);
    }
    let mut failing: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (name, scenario) in &all {
        for q in scenario["queries"].as_array().unwrap() {
            let qname = q["name"].as_str().unwrap().to_string();
            let result = &got[&(name.clone(), qname.clone())];
            let wants_error = q.get("expect-error").and_then(Value::as_bool) == Some(true);
            let problem = match (wants_error, result.get("ok"), result.get("err")) {
                (true, _, Some(_)) => None,
                (true, Some(v), _) => Some(format!("expected an error, got {v}")),
                (false, Some(v), _) if v == &q["expect"] => None,
                (false, Some(v), _) => Some(format!(
                    "\n    expected: {}\n    actual:   {v}",
                    q["expect"]
                )),
                (false, _, err) => Some(format!("error: {}", err.unwrap())),
                _ => unreachable!(),
            };
            if let Some(problem) = problem {
                failing
                    .entry(name.clone())
                    .or_default()
                    .push(format!("  {qname}: {problem}"));
            }
        }
    }
    let ledgered: BTreeMap<&str, &str> = LEDGER.iter().copied().collect();
    let mut report = Vec::new();
    for (name, problems) in &failing {
        if !ledgered.contains_key(name.as_str()) {
            report.push(format!("{name}:\n{}", problems.join("\n")));
        }
    }
    for name in ledgered.keys() {
        assert!(
            all.contains_key(*name),
            "the ledger names {name}, which is not a Postgres scenario"
        );
        if !failing.contains_key(*name) {
            report.push(format!("{name} passes: take it off the ledger"));
        }
    }
    println!(
        "{} scenarios on Postgres, {} on the ledger",
        all.len(),
        ledgered.len()
    );
    assert!(report.is_empty(), "{}", report.join("\n"));
    drop(pg);
}
