//! The loader: read files, parse each, merge the roots, resolve `extends` and
//! spell every reference canonically.
//!
//! Order of passes, as in every port: parse → merge → super resolution →
//! validation (its passes are registered as the validation features land) →
//! reference resolution.
//!
//! Built for speed from the start: each file is read once and parsed straight into
//! one arena, nothing is written to disk, and the passes walk the tree a fixed
//! number of times.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::errors::{
    ERR_BAD_ATTR_VALUE, ERR_EXTENDS_TARGET_MISMATCH, ERR_MALFORMED_JSON, ERR_MERGE_CONFLICT,
    ERR_OVERLAY_NO_TARGET, ERR_UNKNOWN, ERR_UNKNOWN_SUBTYPE, ERR_UNKNOWN_TYPE,
    ERR_UNRESOLVED_SUPER, MetaError, WARN_DUPLICATE_DECLARATION,
};
use crate::naming::{NamingCtx, NamingRegistry, PhysicalNaming};
use crate::node::{Node, NodeId, PACKAGE_SEP, Tree};
use crate::parser::{SUBTYPE_ROOT, TYPE_METADATA, TYPE_OBJECT, parse_document_with};
use crate::registry::TypeRegistry;
use crate::serializer::{normalize, to_canonical_value};

const TYPE_SOURCE: &str = "source";
const SOURCE_SUBTYPE_RDB: &str = "rdb";
use crate::source::ErrorSource;
use crate::timing::{
    LoadTimings, PHASE_FREEZE, PHASE_JSON, PHASE_MERGE, PHASE_READ, PHASE_REFS, PHASE_SUPERS,
    PHASE_TREE, PHASE_YAML,
};
use crate::validate::util::{ObjectIndex, find_hop};
use crate::validate::{self, Ctx, Findings};
use crate::yaml::parse_yaml;

/// The extensions a directory load picks up.
const JSON_SUFFIX: &str = "json";
const YAML_SUFFIXES: &[&str] = &["yaml", "yml"];
/// A directory of drafts that a directory load never descends into.
const PENDING_DIR: &str = "_pending";

const TYPE_IDENTITY: &str = "identity";
const IDENTITY_UNIQUE_KEY_SUBTYPES: &[&str] = &["primary", "secondary"];

/// Attributes whose value names another top-level object (ADR-0059 R4). An operation's
/// `@inputRef`, `@outputRef` and `@objectRef` are among them (ADR-0066). The set is keyed
/// by name, so [`is_ref_bearing_attr`] excludes a node type that reuses one of these
/// names for something else.
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
    "inputRef",
    "outputRef",
];

const TYPE_TRANSITION: &str = "transition";

/// `true` when `attr` on a node of type `type_name` holds an object reference: it is in
/// [`REF_BEARING_ATTR_NAMES`], and the node is not a `transition.*`, whose `@from` lists
/// members of its enum (ADR-0066).
pub fn is_ref_bearing_attr(type_name: &str, attr: &str) -> bool {
    REF_BEARING_ATTR_NAMES.contains(&attr) && type_name != TYPE_TRANSITION
}

/// One load: the tree, its root, and every error and warning.
#[derive(Debug)]
pub struct LoadResult {
    pub tree: Tree,
    pub root: NodeId,
    pub errors: Vec<MetaError>,
    pub warnings: Vec<MetaError>,
    /// How long each phase and each validation pass took.
    pub timings: LoadTimings,
}

/// Loads metadata against one registry.
pub struct Loader<'r> {
    registry: &'r TypeRegistry,
    strict: bool,
    naming_registry: NamingRegistry,
    naming: PhysicalNaming,
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
        Self {
            registry,
            strict: false,
            naming_registry: NamingRegistry::builtin(),
            naming: PhysicalNaming::default(),
        }
    }

    /// The project's physical naming (`naming` in `.metaobjects/config.json`) and the
    /// registry its strategy names resolve in; column-collision and `@via` reverse-hop
    /// validation resolve names through both. Defaults to the built-in registry and
    /// [`PhysicalNaming::default`]. A name the registry does not answer is one load
    /// error, and validation then runs under the defaults.
    #[must_use]
    pub fn naming(mut self, registry: NamingRegistry, naming: PhysicalNaming) -> Self {
        self.naming_registry = registry;
        self.naming = naming;
        self
    }

    /// Load strictly (ADR-0023): an authored attribute the registry does not declare
    /// is `ERR_UNKNOWN_ATTR`, and a child no child rule admits is `ERR_CHILD_NOT_ALLOWED`.
    /// Off by default, as in the TypeScript reference.
    #[must_use]
    pub fn strict(mut self, strict: bool) -> Self {
        self.strict = strict;
        self
    }

    /// Load every metadata file under `dir`. A directory that cannot be walked is
    /// an `Err`; a file that cannot be read is an error in the result, and the
    /// other files still load.
    pub fn load_dir(&self, dir: &Path) -> std::io::Result<LoadResult> {
        let mut timings = LoadTimings::default();
        let read_start = std::time::Instant::now();
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
        timings.add_phase(PHASE_READ, read_start.elapsed());
        let mut result = self.load_timed(&sources, timings);
        unreadable.append(&mut result.errors);
        result.errors = unreadable;
        Ok(result)
    }

    /// Load `(id, text)` pairs, each one JSON document named `id` in errors.
    pub fn load_sources(&self, sources: &[(String, String)]) -> LoadResult {
        self.load_timed(sources, LoadTimings::default())
    }

    fn load_timed(&self, sources: &[(String, String)], mut timings: LoadTimings) -> LoadResult {
        let mut tree = Tree::new();
        let mut errors = Vec::new();
        let mut roots = Vec::new();
        for (id, text) in sources {
            let envelope = if id.is_empty() {
                ErrorSource::Code
            } else {
                ErrorSource::json(id, "$")
            };
            let is_yaml = id
                .rsplit_once('.')
                .is_some_and(|(_, ext)| YAML_SUFFIXES.iter().any(|s| ext.eq_ignore_ascii_case(s)));
            let (doc, positions) = if is_yaml {
                match timings.phase(PHASE_YAML, || parse_yaml(text, self.registry, id)) {
                    Ok(d) => {
                        errors.extend(d.errors);
                        (d.canonical, Some(d.positions))
                    }
                    Err(e) => {
                        errors.push(e);
                        continue;
                    }
                }
            } else {
                match timings.phase(PHASE_JSON, || serde_json::from_str::<Value>(text)) {
                    Ok(v) => (v, None),
                    Err(e) => {
                        errors.push(MetaError::at(ERR_MALFORMED_JSON, e.to_string(), envelope));
                        continue;
                    }
                }
            };
            let parsed = timings.phase(PHASE_TREE, || {
                parse_document_with(&doc, self.registry, &mut tree, id, positions.as_ref())
            });
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
        let mut warnings = Vec::new();
        let mut merged = MergeOut::default();
        let naming_errors: Vec<MetaError> = [
            self.naming_registry
                .column_strategy(&self.naming.columns)
                .err(),
            self.naming
                .collections
                .as_deref()
                .and_then(|p| self.naming_registry.pluralizer(p).err()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let default_naming = (NamingRegistry::builtin(), PhysicalNaming::default());
        let (naming_registry, naming) = if naming_errors.is_empty() {
            (&self.naming_registry, &self.naming)
        } else {
            (&default_naming.0, &default_naming.1)
        };
        errors.extend(naming_errors);
        let root = if roots.is_empty() {
            tree.add(Node::new(TYPE_METADATA, SUBTYPE_ROOT, ""))
        } else {
            let root = timings.phase(PHASE_MERGE, || merge_roots(&mut tree, &roots, &mut merged));
            errors.append(&mut merged.errors);
            warnings.append(&mut merged.warnings);
            // Neither pass adds, removes or renames a top-level node, so one index serves both.
            let top = TopLevel::build(&tree, root);
            timings.phase(PHASE_SUPERS, || {
                resolve_supers(&mut tree, root, &top, &mut errors);
            });
            let mut findings = Findings::default();
            let ctx = Ctx {
                tree: &tree,
                root,
                registry: self.registry,
                strict: self.strict,
                objects: &top.objects,
                naming: NamingCtx::new(naming_registry, naming),
            };
            validate::run(&ctx, &mut findings, &mut timings);
            errors.append(&mut findings.errors);
            warnings.append(&mut findings.warnings);
            timings.phase(PHASE_REFS, || resolve_references(&mut tree, root, &top));
            root
        };
        // The terminal phase: the tree is complete, so it becomes read-only and its
        // resolving reads memoize from here on (the other ports freeze at REGISTERED).
        timings.phase(PHASE_FREEZE, || tree.freeze());
        LoadResult {
            tree,
            root,
            errors,
            warnings,
            timings,
        }
    }
}

/// What the merge stage reports.
#[derive(Debug, Default)]
struct MergeOut {
    errors: Vec<MetaError>,
    warnings: Vec<MetaError>,
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
fn merge_roots(tree: &mut Tree, roots: &[NodeId], out: &mut MergeOut) -> NodeId {
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
                defer_nested_overlays(tree, sc, out, Some(&mut pending));
                continue;
            }
            let key = (tree.node(sc).type_name.clone(), root_child_key(tree, sc));
            match index.get(&key) {
                Some(&tc) => {
                    merge_into(tree, tc, sc, out, Some(&mut pending));
                }
                None => {
                    index.insert(key, sc);
                    tree.add_child(target, sc);
                    defer_nested_overlays(tree, sc, out, Some(&mut pending));
                }
            }
        }
    }
    for (parent, node) in pending {
        apply_overlay(tree, parent, node, out);
    }
    target
}

fn merge_child_into(
    tree: &mut Tree,
    target: NodeId,
    sc: NodeId,
    out: &mut MergeOut,
    pending: Option<&mut Vec<(NodeId, NodeId)>>,
) -> bool {
    if tree.node(sc).is_overlay {
        return match pending {
            Some(p) => {
                p.push((target, sc));
                false
            }
            None => apply_overlay(tree, target, sc, out),
        };
    }
    match find_merge_match(tree, target, sc) {
        Some(tc) => merge_into(tree, tc, sc, out, pending),
        None => {
            tree.add_child(target, sc);
            defer_nested_overlays(tree, sc, out, pending);
            true
        }
    }
}

fn defer_nested_overlays(
    tree: &mut Tree,
    node: NodeId,
    out: &mut MergeOut,
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
                None => {
                    apply_overlay(tree, node, c, out);
                }
            }
        } else {
            defer_nested_overlays(tree, c, out, pending.as_deref_mut());
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

fn apply_overlay(tree: &mut Tree, parent: NodeId, node: NodeId, out: &mut MergeOut) -> bool {
    match find_merge_match(tree, parent, node) {
        Some(tc) => merge_into(tree, tc, node, out, None),
        None => {
            let n = tree.node(node);
            let p = tree.node(parent);
            let referrer = if p.parent.is_none() {
                root_child_key(tree, node)
            } else {
                format!("{}.{}", p.name, n.name)
            };
            let target = format!("{}:{}", n.type_name, n.name);
            out.errors.push(MetaError::at(
                ERR_OVERLAY_NO_TARGET,
                format!("overlay node '{}' has no merge target", n.fqn()),
                resolved_source(&n.source, referrer, target),
            ));
            false
        }
    }
}

fn merge_into(
    tree: &mut Tree,
    target: NodeId,
    src: NodeId,
    out: &mut MergeOut,
    mut pending: Option<&mut Vec<(NodeId, NodeId)>>,
) -> bool {
    // The root is a synthetic accumulator, not an authored node: no merge
    // attribution applies to it (this fold only reaches named nodes anyway).
    let tracked = !tree.node(target).name.is_empty();
    // Change is tracked as the merge goes (an attr value that differs once normalized as
    // the serializer does, or a child added or changed). The one shape the serializer
    // rewrites across attr names, a `source.rdb`, is still compared canonically.
    let canonical_check = tracked
        && tree.node(target).type_name == TYPE_SOURCE
        && tree.node(target).sub_type == SOURCE_SUBTYPE_RDB;
    let pre_shape = canonical_check.then(|| to_canonical_value(tree, target, false));
    let mut changed = false;
    let contributor = tree.node(src).source.files().first().cloned();
    if tracked && !tree.node(src).is_overlay {
        detect_attr_conflicts(tree, target, src, contributor.as_deref(), out);
    }
    let attrs: Vec<_> = tree
        // ADR-0039: own — the merge works on the authored layer, before super resolution.
        .own_attrs(src)
        .map(|(k, a)| (k.clone(), a.clone()))
        .collect();
    for (k, a) in attrs {
        changed |= tree
            .own_attr(target, &k)
            .is_none_or(|old| attr_value_differs(&old.value, &a.value));
        tree.set_attr(target, &k, a);
    }
    // ADR-0039: own — the merge works on the authored layer, before super resolution.
    for sc in tree.own_children(src).to_vec() {
        changed |= merge_child_into(tree, target, sc, out, pending.as_deref_mut());
    }
    if let Some(pre) = pre_shape {
        changed = to_canonical_value(tree, target, false) != pre;
    }
    let (true, Some(contributor)) = (tracked, contributor) else {
        return changed;
    };
    // A real overlay upgrades the node's source to `merged`; an identical
    // re-declaration from another file only warns (FR5c, ADR-0009).
    let existing = tree.node(target).source.clone();
    let mut files: Vec<String> = existing.files().to_vec();
    if !changed && (files.is_empty() || files.contains(&contributor)) {
        return changed;
    }
    if !files.contains(&contributor) {
        files.push(contributor);
    }
    files.sort();
    let merged = ErrorSource::Merged {
        files,
        json_path: existing.json_path().unwrap_or("$").to_string(),
    };
    if changed {
        tree.node_mut(target).source = merged;
    } else {
        out.warnings.push(MetaError::at(
            WARN_DUPLICATE_DECLARATION,
            format!(
                "duplicate declaration of {} with no semantic change",
                tree.node(target).fqn()
            ),
            merged,
        ));
    }
    changed
}

/// Whether two attr values serialize differently (the serializer normalizes numbers).
fn attr_value_differs(old: &Value, new: &Value) -> bool {
    old != new && normalize(old.clone()) != normalize(new.clone())
}

/// Attrs whose empty string is a value rather than "not set" (FR5c).
const EMPTY_STRING_IS_A_VALUE: &[&str] = &["flattenedColumnPrefix"];

fn is_empty_attr_value(v: &Value, name: &str) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.is_empty() && !EMPTY_STRING_IS_A_VALUE.contains(&name),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

/// FR5c: an attr `src` sets to a different non-empty value than `target` already
/// declares is a conflict; the merge itself still proceeds last-writer-wins.
fn detect_attr_conflicts(
    tree: &Tree,
    target: NodeId,
    src: NodeId,
    contributor: Option<&str>,
    out: &mut MergeOut,
) {
    let existing = &tree.node(target).source;
    let mut files: Vec<String> = existing.files().to_vec();
    // ADR-0039: own — merge machinery on the authored declaration layer.
    for (name, new) in tree.own_attrs(src) {
        let Some(old) = tree.own_attr(target, name) else {
            continue;
        };
        if is_empty_attr_value(&new.value, name)
            || is_empty_attr_value(&old.value, name)
            || new.value == old.value
        {
            continue;
        }
        if let Some(c) = contributor
            && !files.iter().any(|f| f == c)
        {
            files.push(c.to_string());
        }
        files.sort();
        let base = tree.node(src).source.json_path().unwrap_or("$");
        out.errors.push(MetaError::at(
            ERR_MERGE_CONFLICT,
            format!(
                "attr '@{name}' conflicts: existing value {} differs from new value {} on {}",
                old.value,
                new.value,
                tree.node(target).fqn()
            ),
            ErrorSource::Merged {
                files: files.clone(),
                json_path: format!("{base}.@{name}"),
            },
        ));
    }
}

/// A `resolved` envelope at `source`'s location.
pub(crate) fn resolved_source(
    source: &ErrorSource,
    referrer: String,
    target: String,
) -> ErrorSource {
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
    objects: ObjectIndex,
}

impl TopLevel {
    fn build(tree: &Tree, root: NodeId) -> Self {
        let mut named = HashMap::new();
        // ADR-0039: own — the root's top-level nodes are its declared children; a root extends nothing.
        for &c in tree.own_children(root) {
            let key = tree.resolution_key(c);
            if !tree.node(c).name.is_empty() {
                named.entry(key).or_insert(c);
            }
        }
        Self {
            named,
            objects: ObjectIndex::build(tree, root),
        }
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
            let type_name = tree.node(id).type_name.as_str();
            let names: Vec<String> = tree
                // ADR-0039: own — reference resolution rewrites the value this node declares, not an inherited one.
                .own_attrs(id)
                .filter(|(k, _)| is_ref_bearing_attr(type_name, k))
                .map(|(k, _)| k.clone())
                .collect();
            for name in names {
                let ref_pkg = referrer_package(tree, top, id, &name, &decl_pkg);
                resolve_attr(tree, top, id, &name, &ref_pkg, &decl_pkg);
            }
        }
        // ADR-0039: own — a whole-tree walk visits each physical node once; inherited children are visited where they are declared.
        stack.extend(tree.own_children(id).iter().rev().copied());
    }
}

fn resolve_one(
    tree: &Tree,
    top: &TopLevel,
    value: &str,
    pkg: &str,
    decl_pkg: &str,
) -> Option<String> {
    let (owner, tail) = split_child_tail(value);
    let target = top.objects.resolve(owner, pkg)?;
    // Root-level targets are spelled `::Name` unless both packages are root-level.
    let spell_from = if pkg.is_empty() { decl_pkg } else { pkg };
    Some(spell_ref(tree, target, spell_from, tail))
}

/// ADR-0059 R3: the package an own reference attribute of `id` resolves in. A
/// dimension's `@of` resolves in the package of the entity its `@via` walk reaches;
/// a report's `@spine` in the package of its `@from`; everything else in the package
/// of the top-level node that declares it.
fn referrer_package(tree: &Tree, top: &TopLevel, id: NodeId, attr: &str, decl_pkg: &str) -> String {
    let node = tree.node(id);
    if node.type_name == "dimension" && attr == "of" {
        // ADR-0039: resolving: the @via that governs this @of may be inherited.
        if let (Some(Value::String(via)), Some(declaring)) = (tree.attr(id, "via"), node.parent)
            && !via.is_empty()
        {
            return match dimension_via_terminal(tree, top, declaring, via) {
                Some(t) => tree.effective_package(t),
                None => decl_pkg.to_string(),
            };
        }
    }
    if node.type_name == TYPE_OBJECT && node.sub_type == "report" && attr == "spine" {
        // ADR-0039: resolving: @from may be inherited.
        if let Some(Value::String(from)) = tree.attr(id, "from")
            && !from.is_empty()
            && let Some(from_node) = top.objects.resolve(from, decl_pkg)
        {
            return tree.effective_package(from_node);
        }
    }
    decl_pkg.to_string()
}

/// The entity a dimension's `@via` (`Owner.hop[.hop...]`) reaches, walked from its
/// declaring entity over to-one hops (`relationship` or `identity.reference`), or `None`
/// when the walk fails (the reporting pass reports why).
fn dimension_via_terminal(
    tree: &Tree,
    top: &TopLevel,
    declaring: NodeId,
    via: &str,
) -> Option<NodeId> {
    let mut parts = via.split(CHILD_REF_SEP);
    parts.next().filter(|o| !o.is_empty())?;
    let mut current = declaring;
    let mut any = false;
    for hop_name in parts {
        any = true;
        let (hop, is_ref) = find_hop(tree, current, hop_name)?;
        current = top.objects.hop_target(tree, hop, is_ref)?;
    }
    any.then_some(current)
}

fn resolve_attr(
    tree: &mut Tree,
    top: &TopLevel,
    id: NodeId,
    name: &str,
    pkg: &str,
    decl_pkg: &str,
) {
    // ADR-0039: own — reference resolution rewrites the value this node declares, not an inherited one.
    let Some(attr) = tree.own_attr(id, name) else {
        return;
    };
    let new_value = match &attr.value {
        Value::String(s) if !s.is_empty() => {
            resolve_one(tree, top, s, pkg, decl_pkg).map(Value::String)
        }
        Value::Array(items) if items.iter().all(Value::is_string) => {
            let mut any = false;
            let out: Vec<Value> = items
                .iter()
                .map(|v| {
                    let s = v.as_str().unwrap_or_default();
                    match (!s.is_empty())
                        .then(|| resolve_one(tree, top, s, pkg, decl_pkg))
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
