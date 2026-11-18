//! The metadata tree: every node lives in one arena and is addressed by a
//! [`NodeId`], so `extends` links and parent links are plain indices.
//!
//! Reads follow ADR-0039. The resolving accessors ([`Tree::attr`], [`Tree::attrs`],
//! [`Tree::children`], [`Tree::resolved_is_array`]) are the default: they see what a
//! node inherits through `extends`. The `own_*` accessors read only the layer a node
//! declares itself, and are for the few passes that work on that layer by definition
//! (the parser, the merge, super resolution and the own-mode serializer).
//!
//! ## The runtime read path: freeze, then memoize
//!
//! A tree has two phases, as in every other port. While the loader builds it, it is
//! mutable and every resolving read walks the `extends` chain afresh. When the loader
//! reaches its terminal phase it calls [`Tree::freeze`], after which the tree can no
//! longer change (every mutator panics) and the resolving accessors memoize their
//! walks, one [`OnceLock`] per node and accessor. Nothing is cached before the freeze,
//! so a value read during the load can never be served stale after a later mutation,
//! and nothing is ever invalidated. The caches are filled on first read and are safe
//! to share between threads: `Tree` is `Sync`, and a racing first read of one entry
//! computes it once while the other readers wait.
//!
//! The memoized set is the one the other ports memoize on their base node:
//! [`Tree::children`], [`Tree::attrs`] (and [`Tree::attr`], which reads through it once
//! frozen, on a node that extends something) and [`Tree::resolved_is_array`]. TypeScript and C# also cache snapshots of a
//! node's own attrs and own children because they copy them; here those accessors
//! already borrow the node's own storage, so there is nothing to save.

use std::borrow::Cow;
use std::sync::OnceLock;

use indexmap::IndexMap;
use serde_json::Value;

use crate::source::ErrorSource;

/// The package separator in a resolution key (`acme::sales::Customer`).
pub const PACKAGE_SEP: &str = "::";

/// The index of a node in its [`Tree`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NodeId(pub(crate) u32);

impl NodeId {
    pub fn index(self) -> usize {
        self.0 as usize
    }

    /// The id of the node at `index` in its tree's arena.
    pub fn from_index(index: usize) -> Self {
        Self(u32::try_from(index).expect("fewer than 2^32 nodes"))
    }
}

/// One attribute value on a node.
#[derive(Debug, Clone, PartialEq)]
pub struct Attr {
    /// The attr subtype it was coerced as (`string`, `int`, `base`, ...).
    pub sub_type: String,
    pub value: Value,
    /// The value as written, kept when reference resolution rewrote `value` to its
    /// canonical spelling (ADR-0059 R5).
    pub authored_value: Option<Value>,
    pub source: ErrorSource,
}

/// One node of the tree.
#[derive(Debug, Clone)]
pub struct Node {
    pub type_name: String,
    pub sub_type: String,
    pub name: String,
    /// The package this node declares itself (`None` when it inherits its file's).
    pub package: Option<String>,
    /// The package of the file that declared it, captured at parse time; `Some("")`
    /// for a file with no package (ADR-0059 R10).
    pub file_default_package: Option<String>,
    /// The `extends` value. Canonical once the loader has resolved references.
    pub super_ref: Option<String>,
    /// The `extends` value as written, kept when it was rewritten.
    pub authored_super_ref: Option<String>,
    /// The node `extends` resolved to.
    pub super_node: Option<NodeId>,
    pub is_abstract: bool,
    pub is_overlay: bool,
    pub is_array: bool,
    pub parent: Option<NodeId>,
    attrs: IndexMap<String, Attr>,
    children: Vec<NodeId>,
    pub source: ErrorSource,
}

impl Node {
    pub fn new(type_name: &str, sub_type: &str, name: &str) -> Self {
        Self {
            type_name: type_name.to_string(),
            sub_type: sub_type.to_string(),
            name: name.to_string(),
            package: None,
            file_default_package: None,
            super_ref: None,
            authored_super_ref: None,
            super_node: None,
            is_abstract: false,
            is_overlay: false,
            is_array: false,
            parent: None,
            attrs: IndexMap::new(),
            children: Vec::new(),
            source: ErrorSource::Code,
        }
    }

    /// `package::name` when the node declares a package, else its name.
    pub fn fqn(&self) -> String {
        match self.package.as_deref() {
            Some(p) if !p.is_empty() => format!("{p}{PACKAGE_SEP}{}", self.name),
            _ => self.name.clone(),
        }
    }
}

/// The memoized resolving reads of one node, filled on first read after
/// [`Tree::freeze`].
#[derive(Debug, Clone, Default)]
struct NodeCache {
    children: OnceLock<Box<[NodeId]>>,
    attrs: OnceLock<IndexMap<String, Value>>,
    is_array: OnceLock<bool>,
}

/// The arena holding every node of one load.
#[derive(Debug, Clone, Default)]
pub struct Tree {
    nodes: Vec<Node>,
    /// One entry per node once frozen; empty while the tree is still mutable.
    cache: Vec<NodeCache>,
    frozen: bool,
}

const FROZEN_MUTATION: &str = "cannot mutate a frozen metadata tree";

impl Tree {
    pub fn new() -> Self {
        Self::default()
    }

    /// End the load phase: from here on the tree is read-only and the resolving
    /// accessors memoize what they compute. Idempotent.
    pub fn freeze(&mut self) {
        if self.frozen {
            return;
        }
        self.frozen = true;
        self.cache = vec![NodeCache::default(); self.nodes.len()];
    }

    /// `true` once [`Tree::freeze`] has ended the load phase.
    pub fn is_frozen(&self) -> bool {
        self.frozen
    }

    fn assert_mutable(&self) {
        assert!(!self.frozen, "{FROZEN_MUTATION}");
    }

    /// The node's cache entry, or `None` while the tree is still mutable.
    fn cache(&self, id: NodeId) -> Option<&NodeCache> {
        self.cache.get(id.index())
    }

    pub fn add(&mut self, node: Node) -> NodeId {
        self.assert_mutable();
        let id = NodeId::from_index(self.nodes.len());
        self.nodes.push(node);
        id
    }

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.index()]
    }

    pub fn node_mut(&mut self, id: NodeId) -> &mut Node {
        self.assert_mutable();
        &mut self.nodes[id.index()]
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    // ---- structure -------------------------------------------------------

    /// Append `child` to `parent`'s own children.
    pub fn add_child(&mut self, parent: NodeId, child: NodeId) {
        self.assert_mutable();
        self.nodes[child.index()].parent = Some(parent);
        self.nodes[parent.index()].children.push(child);
    }

    /// Replace `parent`'s own children wholesale (the merge rebuilds the root's).
    pub(crate) fn take_own_children(&mut self, parent: NodeId) -> Vec<NodeId> {
        self.assert_mutable();
        std::mem::take(&mut self.nodes[parent.index()].children)
    }

    /// The children `id` declares itself, in authoring order.
    pub fn own_children(&self, id: NodeId) -> &[NodeId] {
        &self.nodes[id.index()].children
    }

    /// Effective children: what `id` inherits through `extends`, with each own child
    /// replacing the inherited child of the same type and name, and own children that
    /// replace nothing appended after. Mirrors the TypeScript reference's append queue.
    /// Memoized once the tree is frozen.
    pub fn children(&self, id: NodeId) -> Cow<'_, [NodeId]> {
        if self.node(id).super_node.is_none() {
            return Cow::Borrowed(&self.node(id).children);
        }
        match self.cache(id) {
            Some(c) => Cow::Borrowed(c.children.get_or_init(|| self.compute_children(id).into())),
            None => Cow::Owned(self.compute_children(id)),
        }
    }

    fn compute_children(&self, id: NodeId) -> Vec<NodeId> {
        let mut visited = vec![id];
        self.effective_children(id, &mut visited)
    }

    fn effective_children(&self, id: NodeId, visited: &mut Vec<NodeId>) -> Vec<NodeId> {
        let node = self.node(id);
        let Some(sup) = node.super_node.filter(|s| !visited.contains(s)) else {
            return node.children.clone();
        };
        visited.push(sup);
        let mut result = self.effective_children(sup, visited);
        let mut claimed = vec![false; result.len()];
        let mut append = Vec::new();
        for &own in &node.children {
            let o = self.node(own);
            let hit = result.iter().enumerate().position(|(i, &c)| {
                let c = self.node(c);
                !claimed[i] && c.type_name == o.type_name && c.name == o.name
            });
            match hit {
                Some(i) => {
                    result[i] = own;
                    claimed[i] = true;
                }
                None => append.push(own),
            }
        }
        result.extend(append);
        result
    }

    // ---- attributes ------------------------------------------------------

    pub fn set_attr(&mut self, id: NodeId, name: &str, attr: Attr) {
        self.assert_mutable();
        self.nodes[id.index()].attrs.insert(name.to_string(), attr);
    }

    /// The attribute `id` declares itself.
    pub fn own_attr(&self, id: NodeId, name: &str) -> Option<&Attr> {
        self.nodes[id.index()].attrs.get(name)
    }

    pub(crate) fn own_attr_mut(&mut self, id: NodeId, name: &str) -> Option<&mut Attr> {
        self.assert_mutable();
        self.nodes[id.index()].attrs.get_mut(name)
    }

    /// The attributes `id` declares itself, in authoring order.
    pub fn own_attrs(&self, id: NodeId) -> impl Iterator<Item = (&String, &Attr)> {
        self.nodes[id.index()].attrs.iter()
    }

    /// `id`, then what it extends, then what that extends, stopping at a cycle.
    fn super_chain(&self, id: NodeId) -> Vec<NodeId> {
        let mut chain = Vec::new();
        let mut cur = Some(id);
        while let Some(n) = cur {
            if chain.contains(&n) {
                break;
            }
            chain.push(n);
            cur = self.nodes[n.index()].super_node;
        }
        chain
    }

    /// The effective value of attribute `name`: own, else inherited through `extends`.
    /// Once frozen it is a lookup in the memoized [`Tree::attrs`] map.
    pub fn attr(&self, id: NodeId, name: &str) -> Option<&Value> {
        // A node that extends nothing answers from its own map, a borrow, with no cache.
        if self.node(id).super_node.is_none() {
            return self.compute_attr(id, name);
        }
        match self.cache(id) {
            Some(c) => c.attrs.get_or_init(|| self.compute_attrs(id)).get(name),
            None => self.compute_attr(id, name),
        }
    }

    fn compute_attr(&self, id: NodeId, name: &str) -> Option<&Value> {
        self.super_chain(id).into_iter().find_map(|n| {
            self.nodes[n.index()]
                .attrs
                .get(name)
                .map(|a| &a.value)
                .filter(|v| !v.is_null())
        })
    }

    /// Every effective attribute value of `id`, own winning over inherited.
    /// Null values are left out, as an unset attribute is. Memoized once frozen.
    pub fn attrs(&self, id: NodeId) -> Cow<'_, IndexMap<String, Value>> {
        match self.cache(id) {
            Some(c) => Cow::Borrowed(c.attrs.get_or_init(|| self.compute_attrs(id))),
            None => Cow::Owned(self.compute_attrs(id)),
        }
    }

    fn compute_attrs(&self, id: NodeId) -> IndexMap<String, Value> {
        let mut out = IndexMap::new();
        for n in self.super_chain(id).into_iter().rev() {
            for (k, a) in &self.nodes[n.index()].attrs {
                if !a.value.is_null() {
                    out.insert(k.clone(), a.value.clone());
                }
            }
        }
        out
    }

    /// Effective array-ness: the native flag on `id` or anything it extends.
    /// Memoized once frozen.
    pub fn resolved_is_array(&self, id: NodeId) -> bool {
        match self.cache(id) {
            Some(c) => *c.is_array.get_or_init(|| self.compute_is_array(id)),
            None => self.compute_is_array(id),
        }
    }

    fn compute_is_array(&self, id: NodeId) -> bool {
        self.super_chain(id)
            .into_iter()
            .any(|n| self.nodes[n.index()].is_array)
    }

    // ---- packages and names ----------------------------------------------

    /// The package `id` resolves under: its own, else its file's, else (for a node
    /// built in code) the nearest ancestor's.
    pub fn effective_package(&self, id: NodeId) -> String {
        let node = self.node(id);
        if let Some(p) = node.package.as_deref().filter(|p| !p.is_empty()) {
            return p.to_string();
        }
        if let Some(p) = node.file_default_package.as_deref() {
            return p.to_string();
        }
        let mut cur = node.parent;
        while let Some(n) = cur {
            if let Some(p) = self.node(n).package.as_deref().filter(|p| !p.is_empty()) {
                return p.to_string();
            }
            cur = self.node(n).parent;
        }
        String::new()
    }

    /// `<effective package>::<name>`, or the bare name with no package.
    pub fn resolution_key(&self, id: NodeId) -> String {
        let pkg = self.effective_package(id);
        if pkg.is_empty() {
            self.node(id).name.clone()
        } else {
            format!("{pkg}{PACKAGE_SEP}{}", self.node(id).name)
        }
    }

    /// The top-level node (a direct child of the root) that physically holds `id`.
    pub fn top_level_of(&self, id: NodeId) -> NodeId {
        let mut cur = id;
        while let Some(p) = self.node(cur).parent {
            if self.node(p).parent.is_none() {
                return cur;
            }
            cur = p;
        }
        cur
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::Loader;
    use crate::providers::default_registry;
    use serde_json::json;

    const FITNESS: &str =
        include_str!("../../../../fixtures/persistence-conformance/canonical/meta.fitness.json");

    fn attr(value: Value) -> Attr {
        Attr {
            sub_type: "string".into(),
            value,
            authored_value: None,
            source: ErrorSource::Code,
        }
    }

    /// `Derived extends Base`, each with a field and an attr, `Base` an array.
    fn chain() -> (Tree, NodeId, NodeId) {
        let mut t = Tree::new();
        let root = t.add(Node::new("metadata", "root", ""));
        let base = t.add(Node::new("object", "entity", "Base"));
        let derived = t.add(Node::new("object", "entity", "Derived"));
        t.add_child(root, base);
        t.add_child(root, derived);
        for (owner, field) in [
            (base, "id"),
            (base, "name"),
            (derived, "name"),
            (derived, "age"),
        ] {
            let f = t.add(Node::new("field", "string", field));
            t.add_child(owner, f);
        }
        t.set_attr(base, "table", attr(json!("base_t")));
        t.set_attr(base, "label", attr(json!("Base")));
        t.set_attr(derived, "label", attr(json!("Derived")));
        t.node_mut(base).is_array = true;
        t.node_mut(derived).super_node = Some(base);
        (t, base, derived)
    }

    fn assert_cached_matches_uncached(t: &Tree) {
        for i in 0..t.len() {
            let id = NodeId::from_index(i);
            assert_eq!(
                *t.children(id),
                t.compute_children(id)[..],
                "children of {i}"
            );
            assert_eq!(*t.attrs(id), t.compute_attrs(id), "attrs of {i}");
            assert_eq!(
                t.resolved_is_array(id),
                t.compute_is_array(id),
                "is_array of {i}"
            );
            for k in t.compute_attrs(id).keys() {
                assert_eq!(t.attr(id, k), t.compute_attr(id, k), "attr {k} of {i}");
            }
            assert_eq!(t.attr(id, "noSuchAttr"), None);
        }
    }

    #[test]
    fn nothing_is_cached_before_freeze() {
        let (t, _, derived) = chain();
        assert!(!t.is_frozen());
        assert!(matches!(t.children(derived), Cow::Owned(_)));
        assert!(matches!(t.attrs(derived), Cow::Owned(_)));
    }

    #[test]
    fn frozen_reads_are_borrowed_from_the_cache() {
        let (mut t, _, derived) = chain();
        t.freeze();
        let first = t.attrs(derived);
        assert!(matches!(first, Cow::Borrowed(_)));
        assert!(std::ptr::eq(&*first, &*t.attrs(derived)), "one cached map");
        assert!(matches!(t.children(derived), Cow::Borrowed(_)));
        assert!(t.resolved_is_array(derived));
    }

    #[test]
    fn a_value_read_before_freeze_does_not_survive_a_later_mutation() {
        let (mut t, base, derived) = chain();
        // Read every memoized accessor during the load phase ...
        assert_eq!(t.attr(derived, "table"), Some(&json!("base_t")));
        assert_eq!(t.attrs(derived).len(), 2);
        assert_eq!(t.children(derived).len(), 3);
        assert!(t.resolved_is_array(derived));
        // ... then change what they depend on, and freeze.
        t.set_attr(base, "table", attr(json!("renamed_t")));
        t.set_attr(derived, "extra", attr(json!(1)));
        let more = t.add(Node::new("field", "string", "email"));
        t.add_child(base, more);
        t.node_mut(base).is_array = false;
        t.freeze();
        assert_eq!(t.attr(derived, "table"), Some(&json!("renamed_t")));
        assert_eq!(t.attrs(derived).len(), 3);
        assert_eq!(t.children(derived).len(), 4);
        assert!(!t.resolved_is_array(derived));
        assert_cached_matches_uncached(&t);
    }

    #[test]
    fn freeze_is_idempotent_and_keeps_the_cache() {
        let (mut t, _, derived) = chain();
        t.freeze();
        let before: *const IndexMap<String, Value> = &*t.attrs(derived);
        t.freeze();
        assert!(std::ptr::eq(before, &*t.attrs(derived)));
    }

    #[test]
    #[should_panic(expected = "cannot mutate a frozen metadata tree")]
    fn a_frozen_tree_refuses_mutation() {
        let (mut t, base, _) = chain();
        t.freeze();
        t.set_attr(base, "table", attr(json!("late")));
    }

    #[test]
    fn cached_reads_equal_uncached_on_a_hand_built_chain() {
        let (mut t, _, _) = chain();
        t.freeze();
        assert_cached_matches_uncached(&t);
        // A second pass reads only from the cache.
        assert_cached_matches_uncached(&t);
    }

    #[test]
    fn cached_reads_equal_uncached_on_the_fitness_model() {
        let registry = default_registry().expect("the built-in providers compose");
        let result =
            Loader::new(&registry).load_sources(&[("meta.fitness.json".into(), FITNESS.into())]);
        assert!(result.errors.is_empty(), "{:?}", result.errors.first());
        assert!(
            result.tree.is_frozen(),
            "the loader freezes at its terminal phase"
        );
        let t = &result.tree;
        let extending = (0..t.len())
            .filter(|&i| t.nodes[i].super_node.is_some())
            .count();
        assert!(extending > 0, "the model exercises extends");
        assert_cached_matches_uncached(&result.tree);
    }

    #[test]
    fn concurrent_readers_see_the_uncached_values() {
        let registry = default_registry().expect("the built-in providers compose");
        let result =
            Loader::new(&registry).load_sources(&[("meta.fitness.json".into(), FITNESS.into())]);
        let tree = &result.tree;
        let ids: Vec<NodeId> = (0..tree.len()).map(NodeId::from_index).collect();
        let expected: Vec<_> = ids
            .iter()
            .map(|&id| {
                (
                    tree.compute_children(id),
                    tree.compute_attrs(id),
                    tree.compute_is_array(id),
                )
            })
            .collect();
        std::thread::scope(|s| {
            for worker in 0..8 {
                let (ids, expected) = (&ids, &expected);
                s.spawn(move || {
                    // Each worker walks the nodes from a different start, so first reads race.
                    for round in 0..4 {
                        for k in 0..ids.len() {
                            let i = (k + worker * 7 + round) % ids.len();
                            let (children, attrs, is_array) = &expected[i];
                            assert_eq!(*tree.children(ids[i]), children[..]);
                            assert_eq!(*tree.attrs(ids[i]), *attrs);
                            assert_eq!(tree.resolved_is_array(ids[i]), *is_array);
                        }
                    }
                });
            }
        });
    }
}
