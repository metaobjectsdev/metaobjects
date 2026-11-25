//! The generated crates build, are rustfmt-clean, and speak the wire form the model says.
//!
//! The small two-package model and the public fitness model are generated through the real
//! run engine, by every shipped generator, each into a scratch Cargo workspace that
//! `cargo check` builds with the real compiler and `rustfmt --check` reads file by file. A
//! probe crate (hand-written here) then uses the generated types: it serializes an order to
//! JSON, parses it back, walks a recursive structure and a cross-crate reference, validates a
//! create body and reads a patch, then drives the generated client and the generated commands
//! against a local server that records each request. So a wrong `serde` attribute, a missing
//! `Box`, a check that does not fire, a wrong path or a filter the server would not read fails
//! here and not in an adopter's build.

mod common;

use common::{
    Scratch, assert_builds, assert_formatted, assert_pinned, generate_all, generated_workspace,
    run_probe, shop_files,
};

const PROBE_DEPENDENCIES: &str = "shop = { path = \"../out/shop\" }\n\
    shop_billing = { path = \"../out/shop_billing\" }\n\
    shop_client = { path = \"../out/shop_client\" }\n\
    shop_cli = { path = \"../out/shop_cli\" }\n\
    meta_support = { path = \"../out/meta_support\" }\n\
    meta_client = { path = \"../out/meta_client\" }\n\
    meta_cli = { path = \"../out/meta_cli\" }\n\
    clap = { version = \"4\", features = [\"derive\"] }\n\
    tokio = { version = \"1\", features = [\"rt\"] }\n\
    serde_json = \"1\"\n";

const PROBE_MAIN: &str = r##"
use std::io::{Read, Write};

use clap::Parser;
use meta_client::Direction;
use shop::{Address, Category, Currency, Order, OrderCreate, OrderPatch, OrderStatus};
use shop_billing::Invoice;
use shop_client::{OrderClient, OrderQuery, OrderSort};

/// The application's own parser: the generated commands, mounted under a name it chose.
#[derive(Debug, Parser)]
#[command(name = "app")]
struct App {
    #[command(subcommand)]
    command: shop_cli::Command,
}

/// A server that gives each request the next canned answer, then reports what it was asked:
/// one `METHOD target` line per request (the target percent-decoded), and the body after it.
fn serve(answers: Vec<(u16, String)>) -> (String, std::thread::JoinHandle<Vec<String>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/api/", listener.local_addr().unwrap());
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for (status, answer) in answers {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            let (head_end, length) = loop {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "the request ended before its headers did");
                request.extend_from_slice(&chunk[..n]);
                if let Some(at) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&request[..at]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .map_or(0, |v| v.trim().parse::<usize>().unwrap());
                    break (at + 4, length);
                }
            };
            while request.len() < head_end + length {
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0, "the request ended before its body did");
                request.extend_from_slice(&chunk[..n]);
            }
            let head = String::from_utf8_lossy(&request[..head_end]).into_owned();
            let mut line = head.lines().next().unwrap().split(' ');
            let (method, target) = (line.next().unwrap(), line.next().unwrap());
            let body = String::from_utf8_lossy(&request[head_end..]).into_owned();
            seen.push(format!("{method} {}\n{body}", decoded(target)));
            let reply = format!(
                "HTTP/1.1 {status} Answer\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                answer.len()
            );
            stream.write_all(reply.as_bytes()).unwrap();
        }
        seen
    });
    (base, handle)
}

fn decoded(target: &str) -> String {
    let bytes = target.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                at += 2;
            }
            other => out.push(other),
        }
        at += 1;
    }
    String::from_utf8(out).unwrap()
}

async fn command(client: &meta_client::Client, args: &[&str]) -> meta_cli::Answer {
    let app = App::try_parse_from(std::iter::once("app").chain(args.iter().copied()))
        .unwrap_or_else(|e| panic!("{args:?} does not parse: {e}"));
    shop_cli::run(app.command, client).await
}

/// The generated client and the generated commands, against a server that records them.
async fn over_http(order: &Order, order_json: &str) {
    let row = order_json.to_string();
    let (base, server) = serve(vec![
        (200, format!("[{row}]")),
        (200, format!("{{\"rows\":[{row}],\"total\":41}}")),
        (404, r#"{"error":"not_found","message":"no order 9"}"#.to_string()),
        (201, row.clone()),
        (200, row.clone()),
        (204, String::new()),
        (200, "[]".to_string()),
        (200, r#"{"rows":[],"total":0}"#.to_string()),
        (201, row.clone()),
        (200, row.clone()),
        (200, "[]".to_string()),
        (200, "this is not json".to_string()),
    ]);
    // The trailing slash of a base address is not part of it, and no proxy sits in between.
    let http = meta_client::reqwest::Client::builder().no_proxy().build().unwrap();
    let client = meta_client::Client::with_http(http, &base);
    assert!(!client.base_url().ends_with('/'));
    let orders = OrderClient::new(&client);

    let query = OrderQuery::new()
        .status_eq(OrderStatus::New)
        .total_gte(5)
        .tax_rate_lt(&"0.5".parse().unwrap())
        .type_in(&["a b", "c&d"])
        .sort(OrderSort::Status, Direction::Ascending)
        .sort(OrderSort::Total, Direction::Descending)
        .limit(2);
    assert_eq!(orders.list(&query).await.unwrap(), vec![order.clone()]);
    let page = orders.page(&OrderQuery::new().offset(40)).await.unwrap();
    assert_eq!((page.rows.len(), page.total), (1, 41));

    let missing = orders.get(9).await.unwrap_err();
    assert_eq!((missing.status(), missing.code()), (Some(404), Some("not_found")));
    assert_eq!(missing.to_string(), "the server answered 404 not_found: no order 9");

    let create = OrderCreate {
        created_at: "2026-01-02T03:04:05Z".to_string(),
        status: OrderStatus::New,
        currency: Currency::Usd,
        total: 1999,
        tax_rate: None,
        r#type: None,
        tags: None,
        attributes: None,
        ship_to: Address { street: "1 Main".to_string(), zip_code: None },
        bill_to: None,
        history: None,
    };
    assert_eq!(orders.create(&create).await.unwrap(), *order);
    let patch: OrderPatch = serde_json::from_str(r#"{"total":5,"taxRate":null}"#).unwrap();
    assert_eq!(orders.update(7, &patch).await.unwrap(), *order);
    orders.delete(7).await.unwrap();
    assert!(orders.categories_of(7).await.unwrap().is_empty());

    // The same calls from a command line. A list checks its filters against the model.
    let listed = command(
        &client,
        &["order", "list", "--filter", "status=NEW", "--filter", "total:gte=5", "--sort", "total:desc", "--count"],
    )
    .await
    .unwrap();
    assert_eq!(listed, serde_json::json!({ "rows": [], "total": 0 }));
    let body = r#"{"createdAt":"2026-01-02T03:04:05Z","currency":"usd","total":1,"shipTo":{"street":"1 Main"}}"#;
    let created = command(
        &client,
        &["order", "create", "--json", body, "--status", "NEW", "--total", "1999", "--tags", "a", "--tags", "b"],
    )
    .await
    .unwrap();
    assert_eq!(created["id"], 7);
    command(&client, &["order", "update", "7", "--total", "5", "--json", r#"{"taxRate":null}"#])
        .await
        .unwrap();
    assert_eq!(command(&client, &["order", "categories", "7"]).await.unwrap(), serde_json::json!([]));

    // What the model refuses never reaches the server.
    let refused = command(&client, &["order", "list", "--filter", "currency=usd"]).await.unwrap_err();
    assert!(matches!(&refused, meta_cli::Error::Usage(m) if m.contains("currency is not a field")), "{refused}");
    let refused = command(&client, &["order", "list", "--filter", "status:gt=NEW"]).await.unwrap_err();
    assert!(matches!(&refused, meta_cli::Error::Usage(m) if m.contains("does not take gt")), "{refused}");
    // `type` is sortable: a `@filterable` field with no `@sortable` is. `tags` is neither.
    let refused = command(&client, &["order", "list", "--sort", "tags"]).await.unwrap_err();
    assert!(matches!(&refused, meta_cli::Error::Usage(_)), "{refused}");
    let empty_street = body.replace("1 Main", "");
    let refused = command(&client, &["order", "create", "--json", &empty_street, "--status", "NEW"])
        .await
        .unwrap_err();
    assert!(matches!(&refused, meta_cli::Error::Invalid(found) if found.len() == 1), "{refused}");
    let refused = command(&client, &["order", "create", "--json", "{}"]).await.unwrap_err();
    assert!(matches!(&refused, meta_cli::Error::Usage(m) if m.contains("does not fit the model")), "{refused}");
    let refused = command(&client, &["order", "update", "7", "--json", r#"{"nope":1}"#]).await.unwrap_err();
    assert!(matches!(&refused, meta_cli::Error::Usage(_)), "{refused}");

    // An answer that is not what the model says is an error, not a panic.
    let garbled = orders.get(7).await.unwrap_err();
    assert!(matches!(garbled, meta_client::Error::Decode { status: 200, .. }), "{garbled}");

    for request in server.join().unwrap() {
        println!("{}", request.replace('\n', " | "));
    }
}

fn main() {
    let order = Order {
        id: 7,
        created_at: "2026-01-02T03:04:05Z".to_string(),
        status: OrderStatus::InFlight,
        currency: Currency::GbpPound,
        total: 1999,
        tax_rate: Some("0.075".parse().unwrap()),
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
    // A decimal the wire wrote as a number is read exactly, never through a float.
    let numeric = json.replace("\"0.075\"", "0.075");
    assert_eq!(serde_json::from_str::<Order>(&numeric).unwrap(), order);

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

    let invoice = Invoice { id: 9, order: order.clone(), currency: Some(Currency::Eur) };
    println!("{}", serde_json::to_string(&invoice).unwrap());
    assert_eq!(OrderStatus::Done.as_str(), "done");
    assert!(serde_json::from_str::<OrderStatus>("\"IN-FLIGHT\"").is_err());

    // A create body reports every rule it breaks, a nested value object's under its member.
    let create = OrderCreate {
        created_at: "yesterday".to_string(),
        status: OrderStatus::New,
        currency: Currency::Usd,
        total: 1,
        tax_rate: None,
        r#type: None,
        tags: None,
        attributes: None,
        ship_to: Address { street: String::new(), zip_code: None },
        bill_to: None,
        history: Some(vec![Address { street: String::new(), zip_code: None }]),
    };
    let found: Vec<(String, &str)> =
        create.validate().into_iter().map(|v| (v.field, v.rule)).collect();
    assert_eq!(
        found,
        vec![
            ("createdAt".to_string(), "format"),
            ("shipTo.street".to_string(), "length"),
            ("history[0].street".to_string(), "length"),
        ]
    );

    // A patch tells a member set to null from a member left alone, in both directions.
    let patch: OrderPatch = serde_json::from_str(r#"{"total":5,"taxRate":null}"#).unwrap();
    assert_eq!(patch.total, Some(5));
    assert_eq!(patch.tax_rate, Some(None));
    assert_eq!(patch.r#type, None);
    assert!(patch.validate().is_empty());
    println!("{}", serde_json::to_string(&patch).unwrap());
    assert_eq!(serde_json::to_string(&OrderPatch::default()).unwrap(), "{}");

    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(over_http(&order, &json));
}
"##;

#[test]
fn generated_crates_compile_are_formatted_and_round_trip_through_serde() {
    let shop = Scratch::project("compile-shop", &shop_files());
    generate_all(&shop, &[]);
    let ws = generated_workspace(
        "compile-shop-ws",
        &shop,
        Some((PROBE_DEPENDENCIES, PROBE_MAIN)),
    );
    assert_formatted(&ws);
    assert_builds(&ws, "the shop model");
    let stdout = run_probe(&ws);
    assert_pinned(&ws);
    let mut lines = stdout.lines();
    assert_eq!(
        lines.next().unwrap(),
        r#"{"id":7,"createdAt":"2026-01-02T03:04:05Z","status":"IN_FLIGHT","currency":"gbp_pound","total":1999,"taxRate":"0.075","type":"rush","tags":["a","b"],"attributes":null,"shipTo":{"street":"1 Main","zipCode":"90210"},"billTo":null,"history":null}"#
    );
    assert!(
        lines
            .next()
            .unwrap()
            .starts_with(r#"{"id":9,"order":{"id":7,"#)
    );
    assert_eq!(lines.next().unwrap(), r#"{"total":5,"taxRate":null}"#);
    // A value object inside a body is written as the model's own type writes it: under the
    // default `wire.nullMembers`, its unset member is an explicit null.
    let create = r#"{"createdAt":"2026-01-02T03:04:05Z","status":"NEW","currency":"usd","total":1999,"shipTo":{"street":"1 Main","zipCode":null}}"#;
    let requests: Vec<String> = lines.map(str::to_string).collect();
    assert_eq!(
        requests,
        vec![
            "GET /api/orders?filter[status][eq]=NEW&filter[total][gte]=5&filter[taxRate][lt]=0.5&filter[type][in]=a b,c&d&sort=total:desc&limit=2 | ".to_string(),
            "GET /api/orders?offset=40&withCount=1 | ".to_string(),
            "GET /api/orders/9 | ".to_string(),
            format!("POST /api/orders | {create}"),
            r#"PATCH /api/orders/7 | {"total":5,"taxRate":null}"#.to_string(),
            "DELETE /api/orders/7 | ".to_string(),
            "GET /api/orders/7/categories | ".to_string(),
            "GET /api/orders?filter[status][eq]=NEW&filter[total][gte]=5&sort=total:desc&withCount=1 | ".to_string(),
            format!("POST /api/orders | {}", create.replace(r#""shipTo""#, r#""tags":["a","b"],"shipTo""#)),
            r#"PATCH /api/orders/7 | {"total":5,"taxRate":null}"#.to_string(),
            "GET /api/orders/7/categories | ".to_string(),
            "GET /api/orders/7 | ".to_string(),
        ]
    );
}

#[test]
fn the_fitness_model_compiles_and_is_formatted() {
    // The model every port's codegen-compile gate generates from (docs/CONFORMANCE.md).
    let fitness = Scratch::project("compile-fitness", &common::FITNESS_PROJECT);
    generate_all(&fitness, &[]);
    let ws = generated_workspace("compile-fitness-ws", &fitness, None);
    assert_formatted(&ws);
    assert_builds(&ws, "the fitness model");
    assert_pinned(&ws);
    assert_pinned(&ws);
}

#[test]
fn a_named_first_run_leaves_a_crate_the_real_compiler_accepts() {
    // The regression: a named run on a never-generated project used to write lib.rs
    // declaring every module of the crate while emitting only the named struct's file,
    // so the crate could not build. The oracle is `cargo check` itself: the crate the
    // run leaves behind must compile.
    let p = Scratch::project("compile-named", &shop_files());
    generate_all(&p, &["Order"]);
    // The whole crate came out: the shared enum beside the named struct, and nothing
    // of the crate that holds no named object.
    assert!(p.exists("generated/shop/src/currency.rs"));
    assert!(p.exists("generated/shop/src/order.rs"));
    assert!(!p.exists("generated/shop_billing"));

    let ws = generated_workspace("compile-named-ws", &p, None);
    assert_builds(&ws, "a named first run's crate");
}

#[test]
fn a_named_first_run_across_a_crate_dependency_leaves_a_buildable_workspace() {
    // `Invoice` lives in `shop_billing`, whose manifest declares a path dependency on the
    // `shop` crate (Invoice.order and Invoice.currency both reach into `shop`), so the run
    // must emit that dependency crate too or its own output cannot build. The oracle is
    // `cargo check` itself.
    let p = Scratch::project("compile-named-dep", &shop_files());
    generate_all(&p, &["Invoice"]);
    assert!(p.exists("generated/shop_billing/src/invoice.rs"));
    assert!(
        p.exists("generated/shop/src/order.rs"),
        "the dependency crate came out too"
    );

    let ws = generated_workspace("compile-named-dep-ws", &p, None);
    assert_builds(&ws, "a named first run across a crate dependency");
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
    generate_all(&p, &["A"]);
    for crate_file in [
        "generated/chain_a/src/a.rs",
        "generated/chain_b/src/b.rs",
        "generated/chain_c/src/c.rs",
    ] {
        assert!(p.exists(crate_file), "{crate_file} is missing");
    }

    let ws = generated_workspace("compile-chain-ws", &p, None);
    assert_builds(&ws, "a named first run's dependency chain");
}
