//! FR-044 Plan 2, Table B and Table C: a report's derived fields, byte-matched across ports.
//!
//! TypeScript writes `fixtures/persistence-conformance/report-shapes.json` from the canonical
//! model. Every port derives the same shapes from the same model and compares the bytes, so
//! the derivation cannot drift between ports. The format is the contract: reports in
//! declaration order; keys `report, from, view, fields`; per field `name, role, subType,
//! required, typeSource`; two-space indent; one trailing newline. `typeSource` is the
//! resolution key of the entity that DECLARES the `@of` field, a dot, and the field name.

use std::path::PathBuf;

use serde_json::{Map, Value, json};

use metaobjects::loader::Loader;
use metaobjects::naming::{
    NamingCtx, NamingRegistry, PhysicalNaming, source_is_read_only, source_physical_name,
    source_role,
};
use metaobjects::node::{NodeId, Tree};
use metaobjects::providers::default_registry;
use metaobjects::report_shape::report_shape;
use metaobjects::validate::util::ObjectIndex;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/persistence-conformance")
}

/// The source the lowering names and the runtime reads: the report's own read-only source
/// with `@role: primary`, else its first own read-only source.
fn read_source(tree: &Tree, report: NodeId) -> Option<NodeId> {
    // ADR-0039 sanctioned own: source classification reads the sources the report declares.
    let read_only: Vec<NodeId> = tree
        .own_children(report)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == "source" && source_is_read_only(tree, c))
        .collect();
    read_only
        .iter()
        .copied()
        .find(|&s| source_role(tree, s) == "primary")
        .or_else(|| read_only.first().copied())
}

fn type_source(tree: &Tree, field: Option<NodeId>) -> Value {
    match field {
        None => Value::Null,
        Some(f) => {
            let owner = tree.node(f).parent.expect("an @of field has an owner");
            json!(format!(
                "{}.{}",
                tree.resolution_key(owner),
                tree.node(f).name
            ))
        }
    }
}

fn shapes_json() -> String {
    let registry = default_registry().expect("the built-in providers compose");
    let r = Loader::new(&registry)
        .load_dir(&corpus().join("canonical"))
        .unwrap();
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    let (tree, root) = (&r.tree, r.root);
    let index = ObjectIndex::build(tree, root);
    let naming_registry = NamingRegistry::builtin();
    let naming = PhysicalNaming::default();
    let ctx = NamingCtx {
        registry: &naming_registry,
        naming: &naming,
    };
    let mut reports = Vec::new();
    for &obj in index.objects() {
        let n = tree.node(obj);
        if n.sub_type != "report" {
            continue;
        }
        let shape = report_shape(tree, &index, obj).unwrap();
        let view = read_source(tree, obj)
            .map(|s| json!(source_physical_name(tree, s, &ctx).unwrap()))
            .unwrap_or(Value::Null);
        let fields: Vec<Value> = shape
            .fields
            .iter()
            .map(|f| {
                let mut m = Map::new();
                m.insert("name".into(), json!(f.name));
                m.insert("role".into(), json!(f.role.as_str()));
                m.insert("subType".into(), json!(f.sub_type));
                m.insert("required".into(), json!(f.required));
                m.insert("typeSource".into(), type_source(tree, f.type_source));
                Value::Object(m)
            })
            .collect();
        let mut m = Map::new();
        m.insert("report".into(), json!(tree.resolution_key(obj)));
        m.insert("from".into(), json!(tree.resolution_key(shape.from)));
        m.insert("view".into(), view);
        m.insert("fields".into(), Value::Array(fields));
        reports.push(Value::Object(m));
    }
    serde_json::to_string_pretty(&json!({ "reports": reports })).unwrap() + "\n"
}

#[test]
fn derived_shapes_byte_match_the_committed_artifact() {
    let expected = std::fs::read_to_string(corpus().join("report-shapes.json")).unwrap();
    let actual = shapes_json();
    if actual != expected {
        let a: Vec<&str> = actual.lines().collect();
        let e: Vec<&str> = expected.lines().collect();
        let at = a
            .iter()
            .zip(&e)
            .position(|(x, y)| x != y)
            .unwrap_or(a.len().min(e.len()));
        panic!(
            "report shapes differ at line {}:\n  expected: {:?}\n  actual:   {:?}",
            at + 1,
            e.get(at),
            a.get(at)
        );
    }
}

fn load_one(children: Value) -> (Tree, NodeId) {
    let doc = json!({ "metadata.root": { "package": "acme::shop", "children": children } });
    let registry = default_registry().expect("the built-in providers compose");
    let r = Loader::new(&registry).load_sources(&[("meta.shop.json".into(), doc.to_string())]);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    (r.tree, r.root)
}

fn sale_with(measures: Value) -> Value {
    let mut kids = vec![
        json!({"source.rdb": {"@table": "sales"}}),
        json!({"field.long": {"name": "id"}}),
        json!({"field.int": {"name": "qty"}}),
        json!({"field.double": {"name": "weight"}}),
        json!({"field.currency": {"name": "price", "@currency": "USD"}}),
        json!({"identity.primary": {"name": "pk", "@fields": ["id"]}}),
    ];
    kids.extend(measures.as_array().unwrap().iter().cloned());
    json!({"object.entity": {"name": "Sale", "children": kids}})
}

/// Table B's subtype rules (the FR-044 Plan 2 contract), read off a model with one of
/// each: a sum of an int widens to long, of a double stays double, of currency stays
/// currency (carrying the source's attrs), an avg of an int is decimal, and a count is a
/// non-null long.
#[test]
fn measure_subtypes_follow_table_b() {
    let measures = json!([
        {"measure.aggregate": {"name": "units", "@agg": "sum", "@of": "Sale.qty"}},
        {"measure.aggregate": {"name": "mass", "@agg": "sum", "@of": "Sale.weight"}},
        {"measure.aggregate": {"name": "revenue", "@agg": "sum", "@of": "Sale.price"}},
        {"measure.aggregate": {"name": "avgQty", "@agg": "avg", "@of": "Sale.qty"}},
        {"measure.aggregate": {"name": "sales", "@agg": "count", "@of": "Sale.id"}},
    ]);
    let report = json!({"object.report": {"name": "SaleTotals", "@from": "Sale",
        "@measures": ["units", "mass", "revenue", "avgQty", "sales"]}});
    let (tree, root) = load_one(json!([sale_with(measures), report]));
    let index = ObjectIndex::build(&tree, root);
    let report = *index.objects().last().unwrap();
    let shape = report_shape(&tree, &index, report).unwrap();
    let got: Vec<(String, String, bool, bool)> = shape
        .fields
        .iter()
        .map(|f| {
            (
                f.name.clone(),
                f.sub_type.clone(),
                f.required,
                f.type_source.is_some(),
            )
        })
        .collect();
    let want = [
        ("units", "long", false, false),
        ("mass", "double", false, false),
        ("revenue", "currency", false, true),
        ("avgQty", "decimal", false, false),
        ("sales", "long", true, false),
    ];
    let want: Vec<(String, String, bool, bool)> = want
        .iter()
        .map(|(n, s, r, t)| (n.to_string(), s.to_string(), *r, *t))
        .collect();
    assert_eq!(got, want);
}
