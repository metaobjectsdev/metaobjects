//! Origin and projection validation: ports of `validateOriginPaths`,
//! `validateDerivedFieldProvidability`, `validateOriginSegmentsAndCorrelation`,
//! `validateDerivedCycles`, `validateProjectionFilter` and
//! `validateProjectionUnionAndGrain` (`loader/validation-passes.ts`).
//!
//! ADR-0039: resolving accessors by default; `own_*` only where the comment names the
//! sanctioned case (origin.* never inherits, ADR-0029, so an origin is always its own).

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::errors::{MetaError, WARN_LEGACY};
use crate::loader::split_child_tail;
use crate::naming::{NamingCtx, collection_name_of};
use crate::node::{NodeId, Tree};
use crate::source::ErrorSource;
use crate::validate::field_expr::{
    CAST_TARGETS, FieldView, expression_nodes, infer_with, literal_comparison_problem,
    validate_expr,
};
use crate::validate::util::{ObjectIndex, ops_for_field};
use crate::validate::{Ctx, Findings};

pub const ERR_INVALID_ORIGIN: &str = "ERR_INVALID_ORIGIN";
pub const ERR_SUBTYPE_RULE_VIOLATION: &str = "ERR_SUBTYPE_RULE_VIOLATION";
pub const ERR_EXTENDS_ORIGIN_MISMATCH: &str = "ERR_EXTENDS_ORIGIN_MISMATCH";
pub const ERR_PASSTHROUGH_TYPE_MISMATCH: &str = "ERR_PASSTHROUGH_TYPE_MISMATCH";
pub const ERR_AMBIGUOUS_PATH: &str = "ERR_AMBIGUOUS_PATH";
pub const ERR_ORIGIN_CARDINALITY: &str = "ERR_ORIGIN_CARDINALITY";
pub const ERR_COLLECT_MEMBER_UNRESOLVED: &str = "ERR_COLLECT_MEMBER_UNRESOLVED";
pub const ERR_COLLECT_WHOLE_OBJECT: &str = "ERR_COLLECT_WHOLE_OBJECT";
pub const ERR_UNKNOWN_EXPR_NODE: &str = "ERR_UNKNOWN_EXPR_NODE";
pub const ERR_COMPUTED_TYPE_MISMATCH: &str = "ERR_COMPUTED_TYPE_MISMATCH";
pub const ERR_DERIVED_FIELD_NO_READ_SOURCE: &str = "ERR_DERIVED_FIELD_NO_READ_SOURCE";
pub const ERR_BAD_ATTR_FILTER: &str = "ERR_BAD_ATTR_FILTER";
pub const ERR_BAD_ATTR_VALUE: &str = "ERR_BAD_ATTR_VALUE";

const T_OBJECT: &str = "object";
const T_FIELD: &str = "field";
const T_ORIGIN: &str = "origin";
const T_IDENTITY: &str = "identity";
const T_RELATIONSHIP: &str = "relationship";
const T_SOURCE: &str = "source";
const T_SEGMENT: &str = "segment";
const SUB_ENTITY: &str = "entity";
const SUB_VALUE: &str = "value";
const SUB_PROJECTION: &str = "projection";
const O_PASSTHROUGH: &str = "passthrough";
const O_AGGREGATE: &str = "aggregate";
const O_COMPUTED: &str = "computed";
const O_FIRST: &str = "first";
const O_FUNCTION: &str = "function";
const ASSEMBLY: &[&str] = &[O_AGGREGATE, O_COMPUTED, O_FIRST, O_FUNCTION];
const ID_REFERENCE: &str = "reference";
const ID_PRIMARY: &str = "primary";
const ID_SECONDARY: &str = "secondary";
const AGG_ANY: &str = "any";
const AGG_ALL: &str = "all";
const AGG_COLLECT: &str = "collect";
const COLUMN_AGGS: &[&str] = &["sum", "avg", "min", "max"];
const SORT_ORDER: &[&str] = &["asc", "desc"];
const CORRELATED_OPS: &[&str] = &[
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "isDistinctFrom",
    "isNotDistinctFrom",
];
const NULL_SAFE_OPS: &[&str] = &["isDistinctFrom", "isNotDistinctFrom"];
const READ_ONLY_KINDS: &[&str] = &["view", "materializedView", "storedProc", "tableFunction"];
const FILTER_AND: &str = "and";
const FILTER_OR: &str = "or";

// ---------------------------------------------------------------------------
// The model view every pass here shares.
// ---------------------------------------------------------------------------

/// Root-level objects by resolution key (ADR-0042 / ADR-0059).
struct M<'a> {
    tree: &'a Tree,
    index: &'a ObjectIndex,
    naming: NamingCtx<'a>,
}

type Errs = Vec<MetaError>;

fn push(errs: &mut Errs, code: &'static str, msg: String, src: &ErrorSource) {
    errs.push(MetaError::at(code, msg, src.clone()));
}

/// `resolvedSource(src, referrer, target)`.
fn resolved_src(src: &ErrorSource, referrer: String, target: &str) -> ErrorSource {
    ErrorSource::Resolved {
        files: src.files().to_vec(),
        json_path: src.json_path().unwrap_or("$").to_string(),
        referrer,
        target: target.to_string(),
    }
}

impl<'a> M<'a> {
    fn new(ctx: &Ctx<'a>) -> Self {
        M {
            tree: ctx.tree,
            index: ctx.objects,
            naming: ctx.naming,
        }
    }

    fn pkg(&self, id: NodeId) -> &'a str {
        let n = self.tree.node(id);
        n.package
            .as_deref()
            .or(n.file_default_package.as_deref())
            .unwrap_or("")
    }

    fn find_object(&self, name: &str, pkg: &str) -> Option<NodeId> {
        self.index.resolve(name, pkg)
    }

    fn is(&self, id: NodeId, ty: &str, sub: &str) -> bool {
        let n = self.tree.node(id);
        n.type_name == ty && n.sub_type == sub
    }

    fn kids(&self, id: NodeId) -> Cow<'a, [NodeId]> {
        self.tree.children(id)
    }

    fn find_child(&self, obj: NodeId, ty: &str, name: &str) -> Option<NodeId> {
        self.kids(obj).iter().copied().find(|&c| {
            let n = self.tree.node(c);
            n.type_name == ty && n.name == name
        })
    }

    fn find_field(&self, obj: NodeId, name: &str) -> Option<NodeId> {
        self.find_child(obj, T_FIELD, name)
    }

    fn fields(&self, obj: NodeId) -> Vec<NodeId> {
        self.kids(obj)
            .iter()
            .copied()
            .filter(|&c| self.tree.node(c).type_name == T_FIELD)
            .collect()
    }

    fn own_fields(&self, obj: NodeId) -> Vec<NodeId> {
        // ADR-0039: own: origin validation runs on the own-declared field + origin layer
        // (origin.* never inherits, ADR-0029).
        self.tree
            .own_children(obj)
            .iter()
            .copied()
            .filter(|&c| self.tree.node(c).type_name == T_FIELD)
            .collect()
    }

    /// The origin child a field carries, as `ownChildren().find(type == origin)`.
    fn origin_of(&self, field: NodeId) -> Option<NodeId> {
        // ADR-0039: own: origin.* never inherits (ADR-0029).
        self.tree
            .own_children(field)
            .iter()
            .copied()
            .find(|&c| self.tree.node(c).type_name == T_ORIGIN)
    }

    fn origins_of(&self, field: NodeId) -> Vec<NodeId> {
        // ADR-0039: own: origin.* never inherits (ADR-0029).
        self.tree
            .own_children(field)
            .iter()
            .copied()
            .filter(|&c| self.tree.node(c).type_name == T_ORIGIN)
            .collect()
    }

    /// Resolving string attr; `None` when absent or not a string.
    fn attr_str(&self, id: NodeId, name: &str) -> Option<&'a str> {
        self.tree.attr(id, name).and_then(Value::as_str)
    }

    /// Own attr value (origin.* and projection layer attrs never inherit).
    fn own(&self, id: NodeId, name: &str) -> Option<&'a Value> {
        // ADR-0039: own: the attr is read on the layer that declares it (ADR-0029).
        self.tree.own_attr(id, name).map(|a| &a.value)
    }

    fn own_nonempty(&self, id: NodeId, name: &str) -> Option<&'a str> {
        self.own(id, name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    }

    /// `refTarget(node, attr)`: the declaring layer's value, resolved in that layer's package.
    fn ref_target(&self, node: NodeId, attr: &str) -> Option<NodeId> {
        self.index.ref_target(self.tree, node, attr)
    }

    fn type_label(&self, field: NodeId) -> String {
        format!(
            "field.{}{}",
            self.tree.node(field).sub_type,
            if self.tree.resolved_is_array(field) {
                "[]"
            } else {
                ""
            }
        )
    }

    fn super_chain_contains(&self, start: NodeId, target: NodeId) -> bool {
        let mut cur = Some(start);
        let mut n = 0;
        while let Some(c) = cur {
            if c == target {
                return true;
            }
            n += 1;
            if n > self.tree.len() {
                return false;
            }
            cur = self.tree.node(c).super_node;
        }
        false
    }

    fn collection_hop_name(&self, holder: NodeId) -> Option<String> {
        let plural = collection_name_of(self.tree, holder, &self.naming).ok()?;
        let mut c = plural.chars();
        Some(match c.next() {
            Some(f) => f.to_lowercase().chain(c).collect(),
            None => plural,
        })
    }

    /// Every identity.reference onto `target` from a concrete object whose reverse hop is `hop`.
    fn reverse_hops(&self, target: NodeId, hop: &str) -> Vec<(NodeId, NodeId)> {
        let mut found = Vec::new();
        for &holder in self.index.objects() {
            if self.tree.node(holder).is_abstract
                || self.collection_hop_name(holder).as_deref() != Some(hop)
            {
                continue;
            }
            for &r in self.kids(holder).iter() {
                if self.is(r, T_IDENTITY, ID_REFERENCE)
                    && self.ref_target(r, "references") == Some(target)
                {
                    found.push((holder, r));
                }
            }
        }
        found
    }

    fn find_reference(&self, obj: NodeId, name: &str) -> Option<NodeId> {
        self.kids(obj)
            .iter()
            .copied()
            .find(|&c| self.is(c, T_IDENTITY, ID_REFERENCE) && self.tree.node(c).name == name)
    }
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

struct FromTarget {
    entity: NodeId,
    field: NodeId,
}

/// `resolveFlattenedMember(entity, "head.tail")`.
fn flattened_member(m: &M<'_>, entity: NodeId, path: &str) -> Option<NodeId> {
    let dot = path.find('.')?;
    if dot < 1 || dot == path.len() - 1 || path[dot + 1..].contains('.') {
        return None;
    }
    let embedding = m.find_field(entity, &path[..dot])?;
    if m.tree.node(embedding).sub_type != "object"
        || m.tree.attr(embedding, "storage").and_then(Value::as_str) != Some("flattened")
    {
        return None;
    }
    let vo = m.ref_target(embedding, "objectRef")?;
    m.find_field(vo, &path[dot + 1..])
}

fn validate_from_path(
    m: &M<'_>,
    from: &str,
    host: NodeId,
    field_name: &str,
    src: &ErrorSource,
    errs: &mut Errs,
    label: &str,
) -> Option<FromTarget> {
    let h = m.tree.node(host);
    let referrer = format!("{}::{field_name}", h.fqn());
    let pkg = m.pkg(host);
    let rs = || resolved_src(src, referrer.clone(), from);
    let dot = from.find('.');
    let Some(dot) = dot.filter(|&d| d >= 1 && d != from.len() - 1) else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "{label} \"{from}\" on {}.{field_name}: must be of form \"Entity.field\".",
                h.name
            ),
            &rs(),
        );
        return None;
    };
    let (entity_name, field_part) = (&from[..dot], &from[dot + 1..]);
    let Some(entity) = m.find_object(entity_name, pkg) else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "{label} \"{from}\" on {}.{field_name}: no such entity \"{entity_name}\".",
                h.name
            ),
            &rs(),
        );
        return None;
    };
    let Some(field) = m
        .find_field(entity, field_part)
        .or_else(|| flattened_member(m, entity, field_part))
    else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "{label} \"{from}\" on {}.{field_name}: no such field \"{field_part}\" on {entity_name}.",
                h.name
            ),
            &rs(),
        );
        return None;
    };
    Some(FromTarget { entity, field })
}

struct Walked {
    hops: Vec<NodeId>,
    terminal: NodeId,
    /// Hops walked backwards, keyed to the hop name the path wrote.
    reverse: Vec<(NodeId, String)>,
}

impl Walked {
    fn is_reverse(&self, hop: NodeId) -> Option<&str> {
        self.reverse
            .iter()
            .find(|(h, _)| *h == hop)
            .map(|(_, n)| n.as_str())
    }
}

fn validate_via_path(
    m: &M<'_>,
    via: &str,
    host: NodeId,
    field_name: &str,
    src: &ErrorSource,
    errs: &mut Errs,
) -> Option<Walked> {
    let tree = m.tree;
    let h = tree.node(host);
    let referrer = format!("{}::{field_name}", h.fqn());
    let rs = |t: &str| resolved_src(src, referrer.clone(), t);
    let at = format!("origin.@via \"{via}\" on {}.{field_name}", h.name);
    let segments: Vec<&str> = via.split('.').collect();
    if segments.len() < 2 {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!("{at}: must be of form \"Entity.relationship[.relationship...]\"."),
            &rs(via),
        );
        return None;
    }
    let Some(mut cur) = m.find_object(segments[0], m.pkg(host)) else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!("{at}: no such entity \"{}\".", segments[0]),
            &rs(via),
        );
        return None;
    };
    let mut valid = vec![segments[0].to_string()];
    let mut hops = Vec::new();
    let mut reverse = Vec::new();
    for rel_name in &segments[1..] {
        let rel = m
            .find_child(cur, T_RELATIONSHIP, rel_name)
            .or_else(|| m.find_reference(cur, rel_name));
        let Some(rel) = rel else {
            let reversed = m.reverse_hops(cur, rel_name);
            if reversed.len() == 1 {
                valid.push(rel_name.to_string());
                hops.push(reversed[0].1);
                reverse.push((reversed[0].1, rel_name.to_string()));
                cur = reversed[0].0;
                continue;
            }
            if reversed.len() > 1 {
                push(
                    errs,
                    ERR_AMBIGUOUS_PATH,
                    format!(
                        "{at}: the reverse hop \"{rel_name}\" from {} matches {} identity.reference nodes onto it — ambiguous.",
                        tree.node(cur).name,
                        reversed.len()
                    ),
                    &rs(via),
                );
                return None;
            }
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!(
                    "{at}: no such relationship or reference \"{rel_name}\" on {}. Deepest valid prefix was \"{}\".",
                    tree.node(cur).name,
                    valid.join(".")
                ),
                &rs(via),
            );
            return None;
        };
        let is_ref = m.is(rel, T_IDENTITY, ID_REFERENCE);
        let target = m
            .attr_str(rel, if is_ref { "references" } else { "objectRef" })
            .filter(|s| !s.is_empty());
        let kind = if is_ref { "reference" } else { "relationship" };
        let Some(target) = target else {
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!(
                    "{at}: {kind} \"{rel_name}\" on {} is missing @{}.",
                    tree.node(cur).name,
                    if is_ref { "references" } else { "objectRef" }
                ),
                &rs(via),
            );
            return None;
        };
        let Some(next) = m.find_object(target, m.pkg(cur)) else {
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!("{at}: {kind} \"{rel_name}\" points to non-existent entity \"{target}\"."),
                &rs(target),
            );
            return None;
        };
        valid.push(rel_name.to_string());
        hops.push(rel);
        cur = next;
    }
    Some(Walked {
        hops,
        terminal: cur,
        reverse,
    })
}

fn hop_cardinality<'a>(
    m: &'a M<'_>,
    rel: NodeId,
    walked: Option<&Walked>,
    unique_reverse_is_one: bool,
) -> Option<&'a str> {
    if walked.is_some_and(|w| w.is_reverse(rel).is_some()) {
        return Some(if unique_reverse_is_one && reverse_hop_is_unique(m, rel) {
            "one"
        } else {
            "many"
        });
    }
    if m.is(rel, T_IDENTITY, ID_REFERENCE) {
        return Some("one");
    }
    m.attr_str(rel, "cardinality")
}

fn identity_field_set(m: &M<'_>, node: NodeId) -> String {
    let mut list: Vec<String> = match m.tree.attr(node, "fields") {
        Some(Value::Array(a)) => a.iter().map(crate::json::js_display).collect(),
        Some(Value::String(s)) => s.split(',').map(str::to_string).collect(),
        _ => Vec::new(),
    };
    list = list
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    list.sort();
    list.join(",")
}

fn reverse_hop_is_unique(m: &M<'_>, rel: NodeId) -> bool {
    let Some(holder) = m.tree.node(rel).parent else {
        return false;
    };
    let fields = identity_field_set(m, rel);
    if fields.is_empty() {
        return false;
    }
    m.kids(holder).iter().any(|&c| {
        let n = m.tree.node(c);
        n.type_name == T_IDENTITY
            && (n.sub_type == ID_PRIMARY || n.sub_type == ID_SECONDARY)
            && m.tree.attr(c, "where").is_none()
            && m.tree.attr(c, "expr").is_none()
            && identity_field_set(m, c) == fields
    })
}

/// `_refNamedOwner`: the entity NAMED in a node's dotted extends ref.
fn ref_named_owner(m: &M<'_>, node: NodeId, pkg: &str) -> Option<NodeId> {
    let r = m.tree.node(node).super_ref.as_deref()?;
    let (owner, tail) = split_child_tail(r);
    if tail.is_empty() || owner.is_empty() {
        return None;
    }
    m.find_object(owner, pkg)
}

fn anchors_by_identity(m: &M<'_>, obj: NodeId, depth: usize) -> bool {
    if depth > m.tree.len() {
        return false;
    }
    // ADR-0039: own: an anchor is a locally declared extends-bound identity at some level.
    if m.tree.own_children(obj).iter().any(|&c| {
        m.tree.node(c).type_name == T_IDENTITY
            && m.tree
                .node(c)
                .super_node
                .is_some_and(|s| m.tree.node(s).type_name == T_IDENTITY)
    }) {
        return true;
    }
    match m.tree.node(obj).super_node {
        Some(s) if m.is(s, T_OBJECT, SUB_PROJECTION) => anchors_by_identity(m, s, depth + 1),
        _ => false,
    }
}

fn derive_base(
    m: &M<'_>,
    obj: NodeId,
    field_name: &str,
    src: &ErrorSource,
    errs: &mut Errs,
) -> Option<NodeId> {
    derive_base_d(m, obj, field_name, src, errs, 0)
}

fn derive_base_d(
    m: &M<'_>,
    obj: NodeId,
    field_name: &str,
    src: &ErrorSource,
    errs: &mut Errs,
    depth: usize,
) -> Option<NodeId> {
    let tree = m.tree;
    let o = tree.node(obj);
    if o.sub_type != SUB_PROJECTION {
        return Some(obj);
    }
    if depth > tree.len() {
        return None;
    }
    let pkg = m.pkg(obj);
    // ADR-0039: own: this projection's OWN declared identities carry the extends refs.
    let own_ids: Vec<NodeId> = tree
        .own_children(obj)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == T_IDENTITY)
        .collect();
    for &id in &own_ids {
        if let Some(ext) = tree.node(id).super_node
            && tree.node(ext).type_name == T_IDENTITY
        {
            if let Some(named) = ref_named_owner(m, id, pkg) {
                return Some(named);
            }
            if let Some(owner) = tree.node(ext).parent
                && tree.node(owner).type_name == T_OBJECT
            {
                return Some(owner);
            }
        }
    }
    let sup_proj = o
        .super_node
        .filter(|&s| tree.node(s).type_name == T_OBJECT && tree.node(s).sub_type == SUB_PROJECTION);
    if own_ids.is_empty()
        && let Some(sp) = sup_proj
        && anchors_by_identity(m, sp, 0)
    {
        return derive_base_d(m, sp, field_name, src, errs, depth + 1);
    }
    let mut targets: Vec<NodeId> = Vec::new();
    for f in m.own_fields(obj) {
        let Some(sup) = tree.node(f).super_node else {
            continue;
        };
        let owner = ref_named_owner(m, f, pkg).or(tree.node(sup).parent);
        if let Some(owner) = owner
            && tree.node(owner).type_name == T_OBJECT
            && tree.node(owner).sub_type != SUB_VALUE
            && owner != obj
            && !targets.contains(&owner)
        {
            targets.push(owner);
        }
    }
    if targets.len() == 1 {
        return Some(targets[0]);
    }
    if targets.is_empty()
        && let Some(sp) = sup_proj
    {
        return derive_base_d(m, sp, field_name, src, errs, depth + 1);
    }
    if targets.len() > 1 {
        let names: Vec<String> = targets
            .iter()
            .map(|&t| format!("\"{}\"", tree.node(t).name))
            .collect();
        push(
            errs,
            ERR_AMBIGUOUS_PATH,
            format!(
                "origin on {}.{field_name}: cannot derive the base entity — the projection's fields extend multiple entities ({}) and no identity extends an entity identity.",
                o.name,
                names.join(", ")
            ),
            src,
        );
    } else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "origin on {}.{field_name}: cannot derive the base entity for @via inference — the projection has no extended identity and no entity-targeted field extends.",
                o.name
            ),
            src,
        );
    }
    None
}

fn is_base_relation_target(m: &M<'_>, target: NodeId, base: NodeId, host: NodeId) -> bool {
    m.super_chain_contains(base, target) || m.super_chain_contains(host, target)
}

#[allow(clippy::too_many_arguments)]
fn infer_via_single_hop(
    m: &M<'_>,
    base: NodeId,
    target: NodeId,
    host: NodeId,
    field_name: &str,
    from: &str,
    label: &str,
    src: &ErrorSource,
    errs: &mut Errs,
) -> Option<Vec<NodeId>> {
    let tree = m.tree;
    let candidates: Vec<NodeId> = m
        .kids(base)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == T_RELATIONSHIP)
        .filter(|&r| m.ref_target(r, "objectRef") == Some(target))
        .collect();
    let referrer = format!("{}::{field_name}", tree.node(host).fqn());
    if candidates.len() == 1 {
        return Some(candidates);
    }
    let (code, msg) = if candidates.is_empty() {
        (
            ERR_INVALID_ORIGIN,
            format!(
                "{label} \"{from}\" on {}.{field_name}: no @via and no single-hop relationship from base entity \"{}\" to \"{}\" — cannot infer the path.",
                tree.node(host).name,
                tree.node(base).name,
                tree.node(target).name
            ),
        )
    } else {
        (
            ERR_AMBIGUOUS_PATH,
            format!(
                "{label} \"{from}\" on {}.{field_name}: no @via and {} relationships from base entity \"{}\" to \"{}\" — ambiguous.",
                tree.node(host).name,
                candidates.len(),
                tree.node(base).name,
                tree.node(target).name
            ),
        )
    };
    push(errs, code, msg, &resolved_src(src, referrer, from));
    None
}

fn check_passthrough_cardinality(
    m: &M<'_>,
    hops: &[NodeId],
    host: NodeId,
    field_name: &str,
    src: &ErrorSource,
    errs: &mut Errs,
    walked: Option<&Walked>,
) {
    for &rel in hops {
        if hop_cardinality(m, rel, walked, true) == Some("many") {
            let n = &m.tree.node(rel).name;
            push(
                errs,
                ERR_ORIGIN_CARDINALITY,
                format!(
                    "origin.passthrough on {}.{field_name}: @via hop \"{}\" is to-many {} — a row-multiplying passthrough — you meant aggregate (ADR-0029).",
                    m.tree.node(host).name,
                    walked.and_then(|w| w.is_reverse(rel)).unwrap_or(n),
                    if walked.is_some_and(|w| w.is_reverse(rel).is_some()) {
                        format!("(reverse hop over identity.reference \"{n}\")")
                    } else {
                        "(@cardinality \"many\")".to_string()
                    }
                ),
                src,
            );
            return;
        }
    }
}

fn check_aggregate_cardinality(
    m: &M<'_>,
    hops: &[NodeId],
    host: NodeId,
    field_name: &str,
    src: &ErrorSource,
    errs: &mut Errs,
    walked: Option<&Walked>,
) {
    if hops.is_empty() {
        return;
    }
    if hops
        .iter()
        .all(|&r| hop_cardinality(m, r, walked, false) == Some("one"))
    {
        push(
            errs,
            ERR_ORIGIN_CARDINALITY,
            format!(
                "origin.aggregate on {}.{field_name}: every @via hop is to-one — aggregating over a to-one path — you meant passthrough (ADR-0029).",
                m.tree.node(host).name
            ),
            src,
        );
    }
}

/// `resolveFilterPath`: `None` without a dot, `Err(why)` on a bad hop or field.
struct FilterPath {
    field: NodeId,
}

fn resolve_filter_path(m: &M<'_>, base: NodeId, key: &str) -> Option<Result<FilterPath, String>> {
    let segs: Vec<&str> = key.split('.').collect();
    if segs.len() < 2 {
        return None;
    }
    let (hops, field_name) = (&segs[..segs.len() - 1], segs[segs.len() - 1]);
    let mut cur = base;
    for hop in hops {
        let cn = &m.tree.node(cur).name;
        let next = if let Some(r) = m.find_reference(cur, hop) {
            match m
                .ref_target(r, "references")
                .filter(|&t| m.tree.node(t).type_name == T_OBJECT)
            {
                Some(t) => t,
                None => return Some(Err(format!("reference \"{cn}.{hop}\" does not resolve"))),
            }
        } else if let Some(rel) = m.find_child(cur, T_RELATIONSHIP, hop) {
            if m.attr_str(rel, "cardinality") != Some("one") {
                return Some(Err(format!(
                    "\"{cn}.{hop}\" is to-many; a filter path may only walk to-one hops"
                )));
            }
            match m
                .ref_target(rel, "objectRef")
                .filter(|&t| m.tree.node(t).type_name == T_OBJECT)
            {
                Some(t) => t,
                None => {
                    return Some(Err(format!("relationship \"{cn}.{hop}\" does not resolve")));
                }
            }
        } else {
            return Some(Err(format!(
                "\"{cn}\" declares no identity.reference or to-one relationship named \"{hop}\""
            )));
        };
        cur = next;
    }
    match m.find_field(cur, field_name) {
        Some(field) => Some(Ok(FilterPath { field })),
        None => Some(Err(format!(
            "\"{}\" declares no field \"{field_name}\"",
            m.tree.node(cur).name
        ))),
    }
}

/// A grain projection's element value object (rc.21 part B, U14).
fn grain_value_object(m: &M<'_>, obj: NodeId) -> Option<NodeId> {
    if m.tree.node(obj).sub_type != SUB_PROJECTION {
        return None;
    }
    let grain = m.attr_str(obj, "grain")?;
    let base = derive_base(m, obj, "@grain", &m.tree.node(obj).source, &mut Vec::new())?;
    let field = m.find_field(base, grain)?;
    m.ref_target(field, "objectRef")
}

#[allow(clippy::too_many_arguments)]
fn order_by_keys(
    m: &M<'_>,
    order_by: Option<&Value>,
    related: Option<NodeId>,
    host: NodeId,
    field_name: &str,
    label: &str,
    src: &ErrorSource,
    errs: &mut Errs,
    code: &'static str,
) {
    let (Some(Value::Array(list)), Some(related)) = (order_by, related) else {
        return;
    };
    for raw in list {
        let Some(raw) = raw.as_str() else { continue };
        let (key, dir) = match raw.find(':') {
            Some(i) => (&raw[..i], Some(&raw[i + 1..])),
            None => (raw, None),
        };
        let at = format!("{label} on {}.{field_name}", m.tree.node(host).name);
        if m.find_field(related, key).is_none() {
            push(
                errs,
                code,
                format!(
                    "{at}: @orderBy key \"{raw}\" — no such field \"{key}\" on {}.",
                    m.tree.node(related).name
                ),
                src,
            );
        } else if let Some(d) = dir
            && !SORT_ORDER.contains(&d)
        {
            push(
                errs,
                code,
                format!("{at}: @orderBy key \"{raw}\" — direction must be one of asc|desc."),
                src,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// validateOriginPaths
// ---------------------------------------------------------------------------

pub fn validate_origin_paths(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let mut errs = Vec::new();
    for &obj in m.index.objects() {
        let is_value_host = m.tree.node(obj).sub_type == SUB_VALUE;
        for field in m.own_fields(obj) {
            for origin in m.origins_of(field) {
                origin_one(&m, obj, field, origin, is_value_host, &mut errs);
            }
        }
    }
    out.errors.extend(errs);
}

fn origin_one(
    m: &M<'_>,
    obj: NodeId,
    field: NodeId,
    origin: NodeId,
    is_value_host: bool,
    errs: &mut Errs,
) {
    let tree = m.tree;
    let o = tree.node(origin);
    let on = &tree.node(obj).name;
    let fname = tree.node(field).name.as_str();
    let src = &o.source;
    if is_value_host && ASSEMBLY.contains(&o.sub_type.as_str()) {
        push(
            errs,
            ERR_SUBTYPE_RULE_VIOLATION,
            format!(
                "value object '{}' field '{fname}' hosts origin.{} — assembly origins live on object.projection (#210, ADR-0028)",
                tree.node(obj).fqn(),
                o.sub_type
            ),
            src,
        );
        return;
    }
    match o.sub_type.as_str() {
        O_PASSTHROUGH => passthrough(m, obj, field, origin, is_value_host, errs),
        O_AGGREGATE => aggregate(m, obj, field, origin, errs),
        O_COMPUTED => computed(m, obj, field, origin, errs),
        O_FIRST => first(m, obj, field, origin, errs),
        O_FUNCTION => function_origin(m, obj, field, origin, errs),
        _ => {}
    }
    let _ = on;
}

fn passthrough(
    m: &M<'_>,
    obj: NodeId,
    field: NodeId,
    origin: NodeId,
    is_value_host: bool,
    errs: &mut Errs,
) {
    let tree = m.tree;
    let on = &tree.node(obj).name;
    let fname = tree.node(field).name.as_str();
    let src = &tree.node(origin).source;
    let Some(from) = m.own_nonempty(origin, "from") else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!("origin.passthrough on {on}.{fname}: missing @from."),
            src,
        );
        return;
    };
    let target = validate_from_path(m, from, obj, fname, src, errs, "origin.passthrough.@from");
    let convert = m.own(origin, "convert") == Some(&Value::Bool(true));
    if let Some(t) = &target
        && Some(t.entity) == grain_value_object(m, obj)
    {
        check_passthrough_type(m, field, t.field, from, convert, obj, src, errs);
        let tf = tree.node(t.field);
        if tree.resolved_is_array(t.field) || tf.sub_type == "object" || tf.sub_type == "map" {
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!(
                    "origin.passthrough on {on}.{fname}: @from \"{from}\" is not a scalar member of the @grain element."
                ),
                src,
            );
        }
        if m.own(origin, "via").is_some() {
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!(
                    "origin.passthrough on {on}.{fname}: @from \"{from}\" reads the @grain element, which takes no @via."
                ),
                src,
            );
        }
        if tf.sub_type == "enum"
            && (tree.attr(t.field, "intValueMap").is_some()
                || tree.attr(t.field, "stringValueMap").is_some())
        {
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!(
                    "origin.passthrough on {on}.{fname}: @from \"{from}\" is an enum with a value map, but a @grain element holds the member's symbol."
                ),
                src,
            );
        }
        return;
    }
    if let Some(t) = &target {
        check_extends_origin(m, field, t.field, from, obj, src, errs);
        check_passthrough_type(m, field, t.field, from, convert, obj, src, errs);
    }
    if let Some(via) = m.own_nonempty(origin, "via") {
        if let Some(w) = validate_via_path(m, via, obj, fname, src, errs) {
            check_passthrough_cardinality(m, &w.hops, obj, fname, src, errs, Some(&w));
        }
    } else if let Some(t) = &target
        && !is_value_host
        && let Some(base) = derive_base(m, obj, fname, src, errs)
        && !is_base_relation_target(m, t.entity, base, obj)
        && let Some(hops) = infer_via_single_hop(
            m,
            base,
            t.entity,
            obj,
            fname,
            from,
            "origin.passthrough.@from",
            src,
            errs,
        )
    {
        check_passthrough_cardinality(m, &hops, obj, fname, src, errs, None);
    }
}

#[allow(clippy::too_many_arguments)]
fn check_passthrough_type(
    m: &M<'_>,
    field: NodeId,
    from_field: NodeId,
    from: &str,
    convert: bool,
    obj: NodeId,
    src: &ErrorSource,
    errs: &mut Errs,
) {
    if convert {
        return;
    }
    let (declared, source) = (m.type_label(field), m.type_label(from_field));
    if declared == source {
        return;
    }
    let tree = m.tree;
    push(
        errs,
        ERR_PASSTHROUGH_TYPE_MISMATCH,
        format!(
            "origin.passthrough on {}.{}: field is {declared} but its @from source \"{from}\" is {source} — set @convert: true to acknowledge a deliberate type change.",
            tree.node(obj).name,
            tree.node(field).name
        ),
        &resolved_src(
            src,
            format!("{}::{}", tree.node(obj).fqn(), tree.node(field).name),
            from,
        ),
    );
}

fn check_extends_origin(
    m: &M<'_>,
    field: NodeId,
    from_field: NodeId,
    from: &str,
    obj: NodeId,
    src: &ErrorSource,
    errs: &mut Errs,
) {
    let tree = m.tree;
    let Some(sup) = tree.node(field).super_node else {
        return;
    };
    if tree.node(sup).type_name != T_FIELD {
        return;
    }
    let Some(owner) = tree.node(sup).parent else {
        return;
    };
    if tree.node(owner).type_name != T_OBJECT {
        return;
    }
    if m.super_chain_contains(sup, from_field) {
        return;
    }
    push(
        errs,
        ERR_EXTENDS_ORIGIN_MISMATCH,
        format!(
            "origin.passthrough on {}.{}: @from \"{from}\" disagrees with the field's extends target \"{}.{}\" — extends (shape lineage) and origin.passthrough (data lineage) must point at the same entity field (FR-024).",
            tree.node(obj).name,
            tree.node(field).name,
            tree.node(owner).name,
            tree.node(sup).name
        ),
        &resolved_src(
            src,
            format!("{}::{}", tree.node(obj).fqn(), tree.node(field).name),
            from,
        ),
    );
}

fn aggregate(m: &M<'_>, obj: NodeId, field: NodeId, origin: NodeId, errs: &mut Errs) {
    let tree = m.tree;
    let on = tree.node(obj).name.as_str();
    let fname = tree.node(field).name.as_str();
    let src = &tree.node(origin).source;
    let agg = m.own(origin, "agg").and_then(Value::as_str);
    let of = m.own_nonempty(origin, "of");
    let has_filter = m.own(origin, "filter").is_some();
    let has_distinct = m.own(origin, "distinct").is_some();
    let order_by = m.own(origin, "orderBy");
    let has_order_by = order_by.is_some();
    let is_predicate = matches!(agg, Some(AGG_ANY | AGG_ALL));
    let is_collect = agg == Some(AGG_COLLECT);
    let agg_s = agg.unwrap_or("undefined");
    let is_array = tree.resolved_is_array(field);
    let fsub = tree.node(field).sub_type.as_str();
    let bad = |errs: &mut Errs, msg: String| push(errs, ERR_INVALID_ORIGIN, msg, src);

    if is_collect && !is_array {
        bad(
            errs,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: the carrying field must be isArray:true (collect produces a list)."
            ),
        );
    } else if !is_collect && is_array {
        bad(
            errs,
            format!(
                "origin.aggregate @agg:{agg_s} on {on}.{fname}: a non-collect aggregate reduces to a scalar — the field must be isArray:false."
            ),
        );
    }
    if is_predicate && fsub != "boolean" {
        bad(
            errs,
            format!(
                "origin.aggregate @agg:{agg_s} on {on}.{fname}: a predicate quantifier yields a boolean — the field must be field.boolean."
            ),
        );
    }
    if has_distinct && !is_collect {
        bad(
            errs,
            format!("origin.aggregate on {on}.{fname}: @distinct is valid only on @agg:collect."),
        );
    }
    if has_order_by && !is_collect {
        bad(
            errs,
            format!("origin.aggregate on {on}.{fname}: @orderBy is valid only on @agg:collect."),
        );
    }
    if is_collect && has_distinct && has_order_by {
        bad(
            errs,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: @orderBy and @distinct are mutually exclusive."
            ),
        );
    }

    if is_predicate {
        if !has_filter {
            bad(
                errs,
                format!(
                    "origin.aggregate @agg:{agg_s} on {on}.{fname}: a predicate quantifier requires @filter."
                ),
            );
        }
        if of.is_some() {
            bad(
                errs,
                format!(
                    "origin.aggregate @agg:{agg_s} on {on}.{fname}: @of is forbidden — a quantifier ranges over rows, not a column."
                ),
            );
        }
        match m.own_nonempty(origin, "via") {
            None => bad(
                errs,
                format!(
                    "origin.aggregate @agg:{agg_s} on {on}.{fname}: requires an explicit @via."
                ),
            ),
            Some(via) => {
                if let Some(w) = validate_via_path(m, via, obj, fname, src, errs) {
                    check_aggregate_cardinality(m, &w.hops, obj, fname, src, errs, Some(&w));
                }
            }
        }
        return;
    }

    let Some(of) = of else {
        if !is_collect {
            bad(
                errs,
                format!("origin.aggregate on {on}.{fname}: missing @of."),
            );
            return;
        }
        whole_object_collect(m, obj, field, origin, has_distinct, order_by, errs);
        return;
    };

    let of_target = validate_from_path(m, of, obj, fname, src, errs, "origin.aggregate.@of");
    if let Some(t) = &of_target
        && agg.is_some_and(|a| COLUMN_AGGS.contains(&a))
        && (tree.node(t.field).sub_type == "object" || tree.attr(t.field, "objectRef").is_some())
    {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "origin.aggregate @agg:{agg_s} on {on}.{fname}: @of \"{of}\" is a value-object field (field.{}), which has no single column to aggregate.",
                tree.node(t.field).sub_type
            ),
            &resolved_src(src, format!("{}::{fname}", tree.node(obj).fqn()), of),
        );
    }
    if is_collect
        && let Some(t) = &of_target
        && fsub != tree.node(t.field).sub_type
    {
        bad(
            errs,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: field element type field.{fsub} does not match the @of column type field.{} — collect preserves the element type.",
                tree.node(t.field).sub_type
            ),
        );
    }
    if is_collect && has_order_by && !has_distinct {
        order_by_keys(
            m,
            order_by,
            of_target.as_ref().map(|t| t.entity),
            obj,
            fname,
            "origin.aggregate @agg:collect",
            src,
            errs,
            ERR_INVALID_ORIGIN,
        );
    }
    if let Some(via) = m.own_nonempty(origin, "via") {
        if let Some(w) = validate_via_path(m, via, obj, fname, src, errs) {
            check_aggregate_cardinality(m, &w.hops, obj, fname, src, errs, Some(&w));
        }
        return;
    }
    let Some(t) = of_target else { return };
    let Some(base) = derive_base(m, obj, fname, src, errs) else {
        return;
    };
    if is_base_relation_target(m, t.entity, base, obj) {
        bad(
            errs,
            format!(
                "origin.aggregate on {on}.{fname}: missing @via (aggregates require a relationship path)."
            ),
        );
        return;
    }
    if let Some(hops) = infer_via_single_hop(
        m,
        base,
        t.entity,
        obj,
        fname,
        of,
        "origin.aggregate.@of",
        src,
        errs,
    ) {
        check_aggregate_cardinality(m, &hops, obj, fname, src, errs, None);
    }
}

fn whole_object_collect(
    m: &M<'_>,
    obj: NodeId,
    field: NodeId,
    origin: NodeId,
    has_distinct: bool,
    order_by: Option<&Value>,
    errs: &mut Errs,
) {
    let tree = m.tree;
    let on = tree.node(obj).name.as_str();
    let fname = tree.node(field).name.as_str();
    let src = &tree.node(origin).source;
    let object_ref = m.attr_str(field, "objectRef").filter(|s| !s.is_empty());
    if tree.node(field).sub_type != "object" || object_ref.is_none() {
        push(
            errs,
            ERR_COLLECT_WHOLE_OBJECT,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: @of is omitted, so this is a whole-object rollup — the carrying field must be a field.object declaring @objectRef."
            ),
            src,
        );
        return;
    }
    let object_ref = object_ref.unwrap_or("");
    let owner = tree.node(field).parent.unwrap_or(obj);
    let ref_target = m.find_object(object_ref, m.pkg(owner));
    if let Some(rt) = ref_target
        && tree.node(rt).sub_type != SUB_VALUE
    {
        push(
            errs,
            ERR_SUBTYPE_RULE_VIOLATION,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: @objectRef '{object_ref}' resolves to object.{} — a whole-object rollup must target an object.value (#210, ADR-0028).",
                tree.node(rt).sub_type
            ),
            src,
        );
        return;
    }
    let Some(via) = m.own_nonempty(origin, "via") else {
        push(
            errs,
            ERR_COLLECT_WHOLE_OBJECT,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: @via is required on a whole-object rollup."
            ),
            src,
        );
        return;
    };
    if has_distinct {
        push(
            errs,
            ERR_COLLECT_WHOLE_OBJECT,
            format!(
                "origin.aggregate @agg:collect on {on}.{fname}: @distinct is not supported on a whole-object rollup."
            ),
            src,
        );
        return;
    }
    if let Some(w) = validate_via_path(m, via, obj, fname, src, errs) {
        check_aggregate_cardinality(m, &w.hops, obj, fname, src, errs, Some(&w));
        order_by_keys(
            m,
            order_by,
            Some(w.terminal),
            obj,
            fname,
            "origin.aggregate @agg:collect",
            src,
            errs,
            ERR_COLLECT_WHOLE_OBJECT,
        );
        if let Some(rt) = ref_target {
            let terminal_fields = m.fields(w.terminal);
            for member in m.fields(rt) {
                let mn = &tree.node(member).name;
                let Some(&matched) = terminal_fields.iter().find(|&&f| tree.node(f).name == *mn)
                else {
                    push(
                        errs,
                        ERR_COLLECT_MEMBER_UNRESOLVED,
                        format!(
                            "origin.aggregate @agg:collect on {on}.{fname}: value-object member '{mn}' has no matching field on '{}'.",
                            tree.node(w.terminal).name
                        ),
                        src,
                    );
                    continue;
                };
                let (a, b) = (m.type_label(member), m.type_label(matched));
                if a != b {
                    push(
                        errs,
                        ERR_COLLECT_WHOLE_OBJECT,
                        format!(
                            "origin.aggregate @agg:collect on {on}.{fname}: value-object member '{mn}' is {a} but '{}.{mn}' is {b}.",
                            tree.node(w.terminal).name
                        ),
                        src,
                    );
                }
            }
        }
    }
}

fn computed(m: &M<'_>, obj: NodeId, field: NodeId, origin: NodeId, errs: &mut Errs) {
    let tree = m.tree;
    let on = tree.node(obj).name.as_str();
    let fname = tree.node(field).name.as_str();
    let src = &tree.node(origin).source;
    let Some(expr) = m.own(origin, "expr").filter(|v| v.is_object()) else {
        return;
    };
    let structural = validate_expr(expr);
    if !structural.is_empty() {
        for msg in structural {
            push(
                errs,
                ERR_UNKNOWN_EXPR_NODE,
                format!("origin.computed on {on}.{fname}: {msg}"),
                src,
            );
        }
        return;
    }
    let Some(base) = derive_base(m, obj, fname, src, errs) else {
        return;
    };
    let field_node = |name: &str| -> Option<NodeId> {
        if obj != base
            && name != fname
            && let Some(own) = m.find_field(obj, name)
        {
            return Some(own);
        }
        let base_field = m.find_field(base, name);
        if base_field.is_some() || obj == base || !name.contains('.') {
            return base_field;
        }
        match resolve_filter_path(m, base, name) {
            Some(Ok(p)) => Some(p.field),
            _ => None,
        }
    };
    let resolve = |name: &str| -> Option<String> {
        let node = field_node(name)?;
        if node != field
            && let Some(no) = m.origin_of(node)
            && tree.node(no).sub_type == O_AGGREGATE
            && m.own(no, "agg").and_then(Value::as_str) == Some(AGG_COLLECT)
        {
            return None;
        }
        Some(tree.node(node).sub_type.clone())
    };
    let is_int_enum = |name: &str| -> bool {
        field_node(name).is_some_and(|n| {
            tree.node(n).sub_type == "enum" && tree.attr(n, "intValueMap").is_some()
        })
    };
    let inferred = infer_with(expr, &resolve, &is_int_enum);
    if !inferred.errors.is_empty() {
        for msg in inferred.errors {
            push(
                errs,
                ERR_INVALID_ORIGIN,
                format!("origin.computed on {on}.{fname}: {msg}"),
                src,
            );
        }
        return;
    }
    let view = |name: &str| -> Option<FieldView<'_>> {
        let id = field_node(name)?;
        let n = tree.node(id);
        Some(FieldView {
            name: &n.name,
            sub: &n.sub_type,
            members: if n.sub_type == "enum" {
                tree.attr(id, "values").and_then(Value::as_array)
            } else {
                None
            },
        })
    };
    if let Some(problem) = literal_comparison_problem(expr, &view) {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!("origin.computed on {on}.{fname}: @expr {problem}"),
            src,
        );
        return;
    }
    if let Some(t) = &inferred.ty
        && *t != tree.node(field).sub_type
    {
        push(
            errs,
            ERR_COMPUTED_TYPE_MISMATCH,
            format!(
                "origin.computed on {on}.{fname}: @expr infers field.{t} but the field is declared field.{} — a computed column's type is derived from its expression and must match (no @convert escape).",
                tree.node(field).sub_type
            ),
            src,
        );
    }
}

fn first(m: &M<'_>, obj: NodeId, field: NodeId, origin: NodeId, errs: &mut Errs) {
    let tree = m.tree;
    let on = tree.node(obj).name.as_str();
    let fname = tree.node(field).name.as_str();
    let src = &tree.node(origin).source;
    let Some(of) = m.own_nonempty(origin, "of") else {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!("origin.first on {on}.{fname}: missing @of."),
            src,
        );
        return;
    };
    if tree.attr(field, "required") == Some(&Value::Bool(true)) {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "origin.first on {on}.{fname}: the field must not be @required — an empty related set (after @filter) yields null."
            ),
            src,
        );
    }
    let of_target = validate_from_path(m, of, obj, fname, src, errs, "origin.first.@of");
    if let Some(t) = &of_target
        && tree.node(field).sub_type != tree.node(t.field).sub_type
    {
        push(
            errs,
            ERR_INVALID_ORIGIN,
            format!(
                "origin.first on {on}.{fname}: field field.{} does not match the @of column field.{} — first projects the column unchanged, so the types must match.",
                tree.node(field).sub_type,
                tree.node(t.field).sub_type
            ),
            src,
        );
    }
    if let Some(via) = m.own_nonempty(origin, "via") {
        if let Some(w) = validate_via_path(m, via, obj, fname, src, errs) {
            check_aggregate_cardinality(m, &w.hops, obj, fname, src, errs, Some(&w));
        }
    } else if let Some(t) = &of_target
        && let Some(base) = derive_base(m, obj, fname, src, errs)
        && !is_base_relation_target(m, t.entity, base, obj)
        && let Some(hops) = infer_via_single_hop(
            m,
            base,
            t.entity,
            obj,
            fname,
            of,
            "origin.first.@of",
            src,
            errs,
        )
    {
        check_aggregate_cardinality(m, &hops, obj, fname, src, errs, None);
    }
    order_by_keys(
        m,
        m.own(origin, "orderBy"),
        of_target.as_ref().map(|t| t.entity),
        obj,
        fname,
        "origin.first",
        src,
        errs,
        ERR_INVALID_ORIGIN,
    );
}

fn as_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        None => Vec::new(),
        Some(Value::Array(a)) => a.iter().collect(),
        Some(x) => vec![x],
    }
}

fn is_identifier(s: &str) -> bool {
    let mut c = s.chars();
    c.next()
        .is_some_and(|f| f.is_ascii_alphabetic() || f == '_')
        && c.all(|x| x.is_ascii_alphanumeric() || x == '_')
}

fn function_origin(m: &M<'_>, obj: NodeId, field: NodeId, origin: NodeId, errs: &mut Errs) {
    let tree = m.tree;
    let src = &tree.node(origin).source;
    let fname = tree.node(field).name.as_str();
    let where_ = format!("origin.function on {}.{fname}", tree.node(obj).name);
    let bad = |errs: &mut Errs, msg: String| push(errs, ERR_INVALID_ORIGIN, msg, src);
    for attr in ["function", "schema"] {
        if let Some(v) = m.own(origin, attr)
            && !v.as_str().is_some_and(is_identifier)
        {
            bad(
                errs,
                format!(
                    "{where_}: @{attr} {v} is not a plain identifier ([A-Za-z_][A-Za-z0-9_]*); a function is named, never written as SQL."
                ),
            );
        }
    }
    let args = as_list(m.own(origin, "args"));
    let params = as_list(m.own(origin, "params"));
    let returns = m.own(origin, "returns");
    for t in params.iter().copied().chain(returns) {
        if !t.as_str().is_some_and(|s| CAST_TARGETS.contains(&s)) {
            bad(
                errs,
                format!(
                    "{where_}: {t} is not a parameter or return type; use one of {}.",
                    CAST_TARGETS.join(", ")
                ),
            );
        }
    }
    if let Some(r) = returns.and_then(Value::as_str)
        && r != tree.node(field).sub_type
    {
        bad(
            errs,
            format!(
                "{where_}: @returns {r}, but the field is field.{}; the declared return type must be the field's type.",
                tree.node(field).sub_type
            ),
        );
    }
    if params.len() != args.len() {
        bad(
            errs,
            format!(
                "{where_}: @params declares {} parameter type(s) for {} argument(s); declare one per @args entry.",
                params.len(),
                args.len()
            ),
        );
    }
    let is_projection = tree.node(obj).sub_type == SUB_PROJECTION;
    let base = if is_projection {
        derive_base(m, obj, fname, src, &mut Vec::new())
    } else {
        Some(obj)
    };
    for (index, name) in args.iter().enumerate() {
        let name_s = name.as_str();
        let own = name_s
            .filter(|n| *n != fname)
            .and_then(|n| m.find_field(obj, n));
        let own_origin = own.and_then(|o| m.origin_of(o));
        let arg = own.or_else(|| name_s.zip(base).and_then(|(n, b)| m.find_field(b, n)));
        let shown = name_s.map_or_else(|| name.to_string(), str::to_string);
        match arg {
            None => bad(
                errs,
                format!(
                    "{where_}: @args names \"{shown}\", which is not a field of the projection or its base entity."
                ),
            ),
            Some(_) if name_s == Some(fname) => bad(
                errs,
                format!(
                    "{where_}: @args names \"{shown}\", which is not a field of the projection or its base entity."
                ),
            ),
            Some(_) if own_origin.is_some_and(|o| tree.node(o).sub_type == O_AGGREGATE) => bad(
                errs,
                format!(
                    "{where_}: @args names \"{shown}\", an origin.aggregate; a function takes values of the row, not of the group."
                ),
            ),
            Some(a)
                if {
                    let s = tree.node(a).sub_type.as_str();
                    s == "object" || s == "map" || tree.resolved_is_array(a)
                } =>
            {
                bad(
                    errs,
                    format!(
                        "{where_}: @args names \"{shown}\", a field.{}; a function argument is a scalar.",
                        tree.node(a).sub_type
                    ),
                )
            }
            Some(a) => {
                if let Some(p) = params.get(index).and_then(|p| p.as_str())
                    && tree.node(a).sub_type != p
                {
                    bad(
                        errs,
                        format!(
                            "{where_}: argument {} \"{shown}\" is a field.{}, but parameter {} is declared {p}.",
                            index + 1,
                            tree.node(a).sub_type,
                            index + 1
                        ),
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// validateDerivedFieldProvidability
// ---------------------------------------------------------------------------

fn effective_projection_filter(m: &M<'_>, proj: NodeId) -> Option<Value> {
    let mut levels: Vec<Value> = Vec::new();
    let mut cur = Some(proj);
    let mut seen = HashSet::new();
    while let Some(n) = cur {
        if !seen.insert(n) {
            break;
        }
        // ADR-0039: own: each level contributes the @filter declared on it.
        if let Some(v) = m.own(n, "filter") {
            levels.insert(0, v.clone());
        }
        cur = m.tree.node(n).super_node;
    }
    match levels.len() {
        0 => None,
        1 => levels.pop(),
        _ => {
            let members: Vec<Value> = levels
                .into_iter()
                .flat_map(|f| {
                    if let Value::Object(o) = &f
                        && o.len() == 1
                        && let Some(Value::Array(a)) = o.get(FILTER_AND)
                    {
                        return a.clone();
                    }
                    vec![f]
                })
                .collect();
            Some(serde_json::json!({ FILTER_AND: members }))
        }
    }
}

fn filter_keys<'v>(filter: &'v Value, out: &mut Vec<&'v str>) {
    let Value::Object(o) = filter else { return };
    for (k, v) in o {
        if k == FILTER_AND || k == FILTER_OR {
            if let Value::Array(a) = v {
                for s in a {
                    filter_keys(s, out);
                }
            }
        } else {
            out.push(k);
        }
    }
}

fn expression_field_refs(expr: Option<&Value>) -> Vec<&str> {
    let Some(expr) = expr else { return Vec::new() };
    let mut nodes = Vec::new();
    expression_nodes(expr, &mut nodes);
    nodes
        .into_iter()
        .filter_map(|n| n.get("field").and_then(Value::as_str))
        .collect()
}

fn reach_function_args(m: &M<'_>, f: NodeId, reached: &mut HashSet<NodeId>) {
    let Some(origin) = m
        .origin_of(f)
        .filter(|&o| m.tree.node(o).sub_type == O_FUNCTION)
    else {
        return;
    };
    let Some(host) = m.tree.node(f).parent else {
        return;
    };
    for a in as_list(m.own(origin, "args")) {
        if let Some(n) = a.as_str()
            && let Some(arg) = m.find_field(host, n)
            && reached.insert(arg)
        {
            reach_function_args(m, arg, reached);
        }
    }
}

fn projection_reached_entity_fields(m: &M<'_>) -> HashSet<NodeId> {
    let tree = m.tree;
    let mut reached = HashSet::new();
    for &obj in m.index.objects() {
        if tree.node(obj).sub_type != SUB_PROJECTION {
            continue;
        }
        let mut silent = Vec::new();
        let base = derive_base(m, obj, "@filter", &tree.node(obj).source, &mut silent);
        let filter = effective_projection_filter(m, obj);
        if let Some(base) = base.filter(|&b| b != obj)
            && let Some(filter) = &filter
        {
            let mut keys = Vec::new();
            filter_keys(filter, &mut keys);
            for key in keys {
                match resolve_filter_path(m, base, key) {
                    Some(Ok(p)) => {
                        reached.insert(p.field);
                    }
                    None => {
                        if let Some(f) = m.find_field(base, key) {
                            reached.insert(f);
                        }
                    }
                    Some(Err(_)) => {}
                }
            }
        }
        for field in m.fields(obj) {
            for origin in m.origins_of(field) {
                match tree.node(origin).sub_type.as_str() {
                    O_PASSTHROUGH => {
                        if let Some(from) = m.own(origin, "from").and_then(Value::as_str)
                            && let Some(t) = validate_from_path(
                                m,
                                from,
                                obj,
                                &tree.node(field).name,
                                &tree.node(origin).source,
                                &mut silent,
                                "origin.passthrough.@from",
                            )
                        {
                            reached.insert(t.field);
                        }
                    }
                    O_COMPUTED => {
                        let Some(base) = base.filter(|&b| b != obj) else {
                            continue;
                        };
                        for name in expression_field_refs(m.own(origin, "expr")) {
                            if name.contains('.')
                                && let Some(Ok(p)) = resolve_filter_path(m, base, name)
                            {
                                reached.insert(p.field);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let snapshot: Vec<NodeId> = reached.iter().copied().collect();
    for f in snapshot {
        reach_function_args(m, f, &mut reached);
    }
    reached
}

pub fn validate_derived_field_providability(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let tree = m.tree;
    let mut reached: Option<HashSet<NodeId>> = None;
    for &obj in m.index.objects() {
        if tree.node(obj).sub_type != SUB_ENTITY {
            continue;
        }
        let has_read = m.kids(obj).iter().any(|&c| {
            tree.node(c).type_name == T_SOURCE
                && READ_ONLY_KINDS.contains(&m.attr_str(c, "kind").unwrap_or("table"))
        });
        if has_read {
            continue;
        }
        for field in m.own_fields(obj) {
            let Some(origin) = m.origin_of(field) else {
                continue;
            };
            let sub = tree.node(origin).sub_type.as_str();
            if matches!(sub, O_FIRST | O_COMPUTED | O_FUNCTION)
                && reached
                    .get_or_insert_with(|| projection_reached_entity_fields(&m))
                    .contains(&field)
            {
                continue;
            }
            out.errors.push(MetaError::at(
                ERR_DERIVED_FIELD_NO_READ_SOURCE,
                format!(
                    "derived field \"{}.{}\" carries an origin.* but entity \"{}\" declares no read-capable source — derived fields do not exist on the writable table.",
                    tree.node(obj).name,
                    tree.node(field).name,
                    tree.node(obj).name
                ),
                tree.node(field).source.clone(),
            ));
        }
    }
}

// ---------------------------------------------------------------------------
// validateOriginSegmentsAndCorrelation
// ---------------------------------------------------------------------------

fn origin_related_entity(m: &M<'_>, origin: NodeId, obj: NodeId) -> Option<NodeId> {
    let tree = m.tree;
    if let Some(of) = m.own_nonempty(origin, "of") {
        let pname = tree
            .node(origin)
            .parent
            .map_or("", |p| tree.node(p).name.as_str());
        return validate_from_path(
            m,
            of,
            obj,
            pname,
            &tree.node(origin).source,
            &mut Vec::new(),
            "",
        )
        .map(|t| t.entity);
    }
    let via = m.own(origin, "via")?.as_str()?;
    let mut parts = via.split('.');
    let mut cur = m.find_object(parts.next()?, m.pkg(obj));
    for hop in parts {
        let c = cur?;
        let rel = m.kids(c).iter().copied().find(|&k| {
            let n = tree.node(k);
            (n.type_name == T_RELATIONSHIP || n.type_name == T_IDENTITY) && n.name == hop
        });
        cur = match rel {
            None => m.reverse_hops(c, hop).first().map(|h| h.0),
            Some(r) => m.ref_target(
                r,
                if tree.node(r).type_name == T_RELATIONSHIP {
                    "objectRef"
                } else {
                    "references"
                },
            ),
        };
    }
    cur
}

fn check_correlated(
    m: &M<'_>,
    filter: &Value,
    base: NodeId,
    where_: &str,
    src: &ErrorSource,
    errs: &mut Errs,
    on_projection: bool,
) {
    let Value::Object(f) = filter else { return };
    for (key, clause) in f {
        if key == FILTER_AND || key == FILTER_OR {
            if let Value::Array(a) = clause {
                for s in a {
                    check_correlated(m, s, base, where_, src, errs, on_projection);
                }
            }
            continue;
        }
        let Value::Object(ops) = clause else { continue };
        for (op, value) in ops {
            let operand = value.as_object().filter(|o| o.contains_key("field"));
            let null_safe = NULL_SAFE_OPS.contains(&op.as_str());
            let Some(operand) = operand else {
                if null_safe {
                    push(
                        errs,
                        ERR_BAD_ATTR_FILTER,
                        format!(
                            "{where_}: @filter on \"{key}\" uses \"{op}\", which compares with a base-row field: write {{ {op}: {{ field: \"<base field>\" }} }}."
                        ),
                        src,
                    );
                }
                continue;
            };
            let name = operand.get("field").and_then(Value::as_str);
            if !CORRELATED_OPS.contains(&op.as_str()) {
                push(
                    errs,
                    ERR_BAD_ATTR_FILTER,
                    format!(
                        "{where_}: @filter on \"{key}\" compares with a base-row field using \"{op}\"; a correlated operand takes {}.",
                        CORRELATED_OPS.join(", ")
                    ),
                    src,
                );
            } else if name.is_none_or(|n| m.find_field(base, n).is_none()) {
                let path = name
                    .filter(|n| n.contains('.') && on_projection)
                    .and_then(|n| resolve_filter_path(m, base, n));
                if let Some(Ok(_)) = path {
                    continue;
                }
                let shown = name.unwrap_or("undefined");
                let msg = match path {
                    Some(Err(why)) => format!(
                        "{where_}: @filter on \"{key}\" compares with the base-row path \"{shown}\": {why}."
                    ),
                    _ if name.is_some_and(|n| n.contains('.')) && !on_projection => format!(
                        "{where_}: @filter on \"{key}\" compares with the path \"{shown}\"; a path operand is legal only on a projection."
                    ),
                    _ => format!(
                        "{where_}: @filter on \"{key}\" names base-row field \"{shown}\", which \"{}\" does not declare.",
                        m.tree.node(base).name
                    ),
                };
                push(errs, ERR_BAD_ATTR_FILTER, msg, src);
            }
        }
    }
}

pub fn validate_origin_segments_and_correlation(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let tree = m.tree;
    let mut errs = Vec::new();
    for &obj in m.index.objects() {
        let sub = tree.node(obj).sub_type.as_str();
        if sub != SUB_PROJECTION && sub != SUB_ENTITY {
            continue;
        }
        for field in m.own_fields(obj) {
            for origin in m.origins_of(field) {
                let osub = tree.node(origin).sub_type.as_str();
                if osub != O_FIRST && osub != O_AGGREGATE {
                    continue;
                }
                let src = &tree.node(origin).source;
                let where_ = format!(
                    "origin.{osub} on {}.{}",
                    tree.node(obj).name,
                    tree.node(field).name
                );
                if let Some(seg) = m.own(origin, "segment").and_then(Value::as_str)
                    && let Some(related) = origin_related_entity(&m, origin, obj)
                    && m.find_child(related, T_SEGMENT, seg).is_none()
                {
                    push(
                        &mut errs,
                        ERR_INVALID_ORIGIN,
                        format!(
                            "{where_}: @segment \"{seg}\" is not a segment declared on \"{}\", the entity whose rows it scopes.",
                            tree.node(related).name
                        ),
                        src,
                    );
                }
                let Some(filter) = m.own(origin, "filter") else {
                    continue;
                };
                let Some(base) = derive_base(&m, obj, &tree.node(field).name, src, &mut Vec::new())
                else {
                    continue;
                };
                check_correlated(
                    &m,
                    filter,
                    base,
                    &where_,
                    src,
                    &mut errs,
                    sub == SUB_PROJECTION,
                );
            }
        }
    }
    out.errors.extend(errs);
}

// ---------------------------------------------------------------------------
// validateDerivedCycles
// ---------------------------------------------------------------------------

pub fn validate_derived_cycles(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let tree = m.tree;
    for &obj in m.index.objects() {
        let fields = m.fields(obj);
        // Cheap exit: a cycle needs a function or computed origin.
        if !fields.iter().any(|&f| {
            m.origin_of(f)
                .is_some_and(|o| matches!(tree.node(o).sub_type.as_str(), O_FUNCTION | O_COMPUTED))
        }) {
            continue;
        }
        let by_name: HashMap<&str, NodeId> = fields
            .iter()
            .map(|&f| (tree.node(f).name.as_str(), f))
            .collect();
        let is_projection = tree.node(obj).sub_type == SUB_PROJECTION;
        let deps = |f: NodeId| -> Vec<NodeId> {
            let Some(origin) = m.origin_of(f) else {
                return Vec::new();
            };
            let mut names: Vec<&str> = Vec::new();
            let mut self_allowed = false;
            match tree.node(origin).sub_type.as_str() {
                O_FUNCTION => {
                    for n in as_list(m.own(origin, "args")) {
                        if let Some(s) = n.as_str() {
                            names.push(s);
                        }
                    }
                }
                O_COMPUTED => {
                    self_allowed = !is_projection;
                    for n in expression_field_refs(m.own(origin, "expr")) {
                        names.push(n.split('.').next().unwrap_or(n));
                    }
                }
                _ => {}
            }
            names
                .into_iter()
                .filter_map(|n| by_name.get(n).copied())
                .filter(|&d| (self_allowed || d != f) && m.origin_of(d).is_some())
                .collect()
        };
        let mut done: HashSet<NodeId> = HashSet::new();
        let mut reported: HashSet<String> = HashSet::new();
        #[allow(clippy::too_many_arguments)]
        fn visit(
            m: &M<'_>,
            obj: NodeId,
            f: NodeId,
            path: &mut Vec<NodeId>,
            deps: &dyn Fn(NodeId) -> Vec<NodeId>,
            done: &mut HashSet<NodeId>,
            reported: &mut HashSet<String>,
            out: &mut Findings,
        ) {
            let tree = m.tree;
            if let Some(at) = path.iter().position(|&p| p == f) {
                let mut cycle: Vec<&str> = path[at..]
                    .iter()
                    .map(|&x| tree.node(x).name.as_str())
                    .collect();
                let mut key_parts = cycle.clone();
                key_parts.sort();
                cycle.push(tree.node(f).name.as_str());
                if reported.insert(key_parts.join(",")) {
                    let src = m.origin_of(f).map_or_else(
                        || tree.node(f).source.clone(),
                        |o| tree.node(o).source.clone(),
                    );
                    out.errors.push(MetaError::at(
                        ERR_INVALID_ORIGIN,
                        format!(
                            "{}.{}: a derived field depends on itself through {}; a view inlines each dependency on the same row, so the cycle has no SQL. Break it.",
                            tree.node(obj).name,
                            tree.node(f).name,
                            cycle.join(" → ")
                        ),
                        src,
                    ));
                }
                return;
            }
            if done.contains(&f) {
                return;
            }
            path.push(f);
            for d in deps(f) {
                visit(m, obj, d, path, deps, done, reported, out);
            }
            path.pop();
            done.insert(f);
        }
        for &f in &fields {
            if m.origin_of(f).is_some() {
                visit(
                    &m,
                    obj,
                    f,
                    &mut Vec::new(),
                    &deps,
                    &mut done,
                    &mut reported,
                    out,
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// validateProjectionFilter
// ---------------------------------------------------------------------------

struct FilterField {
    derived: bool,
    ops: &'static [&'static str],
    reported: bool,
}

// ---------------------------------------------------------------------------
// validateExtenderSubtypeScope (warning only)
// ---------------------------------------------------------------------------

const ATTR_DISCRIMINATOR_NAME: &str = "discriminator";

/// The discriminator field of the TPH level `obj` belongs to (its own, or an ancestor's).
fn tph_discriminator_of<'a>(m: &M<'a>, obj: NodeId) -> Option<&'a str> {
    let mut cur = Some(obj);
    let mut n = 0;
    while let Some(c) = cur {
        if m.tree.node(c).type_name != T_OBJECT || n > m.tree.len() {
            return None;
        }
        // ADR-0039: own: the level that declares the discriminator.
        if let Some(d) = m.own(c, ATTR_DISCRIMINATOR_NAME).and_then(Value::as_str) {
            return Some(d);
        }
        n += 1;
        cur = m.tree.node(c).super_node;
    }
    None
}

/// Whether `obj` extends `ancestor`, directly or through levels (never itself).
fn is_descendant_of(m: &M<'_>, obj: NodeId, ancestor: NodeId) -> bool {
    m.tree
        .node(obj)
        .super_node
        .is_some_and(|s| m.super_chain_contains(s, ancestor))
}

/// rc.21 part B (I2): warn when an extender's view widened with the identity-anchor rule: a
/// projection with no identity of its own whose super anchors a TPH base by identity, that binds a
/// field to a column only a subtype carries, and scopes no row by the discriminator.
pub fn validate_extender_subtype_scope(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let tree = m.tree;
    for &obj in m.index.objects() {
        let o = tree.node(obj);
        // An abstract extender emits no view, so nothing it declares widened one.
        if o.sub_type != SUB_PROJECTION || o.is_abstract {
            continue;
        }
        // ADR-0039: own: the anchor rule applies to an extender that declares no identity of its own.
        if tree
            .own_children(obj)
            .iter()
            .any(|&c| tree.node(c).type_name == T_IDENTITY)
        {
            continue;
        }
        let Some(sup) = o.super_node else { continue };
        if !m.is(sup, T_OBJECT, SUB_PROJECTION) || !anchors_by_identity(&m, sup, 0) {
            continue;
        }
        let Some(base) = derive_base(&m, obj, "@extends", &o.source, &mut Vec::new()) else {
            continue;
        };
        let Some(discriminator) = tph_discriminator_of(&m, base) else {
            continue;
        };
        if let Some(filter) = effective_projection_filter(&m, obj) {
            let mut keys = Vec::new();
            filter_keys(&filter, &mut keys);
            if keys.contains(&discriminator) {
                continue;
            }
        }
        let pkg = m.pkg(obj);
        let mut subtype_fields: Vec<String> = Vec::new();
        let mut subtype: Option<NodeId> = None;
        // ADR-0039: own: only the extender's OWN fields chose its base before rc.21.
        for f in m.own_fields(obj) {
            let Some(owner) = ref_named_owner(&m, f, pkg) else {
                continue;
            };
            if owner == base || !is_descendant_of(&m, owner, base) {
                continue;
            }
            let fnode = tree.node(f);
            let tail = fnode
                .super_ref
                .as_deref()
                .and_then(|r| r.rsplit('.').next())
                .unwrap_or(&fnode.name);
            subtype_fields.push(format!(
                "\"{}\" ({}.{tail})",
                fnode.name,
                tree.node(owner).name
            ));
            subtype.get_or_insert(owner);
        }
        if let Some(sub) = subtype {
            let base_name = &tree.node(base).name;
            out.warnings.push(MetaError::at(
                WARN_LEGACY,
                format!(
                    "object.projection {}: {} read columns only a subtype carries, over the TPH base {base_name} with no @filter on its discriminator \"{discriminator}\", so the view returns every {base_name} row (rc.21: an extender keeps its super's identity anchor; before, its base was the subtype). To keep a subtype-scoped view, add @filter {{ {discriminator}: <value> }} or declare identity.primary {{ extends: {}.primary }}.",
                    o.name,
                    subtype_fields.join(", "),
                    tree.node(sub).name
                ),
                ErrorSource::Code,
            ));
        }
    }
}

fn entity_field_aggregates(m: &M<'_>, f: NodeId) -> bool {
    m.origin_of(f)
        .is_some_and(|o| m.tree.node(o).sub_type == O_AGGREGATE)
}

fn computed_reads_aggregate(m: &M<'_>, f: NodeId, obj: NodeId, seen: &mut HashSet<NodeId>) -> bool {
    if !seen.insert(f) {
        return false;
    }
    let Some(origin) = m
        .origin_of(f)
        .filter(|&o| m.tree.node(o).sub_type == O_COMPUTED)
    else {
        return false;
    };
    let fname = &m.tree.node(f).name;
    for name in expression_field_refs(m.own(origin, "expr")) {
        if name == fname {
            continue;
        }
        let Some(other) = m.find_field(obj, name) else {
            continue;
        };
        if entity_field_aggregates(m, other) || computed_reads_aggregate(m, other, obj, seen) {
            return true;
        }
    }
    false
}

pub fn validate_projection_filter(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let tree = m.tree;
    for &obj in m.index.objects() {
        if tree.node(obj).sub_type != SUB_PROJECTION {
            continue;
        }
        let Some(filter) = effective_projection_filter(&m, obj) else {
            continue;
        };
        let Value::Object(fobj) = &filter else {
            continue;
        };
        let src = &tree.node(obj).source;
        let mut fields: HashMap<String, FilterField> = HashMap::new();
        for f in m.fields(obj) {
            let derived = m.origin_of(f).is_some_and(|o| {
                let s = tree.node(o).sub_type.as_str();
                s != O_PASSTHROUGH
                    && (s != O_COMPUTED
                        || computed_reads_aggregate(&m, f, obj, &mut HashSet::new()))
            });
            fields.insert(
                tree.node(f).name.clone(),
                FilterField {
                    derived,
                    ops: ops_for_field(m.tree, f),
                    reported: false,
                },
            );
        }
        let pname = tree.node(obj).name.as_str();
        let base = derive_base(&m, obj, "@filter", src, &mut Vec::new());
        if let Some(base) = base.filter(|&b| b != obj) {
            for f in m.fields(base) {
                fields
                    .entry(tree.node(f).name.clone())
                    .or_insert_with(|| FilterField {
                        derived: entity_field_aggregates(&m, f),
                        ops: ops_for_field(m.tree, f),
                        reported: false,
                    });
            }
            let mut keys = Vec::new();
            filter_keys(&filter, &mut keys);
            for key in keys {
                if fields.contains_key(key) {
                    continue;
                }
                match resolve_filter_path(&m, base, key) {
                    None => {}
                    Some(Err(why)) => {
                        push(
                            &mut out.errors,
                            ERR_BAD_ATTR_FILTER,
                            format!(
                                "projection \"{pname}\" @filter path \"{key}\" does not resolve: {why}."
                            ),
                            src,
                        );
                        fields.insert(
                            key.to_string(),
                            FilterField {
                                derived: false,
                                ops: &[],
                                reported: true,
                            },
                        );
                    }
                    Some(Ok(p)) => {
                        fields.insert(
                            key.to_string(),
                            FilterField {
                                derived: entity_field_aggregates(&m, p.field),
                                ops: ops_for_field(m.tree, p.field),
                                reported: false,
                            },
                        );
                    }
                }
            }
        }
        check_filter_refs(fobj, &fields, pname, src, &mut out.errors);
    }
}

fn check_filter_refs(
    filter: &serde_json::Map<String, Value>,
    fields: &HashMap<String, FilterField>,
    pname: &str,
    src: &ErrorSource,
    errs: &mut Errs,
) {
    let mut err = |msg: String| push(errs, ERR_BAD_ATTR_FILTER, msg, src);
    check_filter_inner(filter, fields, pname, &mut err);
}

fn check_filter_inner(
    filter: &serde_json::Map<String, Value>,
    fields: &HashMap<String, FilterField>,
    pname: &str,
    err: &mut dyn FnMut(String),
) {
    for (key, clause) in filter {
        if key == FILTER_AND || key == FILTER_OR {
            let Value::Array(a) = clause else {
                err(format!(
                    "projection \"{pname}\" @filter \"{key}\" must be an array of sub-clauses."
                ));
                continue;
            };
            for sub in a {
                match sub {
                    Value::Object(o) => check_filter_inner(o, fields, pname, err),
                    _ => err(format!(
                        "projection \"{pname}\" @filter \"{key}\" contains a non-object sub-clause."
                    )),
                }
            }
            continue;
        }
        let field = fields.get(key.as_str());
        if field.is_some_and(|f| f.reported) {
            continue;
        }
        let Some(field) = field else {
            err(format!(
                "projection \"{pname}\" @filter references \"{key}\", which is not a declared field of the projection or of its base entity."
            ));
            continue;
        };
        if field.derived {
            err(format!(
                "projection \"{pname}\" @filter references \"{key}\", an aggregate-derived field. A view-level WHERE runs before aggregation."
            ));
            continue;
        }
        let Value::Object(ops) = clause else {
            err(format!(
                "projection \"{pname}\" @filter on \"{key}\" must be an {{ op: value }} object."
            ));
            continue;
        };
        if ops.is_empty() {
            err(format!(
                "projection \"{pname}\" @filter on \"{key}\" declares no operator."
            ));
            continue;
        }
        for op in ops.keys() {
            if !field.ops.contains(&op.as_str()) {
                err(format!(
                    "projection \"{pname}\" @filter on \"{key}\" uses op \"{op}\", which is not allowed for its type. Allowed ops: {}.",
                    field.ops.join(", ")
                ));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// validateProjectionUnionAndGrain
// ---------------------------------------------------------------------------

pub fn validate_projection_union_and_grain(ctx: &Ctx<'_>, out: &mut Findings) {
    let m = M::new(ctx);
    let tree = m.tree;
    for &obj in m.index.objects() {
        if tree.node(obj).sub_type != SUB_PROJECTION {
            continue;
        }
        let src = &tree.node(obj).source;
        let pname = tree.node(obj).name.clone();
        let mut bad = |msg: String| {
            push(
                &mut out.errors,
                ERR_BAD_ATTR_VALUE,
                format!("object.projection {pname}: {msg}"),
                src,
            );
        };
        let union = m.own(obj, "union");
        if m.own(obj, "unionAll").is_some() && union.is_none() {
            bad("@unionAll needs @union.".to_string());
        }
        if let Some(union) = union {
            let mine: Vec<String> = m.fields(obj).iter().map(|&f| describe(&m, f)).collect();
            for name in as_list(Some(union)) {
                let member = name
                    .as_str()
                    .and_then(|n| m.find_object(n, m.pkg(obj)))
                    .filter(|&x| tree.node(x).sub_type == SUB_PROJECTION);
                let Some(member) = member else {
                    bad(format!(
                        "@union names \"{}\", which is not an object.projection.",
                        name.as_str()
                            .map_or_else(|| name.to_string(), str::to_string)
                    ));
                    continue;
                };
                if member == obj {
                    bad("@union names the projection itself.".to_string());
                    continue;
                }
                if m.own(member, "union").is_some() {
                    bad(format!(
                        "@union member \"{}\" declares its own @union; name its members here instead.",
                        tree.node(member).name
                    ));
                }
                let theirs: Vec<String> =
                    m.fields(member).iter().map(|&f| describe(&m, f)).collect();
                if mine != theirs {
                    bad(format!(
                        "@union member \"{}\" has a different shape: ({}) where this view is ({}). A union's members have the same fields, in order.",
                        tree.node(member).name,
                        theirs.join(", "),
                        mine.join(", ")
                    ));
                }
            }
        }
        let grain = m.own(obj, "grain");
        let ordinal = m.own(obj, "grainOrdinal");
        if ordinal.is_some() && grain.is_none() {
            bad("@grainOrdinal needs @grain.".to_string());
        }
        if let Some(Value::String(grain)) = grain {
            let base = derive_base(&m, obj, "@grain", src, &mut Vec::new());
            let field = base.and_then(|b| m.find_field(b, grain));
            let ok = field.is_some_and(|f| {
                tree.node(f).sub_type == "object"
                    && tree.resolved_is_array(f)
                    && tree
                        .attr(f, "storage")
                        .is_none_or(|s| s.as_str() == Some("jsonb"))
                    && m.ref_target(f, "objectRef").is_some()
            });
            if !ok {
                bad(format!(
                    "@grain \"{grain}\" must name a field.object array (isArray, jsonb storage, with @objectRef) of the base entity{}.",
                    base.map_or(String::new(), |b| format!(" \"{}\"", tree.node(b).name))
                ));
            }
            for f in m.fields(obj) {
                if m.origins_of(f)
                    .iter()
                    .any(|&o| tree.node(o).sub_type == O_AGGREGATE)
                {
                    bad(format!(
                        "\"{}\" is an origin.aggregate; a @grain view has one row per element and groups nothing.",
                        tree.node(f).name
                    ));
                }
            }
            if let Some(ord) = ordinal {
                let f = ord.as_str().and_then(|n| m.find_field(obj, n));
                let fine = f.is_some_and(|f| {
                    matches!(tree.node(f).sub_type.as_str(), "int" | "long")
                        && m.origin_of(f).is_none()
                        && tree.node(f).super_ref.is_none()
                });
                if !fine {
                    bad(format!(
                        "@grainOrdinal \"{}\" must name a field.int or field.long of the projection, with no origin and no extends.",
                        ord.as_str().map_or_else(|| ord.to_string(), str::to_string)
                    ));
                }
            }
        }
    }
}

fn describe(m: &M<'_>, f: NodeId) -> String {
    let tree = m.tree;
    let n = tree.node(f);
    let arr = if tree.resolved_is_array(f) { "[]" } else { "" };
    let col = m
        .attr_str(f, "column")
        .map_or(String::new(), |c| format!(" @column {c}"));
    let shape = if n.sub_type == "enum" {
        let get = |k: &str| tree.attr(f, k).cloned().unwrap_or(Value::Null);
        format!(
            " {}",
            Value::Array(vec![
                get("values"),
                get("intValueMap"),
                get("stringValueMap")
            ])
        )
    } else {
        String::new()
    };
    format!("{}: field.{}{arr}{col}{shape}", n.name, n.sub_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_in_the_shared_catalogue() {
        let raw = include_str!("../../data/ERROR-CODES.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for code in [
            ERR_INVALID_ORIGIN,
            ERR_SUBTYPE_RULE_VIOLATION,
            ERR_EXTENDS_ORIGIN_MISMATCH,
            ERR_PASSTHROUGH_TYPE_MISMATCH,
            ERR_AMBIGUOUS_PATH,
            ERR_ORIGIN_CARDINALITY,
            ERR_COLLECT_MEMBER_UNRESOLVED,
            ERR_COLLECT_WHOLE_OBJECT,
            ERR_UNKNOWN_EXPR_NODE,
            ERR_COMPUTED_TYPE_MISMATCH,
            ERR_DERIVED_FIELD_NO_READ_SOURCE,
            ERR_BAD_ATTR_FILTER,
            ERR_BAD_ATTR_VALUE,
        ] {
            assert!(
                codes.contains_key(code),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }

    #[test]
    fn identifiers_are_plain() {
        assert!(is_identifier("fn_1"));
        assert!(!is_identifier("1fn"));
        assert!(!is_identifier("a b"));
    }
}
