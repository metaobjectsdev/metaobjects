//! Prompt and requirement vocabulary checks: `template.*` payload references and
//! the retired-requirement link rules.
//!
//! `validateTemplatePayloadRefs` and `validateRetiredRequirementLinks` in the
//! TypeScript reference (`loader/validation-passes.ts`).

use std::collections::HashSet;

use serde_json::Value;

use super::util::{ObjectIndex, error_at};
use super::{Ctx, Findings};
use crate::errors::MetaError;
use crate::node::{NodeId, Tree};
use crate::source::ErrorSource;

pub const ERR_INVALID_TEMPLATE: &str = "ERR_INVALID_TEMPLATE";
pub const ERR_SUBTYPE_RULE_VIOLATION: &str = "ERR_SUBTYPE_RULE_VIOLATION";
pub const ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS: &str =
    "ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS";
pub const ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED: &str =
    "ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED";

const TYPE_TEMPLATE: &str = "template";
const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_SOURCE: &str = "source";
const TYPE_REQUIREMENT: &str = "requirement";
const SUBTYPE_OUTPUT: &str = "output";
const SUBTYPE_PROMPT: &str = "prompt";
const OBJECT_SUBTYPE_VALUE: &str = "value";
const OBJECT_SUBTYPE_PROJECTION: &str = "projection";
const FIELD_SUBTYPE_OBJECT: &str = "object";
const ATTR_KIND: &str = "kind";
const KIND_EMAIL: &str = "email";
const ATTR_SUBJECT_REF: &str = "subjectRef";
const ATTR_HTML_BODY_REF: &str = "htmlBodyRef";
const ATTR_TEXT_REF: &str = "textRef";
const ATTR_PAYLOAD_REF: &str = "payloadRef";
const ATTR_RESPONSE_REF: &str = "responseRef";
const ATTR_REQUIRED_SLOTS: &str = "requiredSlots";
const ATTR_OBJECT_REF: &str = "objectRef";
const ATTR_STATUS: &str = "status";
const ATTR_IMPLEMENTED_BY: &str = "implementedBy";
const ATTR_SUPERSEDED_BY: &str = "supersededBy";
const STATUS_RETIRED: &str = "retired";

/// A node's own package, else its file's, else empty (`node.package ?? node.fileDefaultPackage ?? ""`).
fn declared_package(tree: &Tree, id: NodeId) -> String {
    let n = tree.node(id);
    n.package
        .clone()
        .or_else(|| n.file_default_package.clone())
        .unwrap_or_default()
}

/// Every `template.*` node anywhere in the declaration tree, in document order.
fn all_templates(tree: &Tree, id: NodeId, out: &mut Vec<NodeId>) {
    // ADR-0039: own — structural walk over the PHYSICAL declaration tree collecting
    // every declared template.* node (each visited once at its declaration site).
    for &c in tree.own_children(id) {
        if tree.node(c).type_name == TYPE_TEMPLATE {
            out.push(c);
        }
        all_templates(tree, c, out);
    }
}

/// A template-level payload target is an `object.value` or a SOURCELESS
/// `object.projection` (#210, #248).
fn is_legal_payload_target(tree: &Tree, obj: NodeId) -> bool {
    match tree.node(obj).sub_type.as_str() {
        OBJECT_SUBTYPE_VALUE => true,
        // ADR-0039: resolving — a source anywhere in the extends chain binds the
        // projection to a backing store, which disqualifies it as a payload shape.
        OBJECT_SUBTYPE_PROJECTION => !tree
            .children(obj)
            .iter()
            .any(|&c| tree.node(c).type_name == TYPE_SOURCE),
        _ => false,
    }
}

/// Nested payload targets stay value-only (#210); `visited` is shared across the
/// whole pass so a bad nested target reachable from two templates reports once.
fn check_nested_value_only(
    ctx: &Ctx<'_>,
    index: &ObjectIndex,
    payload: NodeId,
    findings: &mut Findings,
    visited: &mut HashSet<NodeId>,
) {
    let tree = ctx.tree;
    if !visited.insert(payload) {
        return;
    }
    // ADR-0039: resolving — a payload shape may inherit fields via extends.
    for &field in tree.children(payload).iter() {
        let f = tree.node(field);
        if f.type_name != TYPE_FIELD || f.sub_type != FIELD_SUBTYPE_OBJECT {
            continue;
        }
        let Some(r) = tree
            .attr(field, ATTR_OBJECT_REF)
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty())
        else {
            continue;
        };
        // ADR-0042: a bare ref resolves in the DECLARING owner's package.
        let owner = f.parent.unwrap_or(payload);
        let Some(target) = index.resolve(r, &declared_package(tree, owner)) else {
            continue; // dangling: the @objectRef resolution check owns it
        };
        let t = tree.node(target);
        if t.sub_type != OBJECT_SUBTYPE_VALUE {
            findings.errors.push(error_at(
                tree,
                field,
                ERR_SUBTYPE_RULE_VIOLATION,
                format!(
                    "payload '{}' field '{}' @objectRef '{r}' resolves to {TYPE_OBJECT}.{} — a nested \
                     payload target must be an object.value (template-level refs may also target a \
                     sourceless object.projection, nested refs may not) (#210, ADR-0028, ADR-0044)",
                    tree.node(payload).fqn(),
                    f.name,
                    t.sub_type
                ),
            ));
            continue;
        }
        check_nested_value_only(ctx, index, target, findings, visited);
    }
}

fn resolved(tree: &Tree, id: NodeId, target: String) -> ErrorSource {
    let n = tree.node(id);
    ErrorSource::Resolved {
        files: n.source.files().to_vec(),
        json_path: n.source.json_path().unwrap_or("$").to_string(),
        referrer: n.fqn(),
        target,
    }
}

pub fn validate_template_payload_refs(ctx: &Ctx<'_>, findings: &mut Findings) {
    let tree = ctx.tree;
    let mut templates = Vec::new();
    all_templates(tree, ctx.root, &mut templates);
    if templates.is_empty() {
        return;
    }
    let index = ctx.objects;
    let mut nested_visited = HashSet::new();
    let has_string = |t: NodeId, name: &str| tree.attr(t, name).is_some_and(Value::is_string);
    for tmpl in templates {
        let node = tree.node(tmpl);
        let name = &node.name;
        let bad = |findings: &mut Findings, msg: String| {
            findings
                .errors
                .push(error_at(tree, tmpl, ERR_INVALID_TEMPLATE, msg));
        };
        // ADR-0039: resolving throughout — a template may inherit its refs via extends.
        match node.sub_type.as_str() {
            SUBTYPE_OUTPUT => {
                if tree.attr(tmpl, ATTR_KIND).and_then(Value::as_str) == Some(KIND_EMAIL) {
                    if !has_string(tmpl, ATTR_SUBJECT_REF) {
                        bad(
                            findings,
                            format!("template \"{name}\" @kind \"email\" requires @subjectRef"),
                        );
                    }
                    if !has_string(tmpl, ATTR_HTML_BODY_REF) {
                        bad(
                            findings,
                            format!("template \"{name}\" @kind \"email\" requires @htmlBodyRef"),
                        );
                    }
                } else if !has_string(tmpl, ATTR_TEXT_REF) {
                    bad(
                        findings,
                        format!("template \"{name}\" @kind \"document\" requires @textRef"),
                    );
                }
            }
            SUBTYPE_PROMPT => {
                if !has_string(tmpl, ATTR_TEXT_REF) {
                    bad(findings, format!("template \"{name}\" requires @textRef"));
                }
            }
            _ => {}
        }

        // ADR-0042: a bare ref resolves in the template's package.
        let referrer_pkg = declared_package(tree, tmpl);
        let Some(payload_ref) = tree.attr(tmpl, ATTR_PAYLOAD_REF).and_then(Value::as_str) else {
            continue; // absence is the required-attr schema check's
        };
        let payload = index
            .resolve(payload_ref, &referrer_pkg)
            .filter(|&p| is_legal_payload_target(tree, p));
        let Some(payload) = payload else {
            findings.errors.push(MetaError::at(
                ERR_INVALID_TEMPLATE,
                format!(
                    "template \"{name}\" @payloadRef \"{payload_ref}\" does not resolve to an \
                     object.value or sourceless object.projection at root"
                ),
                resolved(tree, tmpl, payload_ref.to_string()),
            ));
            continue;
        };
        check_nested_value_only(ctx, index, payload, findings, &mut nested_visited);
        if let Some(response_ref) = tree.attr(tmpl, ATTR_RESPONSE_REF).and_then(Value::as_str) {
            match index
                .resolve(response_ref, &referrer_pkg)
                .filter(|&p| is_legal_payload_target(tree, p))
            {
                None => findings.errors.push(MetaError::at(
                    ERR_INVALID_TEMPLATE,
                    format!(
                        "template \"{name}\" @responseRef \"{response_ref}\" does not resolve to an \
                         object.value or sourceless object.projection at root"
                    ),
                    resolved(tree, tmpl, response_ref.to_string()),
                )),
                Some(res) => {
                    check_nested_value_only(ctx, index, res, findings, &mut nested_visited);
                }
            }
        }
        let slots: Vec<&str> = match tree.attr(tmpl, ATTR_REQUIRED_SLOTS) {
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
            Some(Value::String(s)) => vec![s.as_str()],
            _ => Vec::new(),
        };
        if slots.is_empty() {
            continue;
        }
        let fields: Vec<&str> = tree
            .children(payload)
            .iter()
            .map(|&c| tree.node(c))
            .filter(|c| c.type_name == TYPE_FIELD)
            .map(|c| c.name.as_str())
            .collect();
        for slot in slots {
            if !fields.contains(&slot) {
                findings.errors.push(MetaError::at(
                    ERR_INVALID_TEMPLATE,
                    format!(
                        "template \"{name}\" @requiredSlots \"{slot}\" is not a field on payload \
                         \"{payload_ref}\". Available fields: {}",
                        fields.join(", ")
                    ),
                    resolved(tree, tmpl, format!("{payload_ref}.{slot}")),
                ));
            }
        }
    }
}

pub fn validate_retired_requirement_links(ctx: &Ctx<'_>, findings: &mut Findings) {
    walk_requirements(ctx.tree, ctx.root, findings);
}

fn walk_requirements(tree: &Tree, id: NodeId, findings: &mut Findings) {
    // ADR-0039: resolving — a requirement that inherits its status through `extends`
    // is judged on its EFFECTIVE status. Hierarchy is nesting, so any depth.
    for &child in tree.children(id).iter() {
        let n = tree.node(child);
        if n.type_name == TYPE_REQUIREMENT {
            let status = tree.attr(child, ATTR_STATUS);
            let retired = status.and_then(Value::as_str) == Some(STATUS_RETIRED);
            if retired && tree.attr(child, ATTR_IMPLEMENTED_BY).is_some() {
                findings.errors.push(error_at(
                    tree,
                    child,
                    ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS,
                    format!(
                        "requirement.{} \"{}\" is @status: {STATUS_RETIRED} and declares \
                         @{ATTR_IMPLEMENTED_BY}. A retired capability has no implementation — that is \
                         what retiring it means. Delete the attribute; if the nodes are still there, \
                         the capability is not retired. What used to implement it belongs in `notes`, \
                         and what REPLACED it in @{ATTR_SUPERSEDED_BY}.",
                        n.sub_type, n.name
                    ),
                ));
            }
            if !retired && tree.attr(child, ATTR_SUPERSEDED_BY).is_some() {
                let shown = match status {
                    None => "(absent)".to_string(),
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => v.to_string(),
                };
                findings.errors.push(error_at(
                    tree,
                    child,
                    ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED,
                    format!(
                        "requirement.{} \"{}\" declares @{ATTR_SUPERSEDED_BY} but its @{ATTR_STATUS} is \
                         \"{shown}\". That attribute names the requirement which REPLACED a withdrawn \
                         one, so it is legal only on @{ATTR_STATUS}: {STATUS_RETIRED}.",
                        n.sub_type, n.name
                    ),
                ));
            }
        }
        walk_requirements(tree, child, findings);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_in_the_shared_table() {
        let table: Value =
            serde_json::from_str(include_str!("../../data/ERROR-CODES.json")).unwrap();
        for code in [
            ERR_INVALID_TEMPLATE,
            ERR_SUBTYPE_RULE_VIOLATION,
            ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS,
            ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED,
        ] {
            assert!(
                table["codes"].get(code).is_some(),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }
}
