//! Helpers the validation passes share. Keep this small: a pass reads the tree
//! through [`crate::node::Tree`] directly, and ADR-0039's rule holds here too —
//! the resolving accessors are the default, `own_*` only where a comment names the
//! sanctioned case.

use std::collections::HashMap;

use crate::errors::MetaError;
use crate::loader::{owner_candidate_keys, split_child_tail};
use crate::node::{NodeId, PACKAGE_SEP, Tree};
use crate::parser::TYPE_OBJECT;

const A_REFERENCES: &str = "references";
const A_OBJECT_REF: &str = "objectRef";

/// An error located where `id` was declared: its source is the node's own.
pub fn error_at(
    tree: &Tree,
    id: NodeId,
    code: &'static str,
    message: impl Into<String>,
) -> MetaError {
    MetaError::at(code, message, tree.node(id).source.clone())
}

/// A node as error messages name it: `type.subType 'name'`, or `type.subType` unnamed.
pub fn child_label(tree: &Tree, id: NodeId) -> String {
    let n = tree.node(id);
    if n.name.is_empty() {
        format!("{}.{}", n.type_name, n.sub_type)
    } else {
        format!("{}.{} '{}'", n.type_name, n.sub_type, n.name)
    }
}

/// The grains `startOf` accepts on a relative date.
pub const START_OF_UNITS: &[&str] = &["day", "week", "month"];

// ---- the object index ---------------------------------------------------------------

/// Root-level objects by resolution key (ADR-0042 / ADR-0059), first declaration
/// winning, plus the objects in document order. Built once per load and shared by
/// every pass through [`crate::validate::Ctx`] and by the reference-rewrite phase.
#[derive(Debug, Default)]
pub struct ObjectIndex {
    by_key: HashMap<String, NodeId>,
    objs: Vec<NodeId>,
}

impl ObjectIndex {
    pub fn build(tree: &Tree, root: NodeId) -> Self {
        let mut by_key = HashMap::new();
        let mut objs = Vec::new();
        // ADR-0039 own: the root's top-level nodes are its declared children; a root extends nothing.
        for &c in tree.own_children(root) {
            if tree.node(c).type_name == TYPE_OBJECT {
                by_key.entry(tree.resolution_key(c)).or_insert(c);
                objs.push(c);
            }
        }
        Self { by_key, objs }
    }

    /// The root's top-level objects, in order.
    pub fn objects(&self) -> &[NodeId] {
        &self.objs
    }

    /// `resolveObjectRef` for an OWNER reference (no child tail): `::Rest` exact,
    /// `..::Rest` parent-relative (an over-dropped one resolves to nothing), `pkg::Name`
    /// exact, bare `Name` the referrer's package then root level.
    pub fn resolve(&self, owner: &str, referrer_pkg: &str) -> Option<NodeId> {
        let get = |k: &str| self.by_key.get(k).copied();
        if owner.starts_with(PACKAGE_SEP) || owner.starts_with("..::") {
            return owner_candidate_keys(owner, referrer_pkg)
                .ok()?
                .iter()
                .find_map(|k| get(k));
        }
        if referrer_pkg.is_empty() || owner.contains(PACKAGE_SEP) {
            return get(owner);
        }
        get(&format!("{referrer_pkg}{PACKAGE_SEP}{owner}")).or_else(|| get(owner))
    }

    /// `refTarget(node, attr)`: the layer declaring `attr` up the super chain, its value
    /// resolved from that layer's top-level package.
    pub fn ref_target(&self, tree: &Tree, node: NodeId, attr: &str) -> Option<NodeId> {
        let mut cur = Some(node);
        let mut steps = 0usize;
        while let Some(n) = cur {
            steps += 1;
            if steps > tree.len() {
                return None;
            }
            // ADR-0039 own: locating the layer that declares the attr, walking the super chain.
            if let Some(a) = tree.own_attr(n, attr) {
                let value = a.value.as_str().filter(|s| !s.is_empty())?;
                let (owner, _) = split_child_tail(value);
                return self.resolve(owner, &tree.effective_package(tree.top_level_of(n)));
            }
            cur = tree.node(n).super_node;
        }
        None
    }

    /// One to-one hop of a `@via` walk: the hop's target object.
    pub fn hop_target(&self, tree: &Tree, hop: NodeId, is_ref: bool) -> Option<NodeId> {
        self.ref_target(tree, hop, if is_ref { A_REFERENCES } else { A_OBJECT_REF })
            .filter(|&t| tree.node(t).type_name == TYPE_OBJECT)
    }

    /// The entity an origin's `@filter` keys name: the `@of` entity, else the `@via` terminal.
    pub fn origin_filter_entity(&self, tree: &Tree, origin: NodeId) -> Option<NodeId> {
        let field = tree.node(origin).parent?;
        let projection = tree.node(field).parent?;
        let pkg = tree.effective_package(projection);
        // ADR-0039 own: origin.* never inherits (ADR-0029).
        let own = |name: &str| {
            tree.own_attr(origin, name)
                .and_then(|a| a.value.as_str())
                .filter(|s| !s.is_empty())
        };
        if let Some(of) = own("of") {
            return self.resolve(split_child_tail(of).0, &pkg);
        }
        let (owner, hops) = split_dotted(own("via")?)?;
        let mut current = self.resolve(owner, &pkg)?;
        for h in hops {
            let (hop, is_ref) = find_hop(tree, current, h)?;
            current = self.hop_target(tree, hop, is_ref)?;
        }
        Some(current)
    }
}

/// Split `Owner.child[.child...]` at the first `.` after the last `::`.
pub fn split_dotted(r: &str) -> Option<(&str, Vec<&str>)> {
    let seg = r.rfind(PACKAGE_SEP).map_or(0, |i| i + PACKAGE_SEP.len());
    let dot = seg + r[seg..].find('.')?;
    if dot <= seg {
        return None;
    }
    let path: Vec<&str> = r[dot + 1..].split('.').collect();
    if path.iter().any(|s| s.is_empty()) {
        return None;
    }
    Some((&r[..dot], path))
}

/// One hop by name: a relationship, else an `identity.reference`; `true` when it is the latter.
pub fn find_hop(tree: &Tree, current: NodeId, name: &str) -> Option<(NodeId, bool)> {
    // ADR-0039: resolving: a hop may be inherited through extends.
    let kids = tree.children(current);
    let rel = kids.iter().copied().find(|&c| {
        let n = tree.node(c);
        n.type_name == "relationship" && n.name == name
    });
    match rel {
        Some(r) => Some((r, false)),
        None => kids
            .iter()
            .copied()
            .find(|&c| {
                let n = tree.node(c);
                n.type_name == "identity" && n.sub_type == "reference" && n.name == name
            })
            .map(|c| (c, true)),
    }
}

// ---- filter operator bands ----------------------------------------------------------

pub const OPS_STRING: &[&str] = &["eq", "ne", "in", "like", "isNull"];
pub const OPS_NUMBER: &[&str] = &["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"];
pub const OPS_BOOLEAN: &[&str] = &["eq", "isNull"];
pub const OPS_IDENTITY: &[&str] = &["eq", "ne", "in", "isNull"];

/// The filter-operator band of a field subtype; empty when it has none.
pub fn ops_for_subtype(sub_type: &str) -> &'static [&'static str] {
    match sub_type {
        "string" | "enum" | "uri" => OPS_STRING,
        "int" | "long" | "double" | "float" | "decimal" | "currency" | "date" | "time"
        | "timestamp" | "duration" => OPS_NUMBER,
        "boolean" => OPS_BOOLEAN,
        "uuid" | "inet" => OPS_IDENTITY,
        _ => &[],
    }
}

/// The band for a field: an int-backed enum drops `like`.
pub fn ops_for_field(tree: &Tree, id: NodeId) -> &'static [&'static str] {
    let n = tree.node(id);
    if n.sub_type == "enum"
        && tree
            .attr(id, "intValueMap")
            .is_some_and(serde_json::Value::is_object)
    {
        return OPS_IDENTITY;
    }
    ops_for_subtype(&n.sub_type)
}
