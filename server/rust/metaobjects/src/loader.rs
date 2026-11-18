//! The loader: read files, parse each, merge the roots, resolve `extends` and
//! spell every reference canonically.
//!
//! Order of passes, as in every port: parse → merge → super resolution →
//! (validation, a later step of this port) → reference resolution.
//!
//! Built for speed from the start: each file is read once and parsed straight into
//! one arena, nothing is written to disk, and the passes walk the tree a fixed
//! number of times.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::errors::{
    ERR_BAD_ATTR_VALUE, ERR_EXTENDS_TARGET_MISMATCH, ERR_MALFORMED_JSON, ERR_OVERLAY_NO_TARGET,
    ERR_UNKNOWN, ERR_UNKNOWN_SUBTYPE, ERR_UNKNOWN_TYPE, ERR_UNRESOLVED_SUPER, MetaError,
};
use crate::node::{Node, NodeId, PACKAGE_SEP, Tree};
use crate::parser::{SUBTYPE_ROOT, TYPE_METADATA, TYPE_OBJECT, parse_document};
use crate::registry::TypeRegistry;
use crate::source::ErrorSource;

/// The extensions a directory load picks up. YAML is a later step of this port;
/// a `.yaml` file is reported rather than silently skipped.
const JSON_SUFFIX: &str = "json";
const YAML_SUFFIXES: &[&str] = &["yaml", "yml"];
/// A directory of drafts that a directory load never descends into.
const PENDING_DIR: &str = "_pending";

const TYPE_IDENTITY: &str = "identity";
const IDENTITY_UNIQUE_KEY_SUBTYPES: &[&str] = &["primary", "secondary"];

/// Attributes whose value names another top-level object (ADR-0059 R4).
pub const REF_BEARING_ATTR_NAMES: &[&str] = &[
    "objectRef",
    "through",
    "references",
    "from",
    "via",
    "of",
    "parameterRef",
    "payloadRef",
    "responseRef",
    "spine",
];

/// One load: the tree, its root, and every error and warning.
#[derive(Debug)]
pub struct LoadResult {
    pub tree: Tree,
    pub root: NodeId,
    pub errors: Vec<MetaError>,
    pub warnings: Vec<MetaError>,
}

/// Loads metadata against one registry.
pub struct Loader<'r> {
    registry: &'r TypeRegistry,
}

/// Every metadata file under `dir`, recursively, sorted by file name as every
/// port's directory source does. `exclude_pending` skips `_pending/` at any depth;
/// it is off at the loader level, as in the other ports, where only the CLI-facing
/// source resolution turns it on.
/// A symlinked directory is followed once: a link back to a directory already
/// walked (a cycle, or a second route to the same files) is skipped.
pub fn metadata_files(dir: &Path, exclude_pending: bool) -> std::io::Result<Vec<PathBuf>> {
    fn walk(
        dir: &Path,
        exclude_pending: bool,
        seen: &mut std::collections::HashSet<PathBuf>,
        out: &mut Vec<PathBuf>,
    ) -> std::io::Result<()> {
        if !seen.insert(std::fs::canonicalize(dir)?) {
            return Ok(());
        }
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                if exclude_pending && path.file_name().is_some_and(|n| n == PENDING_DIR) {
                    continue;
                }
                walk(&path, exclude_pending, seen, out)?;
            } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext = ext.to_ascii_lowercase();
                if ext == JSON_SUFFIX || YAML_SUFFIXES.contains(&ext.as_str()) {
                    out.push(path);
                }
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(
        dir,
        exclude_pending,
        &mut std::collections::HashSet::new(),
        &mut out,
    )?;
    out.sort_by(|a, b| a.file_name().cmp(&b.file_name()).then_with(|| a.cmp(b)));
    Ok(out)
}

impl<'r> Loader<'r> {
    pub fn new(registry: &'r TypeRegistry) -> Self {
        Self { registry }
    }

    /// Load every metadata file under `dir`. A directory that cannot be walked is
    /// an `Err`; a file that cannot be read is an error in the result, and the
    /// other files still load.
    pub fn load_dir(&self, dir: &Path) -> std::io::Result<LoadResult> {
        let files = metadata_files(dir, false)?;
        let mut sources = Vec::with_capacity(files.len());
        let mut unreadable = Vec::new();
        for f in files {
            let id = f.to_string_lossy().into_owned();
            match std::fs::read_to_string(&f) {
                Ok(text) => sources.push((id, text)),
                Err(e) => unreadable.push(MetaError::at(
                    ERR_UNKNOWN,
                    format!("{id}: cannot read metadata file: {e}"),
                    ErrorSource::json(&id, "$"),
                )),
            }
        }
        let mut result = self.load_sources(&sources);
        unreadable.append(&mut result.errors);
        result.errors = unreadable;
        Ok(result)
    }

    /// Load `(id, text)` pairs, each one JSON document named `id` in errors.
    pub fn load_sources(&self, sources: &[(String, String)]) -> LoadResult {
        let mut tree = Tree::new();
        let mut errors = Vec::new();
        let mut roots = Vec::new();
        for (id, text) in sources {
            let envelope = if id.is_empty() {
                ErrorSource::Code
            } else {
                ErrorSource::json(id, "$")
            };
            let lower = id.to_ascii_lowercase();
            if YAML_SUFFIXES
                .iter()
                .any(|s| lower.ends_with(&format!(".{s}")))
            {
                errors.push(MetaError::at(
                    ERR_UNKNOWN,
                    format!("{id}: YAML metadata is not supported by the Rust port yet"),
                    envelope,
                ));
                continue;
            }
            let doc: Value = match serde_json::from_str(text) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(MetaError::at(ERR_MALFORMED_JSON, e.to_string(), envelope));
                    continue;
                }
            };
            let parsed = parse_document(&doc, self.registry, &mut tree, id);
            // An unknown type or subtype drops only that node, so the rest of the
            // document is kept; any other parse error drops the document, as the
            // TypeScript and Python loaders do.
            let keep = parsed
                .errors
                .iter()
                .all(|e| e.code == ERR_UNKNOWN_SUBTYPE || e.code == ERR_UNKNOWN_TYPE);
            errors.extend(parsed.errors);
            if keep && let Some(root) = parsed.root {
                roots.push(root);
            }
        }
        let root = if roots.is_empty() {
            tree.add(Node::new(TYPE_METADATA, SUBTYPE_ROOT, ""))
        } else {
            let root = merge_roots(&mut tree, &roots, &mut errors);
            // Neither pass adds, removes or renames a top-level node, so one index serves both.
            let top = TopLevel::build(&tree, root);
            resolve_supers(&mut tree, root, &top, &mut errors);
            resolve_references(&mut tree, root, &top);
            root
        };
        // The terminal phase: the tree is complete, so it becomes read-only and its
        // resolving reads memoize from here on (the other ports freeze at REGISTERED).
        tree.freeze();
        LoadResult {
            tree,
            root,
            errors,
            warnings: Vec::new(),
        }
    }
}

// ---- merge -----------------------------------------------------------------

/// The package-qualified identity of a root-level node for merge matching: its own
/// package, else its file's (never the merged root's).
fn root_child_key(tree: &Tree, id: NodeId) -> String {
    let n = tree.node(id);
    let pkg = n
        .package
        .as_deref()
        .filter(|p| !p.is_empty())
        .or(n.file_default_package.as_deref().filter(|p| !p.is_empty()));
    match pkg {
        Some(p) => format!("{p}{PACKAGE_SEP}{}", n.name),
        None => n.name.clone(),
    }
}

/// The same-type, same-name own child of `target` that `sc` merges into. Unnamed
/// nodes never match: they are always distinct (inline validators, say).
fn find_merge_match(tree: &Tree, target: NodeId, sc: NodeId) -> Option<NodeId> {
    let is_root = tree.node(target).parent.is_none();
    let s = tree.node(sc);
    if s.name.is_empty() {
        return None;
    }
    let key = is_root.then(|| root_child_key(tree, sc));
    // ADR-0039: own — the merge works on the authored layer, before super resolution.
    tree.own_children(target).iter().copied().find(|&c| {
        let n = tree.node(c);
        n.type_name == s.type_name
            && n.name == s.name
            && key.as_ref().is_none_or(|k| root_child_key(tree, c) == *k)
    })
}

/// Fold every root into the first (ADR-0055's two-pass fold): plain declarations
/// merge by type and name, last writer wins; `overlay: true` nodes are applied once
/// every plain declaration is present.
fn merge_roots(tree: &mut Tree, roots: &[NodeId], errors: &mut Vec<MetaError>) -> NodeId {
    let target = roots[0];
    let contributions: Vec<Vec<NodeId>> = roots
        .iter()
        // ADR-0039: own — the merge works on the authored layer, before super resolution.
        .map(|&r| tree.own_children(r).to_vec())
        .collect();
    tree.take_own_children(target);
    // Root-level matches go through an index: a large model has thousands of
    // top-level nodes, and a linear scan per node would make the merge quadratic.
    let mut index: HashMap<(String, String), NodeId> = HashMap::new();
    let mut pending = Vec::new();
    for (i, children) in contributions.into_iter().enumerate() {
        if i > 0 {
            let attrs: Vec<_> = tree
                // ADR-0039: own — the merge works on the authored layer, before super resolution.
                .own_attrs(roots[i])
                .map(|(k, a)| (k.clone(), a.clone()))
                .collect();
            for (k, a) in attrs {
                tree.set_attr(target, &k, a);
            }
        }
        for sc in children {
            if tree.node(sc).is_overlay {
                pending.push((target, sc));
                continue;
            }
            if tree.node(sc).name.is_empty() {
                // Unnamed nodes are always distinct.
                tree.add_child(target, sc);
                defer_nested_overlays(tree, sc, errors, Some(&mut pending));
                continue;
            }
            let key = (tree.node(sc).type_name.clone(), root_child_key(tree, sc));
            match index.get(&key) {
                Some(&tc) => merge_into(tree, tc, sc, errors, Some(&mut pending)),
                None => {
                    index.insert(key, sc);
                    tree.add_child(target, sc);
                    defer_nested_overlays(tree, sc, errors, Some(&mut pending));
                }
            }
        }
    }
    for (parent, node) in pending {
        apply_overlay(tree, parent, node, errors);
    }
    target
}

fn merge_child_into(
    tree: &mut Tree,
    target: NodeId,
    sc: NodeId,
    errors: &mut Vec<MetaError>,
    pending: Option<&mut Vec<(NodeId, NodeId)>>,
) {
    if tree.node(sc).is_overlay {
        match pending {
            Some(p) => p.push((target, sc)),
            None => apply_overlay(tree, target, sc, errors),
        }
        return;
    }
    match find_merge_match(tree, target, sc) {
        Some(tc) => merge_into(tree, tc, sc, errors, pending),
        None => {
            tree.add_child(target, sc);
            defer_nested_overlays(tree, sc, errors, pending);
        }
    }
}

fn defer_nested_overlays(
    tree: &mut Tree,
    node: NodeId,
    errors: &mut Vec<MetaError>,
    mut pending: Option<&mut Vec<(NodeId, NodeId)>>,
) {
    // ADR-0039: own — the merge works on the authored layer, before super resolution.
    let children = tree.own_children(node).to_vec();
    if !children.iter().any(|&c| subtree_has_overlay(tree, c)) {
        return;
    }
    let kept: Vec<NodeId> = children
        .iter()
        .copied()
        .filter(|&c| !tree.node(c).is_overlay)
        .collect();
    tree.take_own_children(node);
    for &c in &kept {
        tree.add_child(node, c);
    }
    for c in children {
        if tree.node(c).is_overlay {
            match pending.as_deref_mut() {
                Some(p) => p.push((node, c)),
                None => apply_overlay(tree, node, c, errors),
            }
        } else {
            defer_nested_overlays(tree, c, errors, pending.as_deref_mut());
        }
    }
}

fn subtree_has_overlay(tree: &Tree, id: NodeId) -> bool {
    tree.node(id).is_overlay
        || tree
            // ADR-0039: own — the merge works on the authored layer, before super resolution.
            .own_children(id)
            .iter()
            .any(|&c| subtree_has_overlay(tree, c))
}

fn apply_overlay(tree: &mut Tree, parent: NodeId, node: NodeId, errors: &mut Vec<MetaError>) {
    match find_merge_match(tree, parent, node) {
        Some(tc) => merge_into(tree, tc, node, errors, None),
        None => {
            let n = tree.node(node);
            let p = tree.node(parent);
            let referrer = if p.parent.is_none() {
                root_child_key(tree, node)
            } else {
                format!("{}.{}", p.name, n.name)
            };
            let target = format!("{}:{}", n.type_name, n.name);
            errors.push(MetaError::at(
                ERR_OVERLAY_NO_TARGET,
                format!("overlay node '{}' has no merge target", n.fqn()),
                resolved_source(&n.source, referrer, target),
            ));
        }
    }
}

fn merge_into(
    tree: &mut Tree,
    target: NodeId,
    src: NodeId,
    errors: &mut Vec<MetaError>,
    mut pending: Option<&mut Vec<(NodeId, NodeId)>>,
) {
    let attrs: Vec<_> = tree
        // ADR-0039: own — the merge works on the authored layer, before super resolution.
        .own_attrs(src)
        .map(|(k, a)| (k.clone(), a.clone()))
        .collect();
    for (k, a) in attrs {
        tree.set_attr(target, &k, a);
    }
    // ADR-0039: own — the merge works on the authored layer, before super resolution.
    for sc in tree.own_children(src).to_vec() {
        merge_child_into(tree, target, sc, errors, pending.as_deref_mut());
    }
}

/// A `resolved` envelope at `source`'s location.
fn resolved_source(source: &ErrorSource, referrer: String, target: String) -> ErrorSource {
    ErrorSource::Resolved {
        files: source.files().to_vec(),
        json_path: source.json_path().unwrap_or("$").to_string(),
        referrer,
        target,
    }
}

// ---- references --------------------------------------------------------------

const CHILD_REF_SEP: char = '.';
const PARENT_PREFIX: &str = "..::";

/// Split a reference into its owner and any dotted child tail (tail keeps its `.`).
pub fn split_child_tail(raw: &str) -> (&str, &str) {
    let seg_start = raw.rfind(PACKAGE_SEP).map_or(0, |i| i + PACKAGE_SEP.len());
    match raw[seg_start..].find(CHILD_REF_SEP) {
        Some(dot) => raw.split_at(seg_start + dot),
        None => (raw, ""),
    }
}

/// A `..::` reference climbed above the root package.
#[derive(Debug)]
pub struct OverDrop;

/// The resolution keys an owner reference may bind, in order (ADR-0059 R2).
pub fn owner_candidate_keys(owner: &str, referrer_pkg: &str) -> Result<Vec<String>, OverDrop> {
    if let Some(rest) = owner.strip_prefix(PACKAGE_SEP) {
        return Ok(vec![rest.to_string()]);
    }
    if owner.starts_with(PARENT_PREFIX) {
        let mut rest = owner;
        let mut levels = 0;
        while let Some(r) = rest.strip_prefix(PARENT_PREFIX) {
            levels += 1;
            rest = r;
        }
        let parts: Vec<&str> = if referrer_pkg.is_empty() {
            Vec::new()
        } else {
            referrer_pkg.split(PACKAGE_SEP).collect()
        };
        if levels > parts.len() {
            return Err(OverDrop);
        }
        let reduced = parts[..parts.len() - levels].join(PACKAGE_SEP);
        return Ok(vec![if reduced.is_empty() {
            rest.to_string()
        } else {
            format!("{reduced}{PACKAGE_SEP}{rest}")
        }]);
    }
    if owner.contains(PACKAGE_SEP) {
        return Ok(vec![owner.to_string()]);
    }
    if referrer_pkg.is_empty() {
        Ok(vec![owner.to_string()])
    } else {
        Ok(vec![
            format!("{referrer_pkg}{PACKAGE_SEP}{owner}"),
            owner.to_string(),
        ])
    }
}

/// The canonical spelling of a resolved owner, from a referrer in `referrer_pkg`
/// (ADR-0059 R6).
pub fn spell_ref(tree: &Tree, target: NodeId, referrer_pkg: &str, tail: &str) -> String {
    let key = tree.resolution_key(target);
    if !key.contains(PACKAGE_SEP) && !referrer_pkg.is_empty() {
        format!("{PACKAGE_SEP}{key}{tail}")
    } else {
        format!("{key}{tail}")
    }
}

fn is_child_targeting_ref(r: &str) -> bool {
    let seg_start = r.rfind(PACKAGE_SEP).map_or(0, |i| i + PACKAGE_SEP.len());
    r[seg_start..].contains(CHILD_REF_SEP)
}

/// `Owner.child` → `Owner`, keeping any package prefix.
fn owner_ref(r: &str) -> Option<String> {
    let seg_start = r.rfind(PACKAGE_SEP).map_or(0, |i| i + PACKAGE_SEP.len());
    let parts: Vec<&str> = r[seg_start..].split(CHILD_REF_SEP).collect();
    if parts.len() < 2 || parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    Some(format!("{}{}", &r[..seg_start], parts[0]))
}

enum Resolved {
    Found(NodeId),
    Missing,
    OverDrop,
}

struct SuperResolver<'a> {
    tree: &'a mut Tree,
    root: NodeId,
    index: &'a HashMap<String, NodeId>,
    attempted: HashSet<NodeId>,
    errors: &'a mut Vec<MetaError>,
}

impl SuperResolver<'_> {
    fn lookup(&self, r: &str, pkg: &str, referrer_type: Option<&str>) -> Resolved {
        if is_child_targeting_ref(r) {
            let Some(referrer_type) = referrer_type else {
                return Resolved::Missing;
            };
            let seg_start = r.rfind(PACKAGE_SEP).map_or(0, |i| i + PACKAGE_SEP.len());
            let parts: Vec<&str> = r[seg_start..].split(CHILD_REF_SEP).collect();
            if parts.len() < 2 || parts.iter().any(|p| p.is_empty()) {
                return Resolved::Missing;
            }
            let owner = format!("{}{}", &r[..seg_start], parts[0]);
            let mut current = match self.lookup(&owner, pkg, None) {
                Resolved::Found(n) => n,
                other => return other,
            };
            for seg in &parts[1..parts.len() - 1] {
                let matches: Vec<NodeId> = self
                    .tree
                    .children(current)
                    .iter()
                    .copied()
                    .filter(|&c| self.tree.node(c).name == *seg)
                    .collect();
                if matches.len() != 1 {
                    return Resolved::Missing;
                }
                current = matches[0];
            }
            let last = parts[parts.len() - 1];
            return self
                .tree
                .children(current)
                .iter()
                .copied()
                .find(|&c| {
                    let n = self.tree.node(c);
                    n.name == last && n.type_name == referrer_type
                })
                .map_or(Resolved::Missing, Resolved::Found);
        }
        match owner_candidate_keys(r, pkg) {
            Err(OverDrop) => Resolved::OverDrop,
            Ok(keys) => keys
                .iter()
                .find_map(|k| self.index.get(k).copied())
                .map_or(Resolved::Missing, Resolved::Found),
        }
    }

    /// Record an extends error on `id`. The node's fqn and source are built only here,
    /// on the error path, never for an extends that resolves.
    fn fail(
        &mut self,
        id: NodeId,
        super_ref: &str,
        code: &'static str,
        message: impl FnOnce(&str) -> String,
    ) {
        let node = self.tree.node(id);
        let fqn = node.fqn();
        let source = resolved_source(&node.source, fqn.clone(), super_ref.to_string());
        self.errors.push(MetaError::at(code, message(&fqn), source));
    }

    fn resolve(&mut self, id: NodeId) {
        let node = self.tree.node(id);
        let Some(super_ref) = node.super_ref.clone() else {
            return;
        };
        if node.super_node.is_some() || !self.attempted.insert(id) {
            return;
        }
        let pkg = self.tree.effective_package(id);
        if is_child_targeting_ref(&super_ref)
            && let Some(owner) = owner_ref(&super_ref)
            && let Resolved::Found(o) = self.lookup(&owner, &pkg, None)
        {
            self.resolve(o);
        }
        let referrer_type = self.tree.node(id).type_name.clone();
        match self.lookup(&super_ref, &pkg, Some(&referrer_type)) {
            Resolved::OverDrop => self.fail(id, &super_ref, ERR_BAD_ATTR_VALUE, |fqn| {
                format!(
                    "the extends ref '{super_ref}' on {fqn} climbs above the root package — each '..::' drops one segment of the declaring package"
                )
            }),
            Resolved::Missing => {
                let hint = did_you_mean_super_hint(self.tree, self.root, &super_ref);
                self.fail(id, &super_ref, ERR_UNRESOLVED_SUPER, |fqn| {
                    format!("the SuperClass '{super_ref}' does not exist (referenced by {fqn}){hint}")
                });
            }
            Resolved::Found(target) => {
                if is_child_targeting_ref(&super_ref) && !extends_target_compatible(self.tree, id, target) {
                    let (t, n) = (self.tree.node(target), self.tree.node(id));
                    let kinds = format!(
                        "[{}.{}] but the extending node is [{}.{}]",
                        t.type_name, t.sub_type, n.type_name, n.sub_type
                    );
                    self.fail(id, &super_ref, ERR_EXTENDS_TARGET_MISMATCH, |fqn| {
                        format!(
                            "the dotted extends target '{super_ref}' is {kinds} — a dotted extends must target a node of the same type and subtype — the one exception is an identity, which may extend any UNIQUE key (identity.primary or identity.secondary) (referenced by {fqn})"
                        )
                    });
                } else {
                    self.tree.node_mut(id).super_node = Some(target);
                    self.resolve(target);
                }
            }
        }
    }
}

fn extends_target_compatible(tree: &Tree, node: NodeId, target: NodeId) -> bool {
    let (n, t) = (tree.node(node), tree.node(target));
    if t.type_name != n.type_name {
        return false;
    }
    if t.sub_type == n.sub_type {
        return true;
    }
    n.type_name == TYPE_IDENTITY
        && IDENTITY_UNIQUE_KEY_SUBTYPES.contains(&n.sub_type.as_str())
        && IDENTITY_UNIQUE_KEY_SUBTYPES.contains(&t.sub_type.as_str())
}

/// The did-you-mean suffix for an unresolved `extends`: same-short-name objects
/// that exist in other packages, and the spelling to write.
fn did_you_mean_super_hint(tree: &Tree, root: NodeId, r: &str) -> String {
    let (owner, _) = split_child_tail(r);
    let short = owner.rsplit(PACKAGE_SEP).next().unwrap_or(owner);
    let candidates: Vec<String> = tree
        .children(root)
        .iter()
        .copied()
        .filter(|&c| {
            let n = tree.node(c);
            n.type_name == TYPE_OBJECT && n.name == short
        })
        .map(|c| tree.resolution_key(c))
        .collect();
    if candidates.is_empty() {
        return String::new();
    }
    format!(
        " An object named \"{short}\" exists in: {}. Qualify it with its package (FQN): write extends: \"{}\".",
        candidates.join(", "),
        candidates[0]
    )
}

fn collect_supers(tree: &Tree, id: NodeId, out: &mut Vec<NodeId>) {
    if tree.node(id).super_ref.is_some() {
        out.push(id);
    }
    // ADR-0039: own — a whole-tree walk visits each physical node once; inherited children are visited where they are declared.
    for &c in tree.own_children(id) {
        collect_supers(tree, c, out);
    }
}

/// Resolve every `extends` in the merged tree, independently of load order (#188):
/// a dotted reference to an owner resolves the owner's own chain first.
fn resolve_supers(tree: &mut Tree, root: NodeId, top: &TopLevel, errors: &mut Vec<MetaError>) {
    let mut pending = Vec::new();
    collect_supers(tree, root, &mut pending);
    let mut r = SuperResolver {
        tree,
        root,
        index: &top.named,
        attempted: HashSet::new(),
        errors,
    };
    for id in pending {
        r.resolve(id);
    }
}

/// The root's top-level nodes by resolution key, first declaration winning, built
/// once per pass so each reference is one hash lookup.
struct TopLevel {
    named: HashMap<String, NodeId>,
    objects: HashMap<String, NodeId>,
}

impl TopLevel {
    fn build(tree: &Tree, root: NodeId) -> Self {
        let mut named = HashMap::new();
        let mut objects = HashMap::new();
        // ADR-0039: own — the root's top-level nodes are its declared children; a root extends nothing.
        for &c in tree.own_children(root) {
            let key = tree.resolution_key(c);
            if tree.node(c).type_name == TYPE_OBJECT {
                objects.entry(key.clone()).or_insert(c);
            }
            if !tree.node(c).name.is_empty() {
                named.entry(key).or_insert(c);
            }
        }
        Self { named, objects }
    }

    fn bind(map: &HashMap<String, NodeId>, owner: &str, pkg: &str) -> Option<NodeId> {
        owner_candidate_keys(owner, pkg)
            .ok()?
            .iter()
            .find_map(|k| map.get(k).copied())
    }
}

/// ADR-0059 R5: rewrite every resolved `extends` and reference attribute to its
/// canonical spelling, keeping the authored value beside it. A reference that does
/// not resolve is left as written.
fn resolve_references(tree: &mut Tree, root: NodeId, top: &TopLevel) {
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if id != root {
            resolve_extends(tree, top, id);
            let decl_pkg = tree.effective_package(tree.top_level_of(id));
            let names: Vec<String> = tree
                // ADR-0039: own — reference resolution rewrites the value this node declares, not an inherited one.
                .own_attrs(id)
                .filter(|(k, _)| REF_BEARING_ATTR_NAMES.contains(&k.as_str()))
                .map(|(k, _)| k.clone())
                .collect();
            for name in names {
                resolve_attr(tree, top, id, &name, &decl_pkg);
            }
        }
        // ADR-0039: own — a whole-tree walk visits each physical node once; inherited children are visited where they are declared.
        stack.extend(tree.own_children(id).iter().rev().copied());
    }
}

fn resolve_one(tree: &Tree, top: &TopLevel, value: &str, pkg: &str) -> Option<String> {
    let (owner, tail) = split_child_tail(value);
    let target = TopLevel::bind(&top.objects, owner, pkg)?;
    Some(spell_ref(tree, target, pkg, tail))
}

fn resolve_attr(tree: &mut Tree, top: &TopLevel, id: NodeId, name: &str, pkg: &str) {
    // ADR-0039: own — reference resolution rewrites the value this node declares, not an inherited one.
    let Some(attr) = tree.own_attr(id, name) else {
        return;
    };
    let new_value = match &attr.value {
        Value::String(s) if !s.is_empty() => resolve_one(tree, top, s, pkg).map(Value::String),
        Value::Array(items) if items.iter().all(Value::is_string) => {
            let mut any = false;
            let out: Vec<Value> = items
                .iter()
                .map(|v| {
                    let s = v.as_str().unwrap_or_default();
                    match (!s.is_empty())
                        .then(|| resolve_one(tree, top, s, pkg))
                        .flatten()
                    {
                        Some(c) => {
                            any = true;
                            Value::String(c)
                        }
                        None => v.clone(),
                    }
                })
                .collect();
            any.then_some(Value::Array(out))
        }
        _ => None,
    };
    let Some(new_value) = new_value else {
        return;
    };
    // ADR-0039: own — reference resolution rewrites the value this node declares, not an inherited one.
    if let Some(attr) = tree.own_attr_mut(id, name)
        && attr.value != new_value
    {
        if attr.authored_value.is_none() {
            attr.authored_value = Some(attr.value.clone());
        }
        attr.value = new_value;
    }
}

fn resolve_extends(tree: &mut Tree, top: &TopLevel, id: NodeId) {
    let node = tree.node(id);
    let (Some(r), Some(_)) = (node.super_ref.clone(), node.super_node) else {
        return;
    };
    let pkg = tree.effective_package(id);
    let (owner, tail) = split_child_tail(&r);
    let Some(owner_node) = TopLevel::bind(&top.named, owner, &pkg) else {
        return;
    };
    let canonical = spell_ref(tree, owner_node, &pkg, tail);
    if canonical == r {
        return;
    }
    let n = tree.node_mut(id);
    if n.authored_super_ref.is_none() {
        n.authored_super_ref = Some(r);
    }
    n.super_ref = Some(canonical);
}
