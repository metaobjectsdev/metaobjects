//! The metadata tree: every node lives in one arena and is addressed by a
//! [`NodeId`], so `extends` links and parent links are plain indices.
//!
//! Reads follow ADR-0039. The resolving accessors ([`Tree::attr`], [`Tree::attrs`],
//! [`Tree::children`], [`Tree::resolved_is_array`]) are the default: they see what a
//! node inherits through `extends`. The `own_*` accessors read only the layer a node
//! declares itself, and are for the few passes that work on that layer by definition
//! (the parser, the merge, super resolution and the own-mode serializer).

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

/// The arena holding every node of one load.
#[derive(Debug, Clone, Default)]
pub struct Tree {
    nodes: Vec<Node>,
}

impl Tree {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, node: Node) -> NodeId {
        let id = NodeId(u32::try_from(self.nodes.len()).expect("fewer than 2^32 nodes"));
        self.nodes.push(node);
        id
    }

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id.index()]
    }

    pub fn node_mut(&mut self, id: NodeId) -> &mut Node {
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
        self.nodes[child.index()].parent = Some(parent);
        self.nodes[parent.index()].children.push(child);
    }

    /// Replace `parent`'s own children wholesale (the merge rebuilds the root's).
    pub(crate) fn take_own_children(&mut self, parent: NodeId) -> Vec<NodeId> {
        std::mem::take(&mut self.nodes[parent.index()].children)
    }

    /// The children `id` declares itself, in authoring order.
    pub fn own_children(&self, id: NodeId) -> &[NodeId] {
        &self.nodes[id.index()].children
    }

    /// Effective children: what `id` inherits through `extends`, with each own child
    /// replacing the inherited child of the same type and name, and own children that
    /// replace nothing appended after. Mirrors the TypeScript reference's append queue.
    pub fn children(&self, id: NodeId) -> Vec<NodeId> {
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
        self.nodes[id.index()].attrs.insert(name.to_string(), attr);
    }

    /// The attribute `id` declares itself.
    pub fn own_attr(&self, id: NodeId, name: &str) -> Option<&Attr> {
        self.nodes[id.index()].attrs.get(name)
    }

    pub(crate) fn own_attr_mut(&mut self, id: NodeId, name: &str) -> Option<&mut Attr> {
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
    pub fn attr(&self, id: NodeId, name: &str) -> Option<&Value> {
        self.super_chain(id).into_iter().find_map(|n| {
            self.nodes[n.index()]
                .attrs
                .get(name)
                .map(|a| &a.value)
                .filter(|v| !v.is_null())
        })
    }

    /// Every effective attribute value of `id`, own winning over inherited.
    /// Null values are left out, as an unset attribute is.
    pub fn attrs(&self, id: NodeId) -> IndexMap<String, Value> {
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
    pub fn resolved_is_array(&self, id: NodeId) -> bool {
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
