//! The shared naming corpus (`fixtures/naming-conformance/`): the pluralizer pair, the
//! collection-name collision refusal, the REST collection segments and the physical
//! names every port resolves through its naming door.
//!
//! `naming-conformance-expected-failures.json` beside this file is the ledger of cases
//! this port does not pass. It may only shrink, and it is empty.

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::Value;

use metaobjects::errors::ERR_COLLECTION_NAME_COLLISION;
use metaobjects::loader::Loader;
use metaobjects::naming::{
    CollectionNameScopes, NamingCtx, NamingKind, NamingRegistry, OutputLayout, PhysicalNaming,
    assert_no_collection_name_collisions, collection_segment_of, pluralize,
    pluralize_table_name_legacy, resolve_column_name, resolve_flattened_column_name,
    resolve_table_name, top_level_objects,
};
use metaobjects::node::{NodeId, Tree};
use metaobjects::providers::default_registry;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/naming-conformance")
}

fn read_json(path: PathBuf) -> Value {
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn ledger() -> BTreeSet<String> {
    let v = read_json(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/naming-conformance-expected-failures.json"),
    );
    v["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .map(|c| c.as_str().expect("string").to_string())
        .collect()
}

/// Run every named check; the ledger lists the ones allowed to fail, and a listed check
/// that passes fails the run (the ledger may only shrink).
fn run_checks(checks: Vec<(String, Result<(), String>)>) {
    let expected = ledger();
    let mut problems = Vec::new();
    let mut seen = BTreeSet::new();
    for (name, result) in &checks {
        seen.insert(name.clone());
        match (result, expected.contains(name)) {
            (Err(e), false) => problems.push(format!("FAIL {name}: {e}")),
            (Ok(()), true) => {
                problems.push(format!("{name} passes now: remove it from the ledger"))
            }
            _ => {}
        }
    }
    for name in &expected {
        if !seen.contains(name) {
            problems.push(format!("ledger names unknown check {name}"));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    assert!(!checks.is_empty());
}

fn eq(what: &str, got: &str, want: &str) -> Result<(), String> {
    if got == want {
        Ok(())
    } else {
        Err(format!("{what}: got {got:?}, want {want:?}"))
    }
}

fn load(sources: &[(String, String)]) -> (Tree, NodeId) {
    let registry = default_registry().expect("the built-in providers compose");
    let r = Loader::new(&registry).load_sources(sources);
    assert!(r.errors.is_empty(), "{:?}", r.errors);
    (r.tree, r.root)
}

/// Load a model the validator is expected to refuse, keeping the tree so a resolver can be
/// exercised on it directly (the resolver's own conflict check is defence in depth).
fn load_refused(sources: &[(String, String)], code: &str) -> (Tree, NodeId) {
    let registry = default_registry().expect("the built-in providers compose");
    let r = Loader::new(&registry).load_sources(sources);
    assert!(
        r.errors.iter().all(|e| e.code == code) && !r.errors.is_empty(),
        "{:?}",
        r.errors
    );
    (r.tree, r.root)
}

fn s(v: &Value) -> &str {
    v.as_str().expect("string")
}

// ---- pluralizers ----------------------------------------------------------------

#[test]
fn already_plural_pluralizer_pair() {
    let d = read_json(corpus().join("already-plural-pluralize.json"));
    let mut checks = Vec::new();
    for c in d["cases"].as_array().unwrap() {
        let name = s(&c["name"]);
        checks.push((
            format!("api:{name}"),
            eq("apiPlural", &pluralize(name), s(&c["apiPlural"])),
        ));
        checks.push((
            format!("legacy:{name}"),
            eq(
                "legacyPlural",
                &pluralize_table_name_legacy(name),
                s(&c["legacyPlural"]),
            ),
        ));
    }
    run_checks(checks);
}

// ---- collection segments -----------------------------------------------------------

#[test]
fn collection_segments() {
    let d = read_json(corpus().join("collection-segments.json"));
    let registry = NamingRegistry::builtin();
    let mut checks = Vec::new();
    for (i, c) in d["cases"].as_array().unwrap().iter().enumerate() {
        let name = s(&c["name"]);
        let got = collection_segment_of(
            &registry,
            name,
            c.get("collectionName").map(s),
            c.get("pluralizer").map(s),
        )
        .map_err(|e| e.message);
        let result = got.and_then(|g| eq("segment", &g, s(&c["segment"])));
        checks.push((format!("segment:{i}:{name}"), result));
    }
    run_checks(checks);
}

// ---- collisions ---------------------------------------------------------------------

/// One package's file: an entity with an `id` identity, and a source unless told not to.
fn entity_json(name: &str, is_abstract: bool, source: bool) -> String {
    let source = if source { r#"{"source.rdb": {}},"# } else { "" };
    let abs = if is_abstract {
        r#""abstract": true,"#
    } else {
        ""
    };
    format!(
        r#"{{"object.entity": {{"name": "{name}", {abs} "children": [{source}
            {{"field.long": {{"name": "id"}}}},
            {{"identity.primary": {{"name": "id", "@fields": "id"}}}}]}}}}"#
    )
}

fn file(package: &str, objects: &[String]) -> (String, String) {
    (
        format!("meta.{}.json", package.replace("::", ".")),
        format!(
            r#"{{"metadata.root": {{"package": "{package}", "children": [{}]}}}}"#,
            objects.join(",")
        ),
    )
}

fn refuse(tree: &Tree, root: NodeId, layout: OutputLayout) -> Result<(), metaobjects::MetaError> {
    let registry = NamingRegistry::builtin();
    let naming = PhysicalNaming::default();
    let ctx = NamingCtx::new(&registry, &naming);
    let scopes = CollectionNameScopes {
        layout,
        ..CollectionNameScopes::default()
    };
    let objects = top_level_objects(tree, root);
    let mut reversed = objects.clone();
    reversed.reverse();
    // Both orders reach the same verdict.
    let a = assert_no_collection_name_collisions(tree, &objects, &scopes, &ctx);
    let b = assert_no_collection_name_collisions(tree, &reversed, &scopes, &ctx);
    assert_eq!(a.is_ok(), b.is_ok());
    a
}

#[test]
fn collision_cases_are_refused() {
    let d = read_json(corpus().join("already-plural-pluralize.json"));
    let mut checks = Vec::new();
    for c in d["collisionCases"].as_array().unwrap() {
        let (a, b, on) = (s(&c["entityA"]), s(&c["entityB"]), s(&c["collidesOn"]));
        let (tree, root) = load(&[file(
            "acme",
            &[entity_json(a, false, true), entity_json(b, false, true)],
        )]);
        let result = match refuse(&tree, root, OutputLayout::Flat) {
            Ok(()) => Err("accepted".to_string()),
            Err(e) if e.code != ERR_COLLECTION_NAME_COLLISION => Err(format!("code {}", e.code)),
            Err(e) if !e.message.contains(on) && !e.message.to_lowercase().contains(on) => {
                Err(format!("message does not name {on}: {}", e.message))
            }
            Err(_) => Ok(()),
        };
        checks.push((format!("collision:{a}/{b}"), result));
    }
    run_checks(checks);
}

#[test]
fn shape_only_cases_are_accepted() {
    let d = read_json(corpus().join("already-plural-pluralize.json"));
    let mut checks = Vec::new();
    for (i, c) in d["shapeOnlyCases"].as_array().unwrap().iter().enumerate() {
        let shape = &c["shapeOnly"];
        let emitting = &c["emitting"];
        let shape_file = file(
            s(&shape["package"]),
            &[entity_json(
                s(&shape["name"]),
                shape["abstract"].as_bool().unwrap(),
                shape["source"].as_bool().unwrap(),
            )],
        );
        let emit_file = file(
            s(&emitting["package"]),
            &[entity_json(s(&emitting["name"]), false, true)],
        );
        let mut result = Ok(());
        for sources in [
            [shape_file.clone(), emit_file.clone()],
            [emit_file, shape_file],
        ] {
            let (tree, root) = load(&sources);
            for layout in [OutputLayout::Flat, OutputLayout::Package] {
                if let Err(e) = refuse(&tree, root, layout) {
                    result = Err(e.message);
                }
            }
        }
        checks.push((format!("shape-only:{i}:{}", s(&shape["name"])), result));
    }
    run_checks(checks);
}

#[test]
fn cross_package_collision_is_scoped() {
    let d = read_json(corpus().join("already-plural-pluralize.json"));
    let mut checks = Vec::new();
    for c in d["crossPackageCollisionCases"].as_array().unwrap() {
        let (a, b) = (&c["entityA"], &c["entityB"]);
        let (tree, root) = load(&[
            file(s(&a["package"]), &[entity_json(s(&a["name"]), false, true)]),
            file(s(&b["package"]), &[entity_json(s(&b["name"]), false, true)]),
        ]);
        let on = s(&c["collidesOn"]);
        // One scope (flat modules): refused, naming the colliding name.
        let flat = match refuse(&tree, root, OutputLayout::Flat) {
            Err(e) if e.code == ERR_COLLECTION_NAME_COLLISION && e.message.contains(on) => Ok(()),
            other => Err(format!("flat layout: {other:?}")),
        };
        // Two module scopes, routes unchecked: accepted.
        let registry = NamingRegistry::builtin();
        let naming = PhysicalNaming::default();
        let ctx = NamingCtx::new(&registry, &naming);
        let scopes = CollectionNameScopes {
            layout: OutputLayout::Package,
            modules: true,
            routes: false,
        };
        let pkg = assert_no_collection_name_collisions(
            &tree,
            &top_level_objects(&tree, root),
            &scopes,
            &ctx,
        )
        .map_err(|e| e.message);
        checks.push(("cross-package:flat".to_string(), flat));
        checks.push(("cross-package:package-modules".to_string(), pkg));
    }
    run_checks(checks);
}

// ---- physical names -------------------------------------------------------------------

/// What the config reader does with a `naming` block: refuse an unknown key, a block that
/// is not an object, and a name no registered strategy answers.
fn validate_block(registry: &NamingRegistry, block: &Value) -> Result<PhysicalNaming, String> {
    let Some(obj) = block.as_object() else {
        return Err("\"naming\" must be an object".to_string());
    };
    let mut naming = PhysicalNaming::default();
    for (key, value) in obj {
        let kind = match key.as_str() {
            "columns" => NamingKind::Columns,
            "tables" => NamingKind::Tables,
            "collections" => NamingKind::Collections,
            other => return Err(format!("unknown key \"naming.{other}\"")),
        };
        let name = value.as_str().ok_or("naming values are strings")?;
        if !registry.has(kind, name) {
            return Err(registry.unknown_strategy_message(kind, name));
        }
        match kind {
            NamingKind::Columns => naming.columns = name.to_string(),
            NamingKind::Tables => naming.tables = name.to_string(),
            NamingKind::Collections => naming.collections = Some(name.to_string()),
        }
    }
    Ok(naming)
}

/// The corpus's application strategies, registered through the registry's extension point.
fn registry_with(strategies: &[Value]) -> NamingRegistry {
    let mut registry = NamingRegistry::builtin();
    for st in strategies {
        let name = s(&st["name"]).to_string();
        let upper: Vec<String> = st["upperCase"]
            .as_array()
            .map(|a| a.iter().map(|v| s(v).to_string()).collect())
            .unwrap_or_default();
        let prefix = st.get("prefix").map(s).unwrap_or("").to_string();
        let delegate = s(&st["delegate"]).to_string();
        let base = NamingRegistry::builtin();
        let apply = move |n: &str| -> String {
            if upper.iter().any(|u| u == n) {
                return n.to_ascii_uppercase();
            }
            let inner = match delegate.as_str() {
                "pascal" | "kebab-case" | "literal" => {
                    base.apply_column_naming_strategy(n, &delegate)
                }
                _ => base.apply_table_naming_rule(n, &delegate),
            }
            .expect("a built-in delegate");
            format!("{prefix}{inner}")
        };
        match s(&st["for"]) {
            "columns" => registry.register_column_strategy(&name, apply),
            "tables" => registry.register_table_rule(&name, apply),
            other => panic!("strategy for {other}"),
        }
        .expect("register");
    }
    registry
}

fn find_object(tree: &Tree, root: NodeId, name: &str) -> NodeId {
    top_level_objects(tree, root)
        .into_iter()
        .find(|&o| tree.node(o).name == name)
        .unwrap_or_else(|| panic!("no object {name}"))
}

fn field_named(tree: &Tree, owner: NodeId, name: &str) -> NodeId {
    tree.children(owner)
        .iter()
        .copied()
        .find(|&c| tree.node(c).type_name == "field" && tree.node(c).name == name)
        .unwrap_or_else(|| panic!("no field {name}"))
}

#[test]
fn physical_names() {
    let d = read_json(corpus().join("physical-names/cases.json"));
    let text = std::fs::read_to_string(corpus().join("physical-names/meta.naming.json")).unwrap();
    let (tree, root) = load(&[("meta.naming.json".to_string(), text)]);
    let registry = registry_with(d["strategies"].as_array().unwrap());
    let mut checks = Vec::new();

    for c in d["cases"].as_array().unwrap() {
        let case = s(&c["name"]);
        let naming = match &c["naming"] {
            Value::Null => Ok(PhysicalNaming::default()),
            block => validate_block(&registry, block),
        };
        let naming = match naming {
            Ok(n) => n,
            Err(e) => {
                checks.push((format!("{case}:config"), Err(e)));
                continue;
            }
        };
        let ctx = NamingCtx::new(&registry, &naming);
        for (obj, want) in c["tables"].as_object().unwrap() {
            let got = resolve_table_name(&tree, find_object(&tree, root, obj), &ctx)
                .map_err(|e| e.message)
                .and_then(|g| eq("table", &g, s(want)));
            checks.push((format!("{case}:table:{obj}"), got));
        }
        for (key, want) in c["columns"].as_object().unwrap() {
            let parts: Vec<&str> = key.split('.').collect();
            let owner = find_object(&tree, root, parts[0]);
            let field = field_named(&tree, owner, parts[1]);
            let got = if parts.len() == 3 {
                let target = tree
                    .attr(field, "objectRef")
                    .and_then(Value::as_str)
                    .expect("objectRef");
                let value_obj =
                    find_object(&tree, root, metaobjects::naming::strip_package(target));
                let member = field_named(&tree, value_obj, parts[2]);
                resolve_flattened_column_name(&tree, field, member, &ctx)
            } else {
                resolve_column_name(&tree, field, &ctx)
            }
            .map_err(|e| e.message)
            .and_then(|g| eq("column", &g, s(want)));
            checks.push((format!("{case}:column:{key}"), got));
        }
    }

    for c in d["invalid"].as_array().unwrap() {
        let case = s(&c["name"]);
        let result = match validate_block(&registry, &c["naming"]) {
            Ok(_) => Err("accepted".to_string()),
            Err(message) => {
                let missing: Vec<&str> = c
                    .get("messageIncludes")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(s).filter(|m| !message.contains(m)).collect())
                    .unwrap_or_default();
                if missing.is_empty() {
                    Ok(())
                } else {
                    Err(format!("message {message:?} lacks {missing:?}"))
                }
            }
        };
        checks.push((format!("invalid:{case}"), result));
    }
    run_checks(checks);
}

// ---- resolvers beyond the corpus --------------------------------------------------------

#[test]
fn a_conflicting_primary_source_pair_is_refused() {
    let (tree, root) = load_refused(
        &[(
            "meta.a.json".to_string(),
            r#"{"metadata.root": {"package": "acme", "children": [
          {"object.entity": {"name": "A", "children": [
            {"source.rdb": {"@table": "a_one", "@schema": "s1"}},
            {"source.rdb": {"name": "second", "@table": "a_two"}}]}}]}}"#
                .to_string(),
        )],
        "ERR_SOURCE_MULTIPLE_PRIMARY",
    );
    let registry = NamingRegistry::builtin();
    let naming = PhysicalNaming::default();
    let ctx = NamingCtx::new(&registry, &naming);
    let a = find_object(&tree, root, "A");
    let err = resolve_table_name(&tree, a, &ctx).unwrap_err();
    assert!(
        err.message.contains("role=primary sources disagree"),
        "{}",
        err.message
    );
    assert!(
        err.message
            .contains("\"a_two\" (table) vs \"s1\".\"a_one\" (table)")
    );
}
