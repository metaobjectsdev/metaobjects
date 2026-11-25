//! The shared list-query parse cases (`fixtures/list-query-conformance/`) against the list
//! parser the generated transport ships (`meta_http`'s `list_query`, compiled here as
//! `emitted::list_query`). The allowlist is not in the fixture: it is derived from the
//! fixture's model by `service_routes::list_spec`, the derivation the generated entity spec is
//! written from, so a derivation that drifts fails here.

mod common;

use std::path::Path;

use common::Scratch;
use metaobjects_codegen::emitted::list_query::{
    FilterRule, Kind, ListQuery, ListSpec, Node, SortRule, parse,
};
use metaobjects_codegen::generator::GenContext;
use metaobjects_codegen::plan::Plan;
use metaobjects_codegen::project::load_project;
use metaobjects_codegen::service_routes::list_spec;
use serde_json::{Map, Value, json};

fn fixture(name: &str) -> String {
    let dir =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/list-query-conformance");
    std::fs::read_to_string(dir.join(name)).unwrap()
}

fn leak<T>(items: Vec<T>) -> &'static [T] {
    Box::leak(items.into_boxed_slice())
}

fn text(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn kind(name: &str) -> Kind {
    match name {
        "Text" => Kind::Text,
        "Integer" => Kind::Integer,
        "Number" => Kind::Number,
        "Boolean" => Kind::Boolean,
        "Date" => Kind::Date,
        "Time" => Kind::Time,
        "Instant" => Kind::Instant,
        "LocalTimestamp" => Kind::LocalTimestamp,
        "Uuid" => Kind::Uuid,
        "Decimal" => Kind::Decimal,
        "Duration" => Kind::Duration,
        other => panic!("no list kind {other}"),
    }
}

/// The `Ticket` list spec, as the generated `ticket::LIST` holds it.
fn ticket_spec() -> ListSpec {
    let meta = fixture("meta.json");
    let project = Scratch::project("list-query", &[("metaobjects/meta.json", meta.as_str())]);
    let loaded = load_project(project.path(), None, false).expect("the model loads clean");
    let ctx = GenContext {
        tree: &loaded.result.tree,
        root: loaded.result.root,
        entities: &[],
        collection: &loaded.collection,
        reference_nodes: &loaded.reference_nodes,
    };
    let plan = Plan::of(&ctx).expect("the model plans");
    let ticket = plan
        .structs
        .iter()
        .find(|s| s.name == "Ticket")
        .expect("Ticket");
    let p = list_spec(&loaded.result.tree, &ticket.fields);
    ListSpec {
        filters: leak(
            p.filters
                .iter()
                .map(|f| FilterRule {
                    field: text(&f.field),
                    ops: leak(f.ops.clone()),
                    kind: kind(f.kind),
                    values: f
                        .values
                        .as_ref()
                        .map(|v| leak(v.iter().map(|s| text(s)).collect())),
                })
                .collect(),
        ),
        sorts: leak(
            p.sorts
                .iter()
                .map(|(field, descending)| SortRule {
                    field: text(field),
                    descending: *descending,
                })
                .collect(),
        ),
        fields: leak(p.fields.iter().map(|f| text(f)).collect()),
    }
}

fn node(n: &Node) -> Value {
    match n {
        Node::Leaf { field, op, value } => json!({ "field": field, "op": op, "value": value }),
        Node::And(items) => json!({ "and": items.iter().map(node).collect::<Vec<_>>() }),
        Node::Or(items) => json!({ "or": items.iter().map(node).collect::<Vec<_>>() }),
    }
}

/// A parsed query in the fixture's neutral form, absent members left out.
fn neutral(q: &ListQuery) -> Value {
    let mut out = Map::new();
    if let Some(f) = &q.filter {
        out.insert("filter".into(), node(f));
    }
    if let Some(s) = &q.search {
        out.insert(
            "search".into(),
            json!({ "term": s.term, "fields": s.fields }),
        );
    }
    if let Some(s) = &q.sort {
        let order = if s.descending { "desc" } else { "asc" };
        out.insert("sort".into(), json!({ "field": s.field, "order": order }));
    }
    if let Some(l) = q.limit {
        out.insert("limit".into(), json!(l));
    }
    if let Some(o) = q.offset {
        out.insert("offset".into(), json!(o));
    }
    Value::Object(out)
}

#[test]
fn every_shared_list_query_case_parses_as_pinned() {
    let spec = ticket_spec();
    let cases: Value = serde_json::from_str(&fixture("cases.json")).unwrap();
    let cases = cases["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        95,
        "the corpus changed size: review the new cases"
    );
    let mut faults = Vec::new();
    for c in cases {
        let name = format!(
            "{}/{}",
            c["group"].as_str().unwrap(),
            c["name"].as_str().unwrap()
        );
        let got = match parse(c["query"].as_str().unwrap(), &spec) {
            Ok(q) => json!({ "list": neutral(&q) }),
            Err(r) => json!({ "error": r.body() }),
        };
        if got != c["expect"] {
            faults.push(format!("{name}: got {got}, expected {}", c["expect"]));
        }
    }
    assert!(
        faults.is_empty(),
        "{} of 95 cases:\n{}",
        faults.len(),
        faults.join("\n")
    );
}
