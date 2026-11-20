//! Relationship validation: the M:N slim-vocabulary rules (`validateRelationships`),
//! `@cardinality: one` reference resolution (`validateOneSideReferenceResolution`) and
//! junction pairing (`validateM2MJunctionPairing`), in the reference's order.
//!
//! References are read as bound targets: the package a reference resolves in is that of
//! the top-level node that physically declares the attribute (ADR-0059 R3/R7), so an
//! inherited reference keeps the meaning it had where it was written.

use std::collections::HashSet;

use serde_json::Value;

use super::refs::did_you_mean_hint;
use super::util::{ObjectIndex, error_at};
use super::{Ctx, Findings};
use crate::errors::{ERR_BAD_ATTR_VALUE, MetaError};
use crate::loader::{resolved_source, split_child_tail};
use crate::node::{NodeId, Tree};

pub const ERR_INVALID_RELATIONSHIP: &str = "ERR_INVALID_RELATIONSHIP";

const TYPE_OBJECT: &str = "object";
const TYPE_IDENTITY: &str = "identity";
const TYPE_RELATIONSHIP: &str = "relationship";
const TYPE_SOURCE: &str = "source";
const SUB_ENTITY: &str = "entity";
const SUB_REFERENCE: &str = "reference";
const SUB_RDB: &str = "rdb";
const ATTR_THROUGH: &str = "through";
const ATTR_SOURCE_REF_FIELD: &str = "sourceRefField";
const ATTR_SYMMETRIC: &str = "symmetric";
const ATTR_CARDINALITY: &str = "cardinality";
const ATTR_OBJECT_REF: &str = "objectRef";
const ATTR_REFERENCES: &str = "references";
const ATTR_FIELDS: &str = "fields";
const ATTR_KIND: &str = "kind";
const CARDINALITY_ONE: &str = "one";
const CARDINALITY_MANY: &str = "many";
/// Source kinds that are read-only (a view-like source); `table` is the writable default.
const READ_ONLY_KINDS: &[&str] = &["view", "materializedView", "storedProc", "tableFunction"];
/// Suffixes stripped from a candidate's name/FK field when building pairing keys, in order.
const PAIRING_SUFFIXES: &[&str] = &["reference", "ref", "id", "key"];

fn str_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    tree.attr(id, name).and_then(Value::as_str)
}

fn nonempty_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    str_attr(tree, id, name).filter(|s| !s.is_empty())
}

/// The root's top-level objects, in order.
fn objects(tree: &Tree, root: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    tree.own_children(root)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_OBJECT)
}

/// An object's effective relationships.
fn relationships(tree: &Tree, obj: NodeId) -> Vec<NodeId> {
    tree.children(obj)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_RELATIONSHIP)
        .collect()
}

/// An object's effective `identity.reference` children.
fn reference_identities(tree: &Tree, obj: NodeId) -> Vec<NodeId> {
    tree.children(obj)
        .iter()
        .copied()
        .filter(|&c| {
            let n = tree.node(c);
            n.type_name == TYPE_IDENTITY && n.sub_type == SUB_REFERENCE
        })
        .collect()
}

/// The `@fields` of an identity, as written (non-strings dropped, a scalar reads as none).
fn identity_fields(tree: &Tree, id: NodeId) -> Vec<&str> {
    match tree.attr(id, ATTR_FIELDS) {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    }
}

/// The FK column a reference is anchored on (its first field).
fn fk_field(tree: &Tree, r: NodeId) -> Option<&str> {
    identity_fields(tree, r).first().copied()
}

fn parent_of(tree: &Tree, rel: NodeId) -> NodeId {
    tree.node(rel).parent.unwrap_or(rel)
}

fn rel_label(tree: &Tree, entity: NodeId, rel: NodeId) -> String {
    format!("{}.{}", tree.node(entity).name, tree.node(rel).name)
}

/// `validateRelationships`: rule (d) M:N-only attributes on a non-M:N relationship,
/// then (b) symmetric xor sourceRefField, (a) symmetric is self-join-only, (c) the
/// junction is one entity declaring exactly two references. Each declaration is checked
/// once, against the entity that declares it.
pub fn validate_relationships(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let objs = ctx.objects;
    let mut checked: HashSet<NodeId> = HashSet::new();
    for obj in objects(tree, ctx.root) {
        for rel in relationships(tree, obj) {
            if !checked.insert(rel) {
                continue;
            }
            check_relationship(tree, objs, rel, out);
        }
    }
}

fn check_relationship(tree: &Tree, objs: &ObjectIndex, rel: NodeId, out: &mut Findings) {
    let declaring = parent_of(tree, rel);
    let referrer_pkg = tree.effective_package(declaring);
    let label = rel_label(tree, declaring, rel);
    // ADR-0039: resolving: a relationship may inherit its M:N attributes via extends.
    let through = nonempty_attr(tree, rel, ATTR_THROUGH);
    let source_ref_field = nonempty_attr(tree, rel, ATTR_SOURCE_REF_FIELD);
    let symmetric = tree.attr(rel, ATTR_SYMMETRIC) == Some(&Value::Bool(true));
    let cardinality = str_attr(tree, rel, ATTR_CARDINALITY);
    let object_ref = tree.attr(rel, ATTR_OBJECT_REF);
    let is_m2m = through.is_some() && cardinality == Some(CARDINALITY_MANY);

    if !is_m2m {
        if through.is_some() {
            out.errors.push(error_at(
                tree,
                rel,
                ERR_INVALID_RELATIONSHIP,
                format!("relationship \"{label}\" sets @{ATTR_THROUGH} but is not a M:N relationship (requires @{ATTR_CARDINALITY}: \"{CARDINALITY_MANY}\")."),
            ));
        }
        if source_ref_field.is_some() && cardinality != Some(CARDINALITY_ONE) {
            out.errors.push(error_at(
                tree,
                rel,
                ERR_INVALID_RELATIONSHIP,
                format!("relationship \"{label}\" sets @{ATTR_SOURCE_REF_FIELD} but is neither a M:N relationship (requires @{ATTR_THROUGH} with @{ATTR_CARDINALITY}: \"{CARDINALITY_MANY}\") nor a @{ATTR_CARDINALITY}: \"{CARDINALITY_ONE}\" relationship."),
            ));
        }
        if symmetric {
            out.errors.push(error_at(
                tree,
                rel,
                ERR_INVALID_RELATIONSHIP,
                format!(
                    "relationship \"{label}\" sets @{ATTR_SYMMETRIC} but is not a M:N relationship."
                ),
            ));
        }
        return;
    }
    let through = through.unwrap_or_default();

    if symmetric && source_ref_field.is_some() {
        out.errors.push(error_at(
            tree,
            rel,
            ERR_BAD_ATTR_VALUE,
            format!("relationship \"{label}\" sets both @{ATTR_SYMMETRIC} and @{ATTR_SOURCE_REF_FIELD}; they are mutually exclusive."),
        ));
    }

    // ADR-0042: compare node identity, never stripped short names.
    let is_self_join = object_ref
        .and_then(Value::as_str)
        .is_some_and(|r| objs.resolve(split_child_tail(r).0, &referrer_pkg) == Some(declaring));
    if symmetric && !is_self_join {
        let shown = object_ref.and_then(Value::as_str).unwrap_or("undefined");
        out.errors.push(error_at(
            tree,
            rel,
            ERR_BAD_ATTR_VALUE,
            format!("relationship \"{label}\" sets @{ATTR_SYMMETRIC} but @{ATTR_OBJECT_REF} \"{shown}\" is not the declaring entity \"{}\"; @{ATTR_SYMMETRIC} is self-join-only.", tree.node(declaring).name),
        ));
    }

    let Some(junction) = objs.resolve(split_child_tail(through).0, &referrer_pkg) else {
        let source = resolved_source(
            &tree.node(rel).source,
            format!("{}::{}", tree.node(declaring).fqn(), tree.node(rel).name),
            through.to_string(),
        );
        out.errors.push(MetaError::at(
            ERR_INVALID_RELATIONSHIP,
            format!(
                "relationship \"{label}\" @{ATTR_THROUGH} \"{through}\" does not resolve to an entity.{}",
                did_you_mean_hint(tree, ctx_root(tree, rel), through)
            ),
            source,
        ));
        return;
    };
    let jn = tree.node(junction);
    if jn.sub_type != SUB_ENTITY {
        out.errors.push(error_at(
            tree,
            rel,
            ERR_INVALID_RELATIONSHIP,
            format!("relationship \"{label}\" @{ATTR_THROUGH} \"{through}\" resolves to {}.{}, not an entity — a junction is a persisted join table and must be object.entity.", jn.type_name, jn.sub_type),
        ));
        return;
    }
    let refs = reference_identities(tree, junction);
    if refs.len() != 2 {
        out.errors.push(error_at(
            tree,
            rel,
            ERR_INVALID_RELATIONSHIP,
            format!("relationship \"{label}\" @{ATTR_THROUGH} \"{through}\" must declare exactly two identity.reference children (one per FK side); found {}.", refs.len()),
        ));
        return;
    }
    if let Some(declared) = source_ref_field {
        let fks: Vec<&str> = refs.iter().filter_map(|&r| fk_field(tree, r)).collect();
        if !fks.contains(&declared) {
            let available = if fks.is_empty() {
                "(none)".to_string()
            } else {
                fks.join(", ")
            };
            out.errors.push(error_at(
                tree,
                rel,
                ERR_INVALID_RELATIONSHIP,
                format!("relationship \"{label}\" @{ATTR_SOURCE_REF_FIELD} \"{declared}\" does not match any identity.reference FK field on junction \"{through}\". Available: {available}."),
            ));
        }
    }
}

/// The root node: the top of any node's parent chain.
fn ctx_root(tree: &Tree, mut id: NodeId) -> NodeId {
    while let Some(p) = tree.node(id).parent {
        id = p;
    }
    id
}

fn strip_one_suffix(value: &str) -> &str {
    for suffix in PAIRING_SUFFIXES {
        if value.len() > suffix.len() && value.ends_with(suffix) {
            return &value[..value.len() - suffix.len()];
        }
    }
    value
}

/// Does a reference answer to the (lowercased) relationship name: by its own name or
/// FK field, each with and without one stripped suffix.
fn pairs_with(tree: &Tree, r: NodeId, wanted: &str) -> bool {
    let name = tree.node(r).name.to_lowercase();
    let fk = fk_field(tree, r).map(str::to_lowercase);
    let hits = |v: &str| !v.is_empty() && (v == wanted || strip_one_suffix(v) == wanted);
    hits(&name) || fk.as_deref().is_some_and(hits)
}

/// `name(fkField)`, or `name(fieldA, fieldB)` for a composite reference. Display only.
fn format_candidates(tree: &Tree, candidates: &[NodeId]) -> String {
    candidates
        .iter()
        .map(|&c| {
            format!(
                "{}({})",
                tree.node(c).name,
                identity_fields(tree, c).join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Rule (e): a `@cardinality: one` relationship must resolve to exactly one
/// `identity.reference` of the entity (ADR-0029 section 5; #368). Checked against the
/// effective entity, so an inherited relationship made ambiguous by a subtype's second
/// reference is caught.
pub fn validate_one_side_reference_resolution(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let objs = ctx.objects;
    for obj in objects(tree, ctx.root) {
        let mut refs: Option<Vec<NodeId>> = None;
        for rel in relationships(tree, obj) {
            // ADR-0039: resolving: @cardinality/@objectRef may be inherited.
            if str_attr(tree, rel, ATTR_CARDINALITY) != Some(CARDINALITY_ONE) {
                continue;
            }
            let Some(object_ref) = nonempty_attr(tree, rel, ATTR_OBJECT_REF) else {
                continue;
            };
            // ADR-0059 R7: match by the bound target; an unresolved one has its own pass.
            let Some(target) = objs.ref_target(tree, rel, ATTR_OBJECT_REF) else {
                continue;
            };
            let refs = refs.get_or_insert_with(|| reference_identities(tree, obj));
            let candidates: Vec<NodeId> = refs
                .iter()
                .copied()
                .filter(|&r| fk_field(tree, r).is_some())
                .filter(|&r| objs.ref_target(tree, r, ATTR_REFERENCES) == Some(target))
                .collect();
            let name = &tree.node(obj).name;
            let rel_name = &tree.node(rel).name;
            if let Some(declared) = nonempty_attr(tree, rel, ATTR_SOURCE_REF_FIELD) {
                if candidates
                    .iter()
                    .any(|&c| fk_field(tree, c) == Some(declared))
                {
                    continue;
                }
                out.errors.push(error_at(
                    tree,
                    rel,
                    ERR_INVALID_RELATIONSHIP,
                    format!("relationship \"{name}.{rel_name}\" sets @{ATTR_SOURCE_REF_FIELD} \"{declared}\", which names no identity.reference targeting \"{object_ref}\". Candidates: {}.", format_candidates(tree, &candidates)),
                ));
                continue;
            }
            if candidates.len() <= 1 {
                continue;
            }
            let wanted = rel_name.to_lowercase();
            let paired = candidates
                .iter()
                .filter(|&&c| pairs_with(tree, c, &wanted))
                .count();
            if paired == 1 {
                continue;
            }
            out.errors.push(error_at(
                tree,
                rel,
                ERR_INVALID_RELATIONSHIP,
                format!("relationship \"{name}.{rel_name}\" is ambiguous: \"{name}\" declares {} identity.reference nodes targeting \"{object_ref}\" and the relationship name does not pair with exactly one. Candidates: {}. Set @{ATTR_SOURCE_REF_FIELD} to the FK field this relationship navigates.", candidates.len(), format_candidates(tree, &candidates)),
            ));
        }
    }
}

/// A projection: its own sources include a read-only one and no writable one.
fn is_projection_object(tree: &Tree, obj: NodeId) -> bool {
    let (mut read_only, mut writable) = (false, false);
    // ADR-0039: own: projection-ness is the entity's OWN declared source @kind.
    for &c in tree.own_children(obj) {
        let n = tree.node(c);
        if n.type_name != TYPE_SOURCE || n.sub_type != SUB_RDB {
            continue;
        }
        let kind = nonempty_attr(tree, c, ATTR_KIND).unwrap_or("table");
        if READ_ONLY_KINDS.contains(&kind) {
            read_only = true;
        } else {
            writable = true;
        }
    }
    read_only && !writable
}

/// The junction shape faults rule (d) already reports, so rule (f) stays silent on them.
fn junction_shape_owned_by_rule_d(
    tree: &Tree,
    objs: &ObjectIndex,
    rel: NodeId,
    referrer_pkg: &str,
) -> bool {
    let Some(through) = nonempty_attr(tree, rel, ATTR_THROUGH) else {
        return true;
    };
    let Some(junction) = objs.resolve(split_child_tail(through).0, referrer_pkg) else {
        return true;
    };
    if tree.node(junction).sub_type != SUB_ENTITY {
        return true;
    }
    let refs = reference_identities(tree, junction);
    if refs.len() != 2 {
        return true;
    }
    if let Some(declared) = nonempty_attr(tree, rel, ATTR_SOURCE_REF_FIELD) {
        return !refs.iter().any(|&r| fk_field(tree, r) == Some(declared));
    }
    false
}

/// `deriveM2MFields`: the failure message when the junction's two references cannot be
/// paired with the navigating entity `source` and the `@objectRef` target.
fn derive_m2m_failure(
    tree: &Tree,
    objs: &ObjectIndex,
    rel: NodeId,
    source: NodeId,
) -> Option<String> {
    let declaring = parent_of(tree, rel);
    let declaring = if tree.node(declaring).type_name == TYPE_OBJECT {
        declaring
    } else {
        source
    };
    let label = rel_label(tree, declaring, rel);
    let through = str_attr(tree, rel, ATTR_THROUGH)?;
    let Some(junction) = objs.ref_target(tree, rel, ATTR_THROUGH) else {
        return Some(format!(
            "relationship \"{label}\" @through \"{through}\" does not resolve to an entity"
        ));
    };
    let Some(target_name) = str_attr(tree, rel, ATTR_OBJECT_REF) else {
        return Some(format!(
            "relationship \"{label}\" is missing @objectRef (the M:N target)"
        ));
    };
    let refs = reference_identities(tree, junction);
    if refs.len() != 2 {
        return Some(format!(
            "junction \"{through}\" for relationship \"{label}\" must declare exactly two identity.reference children (found {})",
            refs.len()
        ));
    }
    let is_subject = |e: Option<NodeId>| e.is_some_and(|e| e == declaring || e == source);
    let target_node = objs.ref_target(tree, rel, ATTR_OBJECT_REF);
    let is_self_join = match target_node {
        Some(t) => is_subject(Some(t)),
        None => {
            let short = target_name.rsplit("::").next().unwrap_or(target_name);
            short == tree.node(declaring).name || short == tree.node(source).name
        }
    };
    let ref_entity = |r: NodeId| objs.ref_target(tree, r, ATTR_REFERENCES);
    if !is_self_join {
        let source_ref = refs.iter().copied().find(|&r| is_subject(ref_entity(r)));
        let target_ref =
            target_node.and_then(|t| refs.iter().copied().find(|&r| ref_entity(r) == Some(t)));
        let has_fk = |r: Option<NodeId>| r.is_some_and(|r| fk_field(tree, r).is_some());
        if !has_fk(source_ref) || !has_fk(target_ref) {
            let mut subjects = vec![tree.node(declaring).name.as_str()];
            if declaring != source && tree.node(declaring).name != tree.node(source).name {
                subjects.push(tree.node(source).name.as_str());
            }
            let subject = subjects
                .iter()
                .map(|n| format!("\"{n}\""))
                .collect::<Vec<_>>()
                .join(" or ");
            let short = target_name.rsplit("::").next().unwrap_or(target_name);
            return Some(format!(
                "junction \"{through}\" for relationship \"{label}\" must declare one identity.reference to {subject} and one to \"{short}\""
            ));
        }
        return None;
    }
    if tree.attr(rel, ATTR_SYMMETRIC) == Some(&Value::Bool(true)) {
        return refs.iter().any(|&r| fk_field(tree, r).is_none()).then(|| {
            format!(
                "symmetric junction \"{through}\" for \"{label}\" has a reference with no @fields"
            )
        });
    }
    let Some(declared) = nonempty_attr(tree, rel, ATTR_SOURCE_REF_FIELD) else {
        return Some(format!(
            "self-join relationship \"{label}\" through \"{through}\" is ambiguous: set @sourceRefField (directed) or @symmetric (undirected)"
        ));
    };
    let Some(source_ref) = refs
        .iter()
        .copied()
        .find(|&r| fk_field(tree, r) == Some(declared))
    else {
        return Some(format!(
            "@sourceRefField \"{declared}\" on \"{label}\" does not match any identity.reference FK field on junction \"{through}\""
        ));
    };
    let distinct = refs.iter().copied().find(|&r| r != source_ref);
    distinct
        .is_none_or(|r| fk_field(tree, r).is_none())
        .then(|| {
            format!("junction \"{through}\" for \"{label}\" has no distinct target-side reference")
        })
}

/// Rule (f): a M:N junction must pair: one reference resolving to the navigating entity,
/// one to the `@objectRef` target. Scope mirrors codegen: each concrete, non-projection
/// object against its effective relationships, not deduped by declaration.
pub fn validate_m2m_junction_pairing(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let objs = ctx.objects;
    for obj in objects(tree, ctx.root) {
        if tree.node(obj).is_abstract || is_projection_object(tree, obj) {
            continue;
        }
        for rel in relationships(tree, obj) {
            if str_attr(tree, rel, ATTR_CARDINALITY) != Some(CARDINALITY_MANY)
                || tree.attr(rel, ATTR_THROUGH).is_none()
            {
                continue;
            }
            let Some(message) = derive_m2m_failure(tree, objs, rel, obj) else {
                continue;
            };
            let declaring = parent_of(tree, rel);
            let referrer_pkg = tree.effective_package(declaring);
            if junction_shape_owned_by_rule_d(tree, objs, rel, &referrer_pkg) {
                continue;
            }
            let name = &tree.node(obj).name;
            out.errors.push(error_at(
                tree,
                rel,
                ERR_INVALID_RELATIONSHIP,
                format!("relationship \"{name}.{}\" cannot be resolved through its @{ATTR_THROUGH} junction: {message}. Without a reference to \"{name}\" the junction rows cannot be filtered to this entity, so no traversal is derivable.", tree.node(rel).name),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_in_the_shared_catalogue() {
        let raw = include_str!("../../data/ERROR-CODES.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for code in [ERR_INVALID_RELATIONSHIP, ERR_BAD_ATTR_VALUE] {
            assert!(
                codes.contains_key(code),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }

    #[test]
    fn suffix_stripping_keeps_the_whole_word() {
        assert_eq!(strip_one_suffix("hometeamref"), "hometeam");
        assert_eq!(strip_one_suffix("ref"), "ref");
        assert_eq!(strip_one_suffix("teamid"), "team");
        assert_eq!(strip_one_suffix("team"), "team");
    }
}
