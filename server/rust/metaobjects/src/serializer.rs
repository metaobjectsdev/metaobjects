//! The canonical serializer: the fused-key JSON form every port writes, byte for
//! byte (`spec/conformance-tests.md`).
//!
//! Two modes. **Own** writes the layer each node declares (its `extends` stays a
//! reference), so re-loading the output rebuilds the same tree. **Effective**
//! inlines what each node inherits through `extends`.

use std::borrow::Cow;
use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::json::{safe_whole_i64, to_js_pretty};
use crate::node::{NodeId, Tree};
use crate::parser::{
    ATTR_PREFIX, KEY_ABSTRACT, KEY_CHILDREN, KEY_EXTENDS, KEY_IS_ARRAY, KEY_NAME, KEY_PACKAGE,
    SUBTYPE_ROOT, TYPE_METADATA,
};

const TYPE_SOURCE: &str = "source";
const SOURCE_SUBTYPE_RDB: &str = "rdb";
const SOURCE_ATTR_KIND: &str = "kind";
const SOURCE_ATTR_TABLE: &str = "table";
const DEFAULT_SOURCE_KIND: &str = "table";

/// `@kind` → the attribute that holds the physical name for that kind (FR-016).
fn physical_name_attr_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "table" => Some("table"),
        "view" => Some("view"),
        "materializedView" => Some("materializedView"),
        "storedProc" => Some("proc"),
        "tableFunction" => Some("function"),
        _ => None,
    }
}

/// Canonical (own-mode) serialization of the subtree at `id`.
pub fn canonical_serialize(tree: &Tree, id: NodeId) -> String {
    serialize(tree, id, false)
}

/// Canonical serialization of the effective tree: inherited members inlined.
pub fn canonical_serialize_effective(tree: &Tree, id: NodeId) -> String {
    serialize(tree, id, true)
}

/// The canonical form of the subtree at `id`, as a JSON value.
pub fn to_canonical_value(tree: &Tree, id: NodeId, effective: bool) -> Value {
    wrap(tree, id, effective, None)
}

fn serialize(tree: &Tree, id: NodeId, effective: bool) -> String {
    let mut out = to_js_pretty(&to_canonical_value(tree, id, effective));
    out.push('\n');
    out
}

fn wrap(tree: &Tree, id: NodeId, effective: bool, pkg_slot: Option<String>) -> Value {
    let n = tree.node(id);
    let mut m = Map::new();
    m.insert(
        format!("{}.{}", n.type_name, n.sub_type),
        Value::Object(body(tree, id, effective, pkg_slot)),
    );
    Value::Object(m)
}

/// Effective package of a top-level node: own, else its file's, else the root's.
fn top_level_package(tree: &Tree, id: NodeId, root: NodeId) -> String {
    let n = tree.node(id);
    if let Some(p) = &n.package {
        return p.clone();
    }
    if let Some(p) = &n.file_default_package {
        return p.clone();
    }
    tree.node(root).package.clone().unwrap_or_default()
}

/// ADR-0059 R8, the document package rule. Returns the root's package and whether
/// each top-level node carries its own.
fn document_packages(tree: &Tree, root: NodeId) -> (Option<String>, bool) {
    let named: Vec<NodeId> = tree
        // ADR-0039: own — the root's top-level nodes are its declared children; a root extends nothing.
        .own_children(root)
        .iter()
        .copied()
        .filter(|&c| !tree.node(c).name.is_empty())
        .collect();
    let root_pkg = tree.node(root).package.clone();
    if named.is_empty() {
        return (root_pkg, false);
    }
    let mut pkgs: Vec<String> = named
        .iter()
        .map(|&c| top_level_package(tree, c, root))
        .collect();
    pkgs.sort();
    pkgs.dedup();
    if pkgs.len() == 1 && !pkgs[0].is_empty() {
        let only = pkgs.remove(0);
        let self_named = root_pkg.is_none()
            && named
                .iter()
                .all(|&c| tree.node(c).package.as_deref() == Some(only.as_str()));
        return (if self_named { None } else { Some(only) }, false);
    }
    (None, true)
}

fn body(tree: &Tree, id: NodeId, effective: bool, pkg_slot: Option<String>) -> Map<String, Value> {
    let n = tree.node(id);
    let mut b = Map::new();
    if !n.name.is_empty() {
        b.insert(KEY_NAME.into(), Value::String(n.name.clone()));
    }
    let is_doc_root = n.type_name == TYPE_METADATA && n.sub_type == SUBTYPE_ROOT;
    let doc = is_doc_root.then(|| document_packages(tree, id));
    let pkg = match (&doc, pkg_slot) {
        (Some((p, _)), _) => p.clone(),
        (None, Some(slot)) => Some(slot),
        (None, None) => n.package.clone(),
    };
    if let Some(p) = pkg.filter(|p| !p.is_empty()) {
        b.insert(KEY_PACKAGE.into(), Value::String(p));
    }
    if let Some(s) = n.super_ref.as_deref().filter(|s| !s.is_empty()) {
        b.insert(KEY_EXTENDS.into(), Value::String(s.to_string()));
    }
    if n.is_abstract {
        b.insert(KEY_ABSTRACT.into(), Value::Bool(true));
    }
    let is_array = if effective {
        tree.resolved_is_array(id) || tree.attr(id, KEY_IS_ARRAY) == Some(&Value::Bool(true))
    } else {
        n.is_array
    };
    if is_array {
        b.insert(KEY_IS_ARRAY.into(), Value::Bool(true));
    }

    // ADR-0039: own mode writes the declared layer, effective mode resolves.
    let mut attrs: BTreeMap<String, Value> = if effective {
        tree.attrs(id)
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    } else {
        // ADR-0039: own — own-mode serialization writes the declared layer.
        tree.own_attrs(id)
            .map(|(k, a)| (k.clone(), a.value.clone()))
            .collect()
    };
    if n.type_name == TYPE_SOURCE && n.sub_type == SOURCE_SUBTYPE_RDB {
        rewrite_physical_name(&mut attrs);
    }
    for (k, v) in attrs {
        b.insert(format!("{ATTR_PREFIX}{k}"), normalize(v));
    }

    let children = if effective {
        tree.children(id)
    } else {
        // ADR-0039: own — own-mode serialization writes the declared layer.
        Cow::Borrowed(tree.own_children(id))
    };
    if !children.is_empty() {
        let per_node = doc.as_ref().is_some_and(|(_, per)| *per);
        let items = children
            .iter()
            .copied()
            .map(|c| {
                let slot = per_node.then(|| {
                    if tree.node(c).name.is_empty() {
                        String::new()
                    } else {
                        top_level_package(tree, c, id)
                    }
                });
                wrap(tree, c, effective, slot)
            })
            .collect();
        b.insert(KEY_CHILDREN.into(), Value::Array(items));
    }
    b
}

/// FR-016 / ADR-0018: on a non-table `source.rdb`, a legacy `@table` is written as
/// the attribute its kind names (`@view`, `@proc`, ...).
fn rewrite_physical_name(attrs: &mut BTreeMap<String, Value>) {
    let kind = attrs
        .get(SOURCE_ATTR_KIND)
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .unwrap_or(DEFAULT_SOURCE_KIND)
        .to_string();
    let Some(alias) = physical_name_attr_for_kind(&kind) else {
        return;
    };
    if alias == SOURCE_ATTR_TABLE || attrs.contains_key(alias) {
        return;
    }
    if let Some(v) = attrs.remove(SOURCE_ATTR_TABLE) {
        if v.is_null() {
            attrs.insert(SOURCE_ATTR_TABLE.into(), v);
        } else {
            attrs.insert(alias.into(), v);
        }
    }
}

/// Whole-number doubles print as integers; a map of scalars sorts its keys (the
/// `properties` shape); any other map keeps its order (a filter's clauses do).
fn normalize(v: Value) -> Value {
    match v {
        Value::Number(n) => {
            if n.is_f64()
                && let Some(i) = n.as_f64().and_then(safe_whole_i64)
            {
                return Value::from(i);
            }
            Value::Number(n)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(map) => {
            let all_scalar = map.values().all(|v| !v.is_array() && !v.is_object());
            if all_scalar {
                let sorted: BTreeMap<String, Value> = map.into_iter().collect();
                Value::Object(sorted.into_iter().map(|(k, v)| (k, normalize(v))).collect())
            } else {
                Value::Object(map.into_iter().map(|(k, v)| (k, normalize(v))).collect())
            }
        }
        other => other,
    }
}
