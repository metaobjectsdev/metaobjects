//! `runRegisteredValidation`: validation derived from the type registry.
//!
//! Each node's `TypeDefinition` carries reference descriptors (an attribute that
//! names another node, and the code to report when it does not resolve). One walk
//! over a symbol table built once. The reference's per-type imperative `validate`
//! hook is unused by core (an extension point for downstream providers), so the
//! Rust registry has no equivalent; only descriptors are honoured.

use std::collections::HashMap;

use crate::errors::{ERR_BAD_ATTR_VALUE, ERR_UNKNOWN};
use crate::loader::owner_candidate_keys;
use crate::node::{NodeId, Tree};
use crate::registry::{ReferenceDescriptor, TypeDefinition};
use crate::validate::structure::preorder;
use crate::validate::util::error_at;
use crate::validate::{Ctx, Findings};

pub const ERR_INVALID_RELATIONSHIP: &str = "ERR_INVALID_RELATIONSHIP";
pub const ERR_INVALID_REFERENCE: &str = "ERR_INVALID_REFERENCE";
pub const ERR_UNRESOLVED_OBJECT_REF: &str = "ERR_UNRESOLVED_OBJECT_REF";

const TYPE_OBJECT: &str = "object";

/// The shared code a descriptor names. Codes are `&'static str`; a descriptor that
/// names one this port does not know reports `ERR_UNKNOWN` rather than guess.
fn descriptor_code(code: &str) -> &'static str {
    match code {
        ERR_INVALID_RELATIONSHIP => ERR_INVALID_RELATIONSHIP,
        ERR_INVALID_REFERENCE => ERR_INVALID_REFERENCE,
        ERR_UNRESOLVED_OBJECT_REF => ERR_UNRESOLVED_OBJECT_REF,
        ERR_BAD_ATTR_VALUE => ERR_BAD_ATTR_VALUE,
        _ => ERR_UNKNOWN,
    }
}

/// A node's package as the reference resolver sees it: its own, else its file's.
fn effective_package_of(tree: &Tree, id: NodeId) -> &str {
    let n = tree.node(id);
    n.package
        .as_deref()
        .or(n.file_default_package.as_deref())
        .unwrap_or("")
}

/// ADR-0059 R3: a reference resolves in the package of the top-level node that
/// physically declares the attribute, which for an inherited one is the ancestor.
fn referrer_package_for<'a>(tree: &'a Tree, node: NodeId, attr: &str) -> &'a str {
    let mut declarer = Some(node);
    let mut hops = 0;
    // ADR-0039: own: locating the layer that physically declares the attribute.
    while let Some(d) = declarer {
        if tree.own_attr(d, attr).is_some() || hops > tree.len() {
            break;
        }
        hops += 1;
        declarer = tree.node(d).super_node;
    }
    effective_package_of(tree, tree.top_level_of(declarer.unwrap_or(node)))
}

/// Every top-level node, by type then resolution key (ADR-0042: no short-name fallback).
struct Symbols {
    by_type: HashMap<String, HashMap<String, NodeId>>,
}

impl Symbols {
    fn build(tree: &Tree, root: NodeId) -> Self {
        let mut by_type: HashMap<String, HashMap<String, NodeId>> = HashMap::new();
        for &c in tree.children(root).iter() {
            by_type
                .entry(tree.node(c).type_name.clone())
                .or_default()
                .insert(tree.resolution_key(c), c);
        }
        Self { by_type }
    }

    fn resolve(&self, type_name: &str, keys: &[String]) -> Option<NodeId> {
        let bucket = self.by_type.get(type_name)?;
        keys.iter().find_map(|k| bucket.get(k).copied())
    }
}

/// Same-short-name objects in other packages, to append to an unresolved-object message.
pub(super) fn did_you_mean_hint(tree: &Tree, root: NodeId, r: &str) -> String {
    let (owner, _) = crate::loader::split_child_tail(r);
    let short = owner.rsplit("::").next().unwrap_or(owner);
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
        " An object named \"{short}\" exists in: {}. Qualify it with its package (FQN).",
        candidates.join(", ")
    )
}

fn check_descriptor(
    ctx: &Ctx<'_>,
    symbols: &Symbols,
    node: NodeId,
    desc: &ReferenceDescriptor,
    out: &mut Findings,
) {
    let tree = ctx.tree;
    // ADR-0039: resolving: a reference attribute may be inherited through extends.
    let Some(raw) = tree
        .attr(node, &desc.attr)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    else {
        return; // absence is the required-attribute pass's job
    };
    let entity_ref = if desc.dotted_field_path {
        raw.split('.').next().unwrap_or(raw)
    } else {
        raw
    };
    let ref_pkg = referrer_package_for(tree, node, &desc.attr);
    let n = tree.node(node);
    let Ok(keys) = owner_candidate_keys(entity_ref, ref_pkg) else {
        out.errors.push(error_at(
            tree,
            node,
            ERR_BAD_ATTR_VALUE,
            format!(
                "{}.{} \"{}\" @{} \"{raw}\" climbs above the root package — each '..::' drops one segment of the declaring package.",
                n.type_name, n.sub_type, n.name, desc.attr
            ),
        ));
        return;
    };
    if symbols.resolve(&desc.target_type, &keys).is_some() {
        return;
    }
    let qname = match n.parent.map(|p| tree.node(p).name.as_str()) {
        Some(p) if !p.is_empty() => format!("{p}.{}", n.name),
        _ => n.name.clone(),
    };
    let is_object = desc.target_type == TYPE_OBJECT;
    let want = if is_object {
        "an object".to_string()
    } else {
        format!("a {}", desc.target_type)
    };
    let hint = if is_object {
        did_you_mean_hint(tree, ctx.root, entity_ref)
    } else {
        String::new()
    };
    out.errors.push(error_at(
        tree,
        node,
        descriptor_code(&desc.error_code),
        format!(
            "{}.{} \"{qname}\" @{} \"{raw}\" does not resolve to {want}.{hint}",
            n.type_name, n.sub_type, desc.attr
        ),
    ));
}

/// Run every registered reference descriptor over the tree.
pub fn registered_validation(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let symbols = Symbols::build(tree, ctx.root);
    let mut defs: HashMap<(&str, &str), Option<&TypeDefinition>> = HashMap::new();
    for id in preorder(tree, ctx.root) {
        let n = tree.node(id);
        let def = *defs
            .entry((n.type_name.as_str(), n.sub_type.as_str()))
            .or_insert_with(|| ctx.registry.find(&n.type_name, &n.sub_type));
        let Some(def) = def else { continue };
        for desc in &def.references {
            check_descriptor(ctx, &symbols, id, desc, out);
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
        for code in [
            ERR_INVALID_RELATIONSHIP,
            ERR_INVALID_REFERENCE,
            ERR_UNRESOLVED_OBJECT_REF,
        ] {
            assert!(
                codes.contains_key(code),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }
}
