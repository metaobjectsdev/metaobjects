//! ADR-0066: the cross-node rules for operations and lifecycles.
//!
//! A port of the TypeScript reference (`loader/rules-validation.ts`, with the derivation
//! helpers of `core/transition/lifecycle.ts`). Every port implements the same rules with
//! the same message text; the `error-rules-*` and `rules-*` fixtures under
//! `fixtures/conformance/` are the contract, and the rule ids are the ones
//! `docs/features/business-rules.md` lists.
//!
//! One broken rule yields one error:
//!   - each error's source is the offending node: the transition, the enum field (L3),
//!     the entity (L2), the operation or the binding;
//!   - an operation whose `@inputRef` or `@outputRef` fails O1 is not checked further, and
//!     one whose target fails O2 or O3 is not checked for O4 or B1;
//!   - an error is reported once per (node, code), so a broken transition on an abstract
//!     base is reported once, not once per inheritor.
//!
//! ```text
//!  L1  ERR_TRANSITION_NOT_ON_ENTITY      a transition under an enum field not declared on an object.entity
//!  L2  ERR_TRANSITION_NOT_ON_ENTITY      a concrete entity with a lifecycle and a source, none writable
//!  L3  ERR_LIFECYCLE_NO_INITIAL          an enum field declaring transitions has no @default
//!  L4  ERR_TRANSITION_UNKNOWN_STATE      a @from or @to value is not one of the enum's @values
//!  L5  ERR_TRANSITION_NAME_COLLISION     a transition named create/get/list/update/delete, in any case
//!  L6  ERR_TRANSITION_NAME_COLLISION     two transitions of one entity share a name, without case
//!  L7  ERR_BAD_ATTR_VALUE                @condition names a field the entity lacks, or is not boolean
//!  L8  ERR_BAD_ATTR_VALUE                @from is empty
//!  L9  ERR_BAD_ATTR_VALUE                a lifecycle field is an array
//!  L10 ERR_LIFECYCLE_REDECLARED          an inherited lifecycle field redeclared without extending it
//!  P1  ERR_PERMISSION_PUBLIC_CONFLICT    @public: true with @permission (operation or transition)
//!  P2  ERR_BAD_ATTR_VALUE                @permission is not a dotted identifier path
//!  O0  ERR_TRANSITION_NAME_COLLISION     an operation named create/get/list/update/delete, in any case
//!  O6  ERR_TRANSITION_NAME_COLLISION     two operations of one package share a name, unless they are
//!                                        the same operation declared identically in two APIs
//!  O1  ERR_OPERATION_SHAPE               @inputRef is not an object.value; @outputRef is not an
//!                                        entity, projection or value
//!  O2  ERR_OPERATION_TARGET_UNRESOLVED   @objectRef is not an object.entity, or a command lists
//!                                        @transitions and no target is declared or derivable
//!  O3  ERR_OPERATION_TARGET_MISMATCH     a declared @objectRef disagrees with the derived target
//!  O4  ERR_OPERATION_UNKNOWN_TRANSITION  a @transitions name is not a transition of the target
//!  O5  ERR_BAD_ATTR_VALUE                an @errors code is not lower snake case, is listed twice,
//!                                        or is one the route answers itself
//!  B1  ERR_BINDING_PATH_MISMATCH         a binding.rest @path's placeholders are not the target's key
//!                                        fields (keyed) or are not empty (unkeyed)
//!  B2  ERR_BINDING_PATH_MISMATCH         two bindings of one API share a method and a path
//! ```
//!
//! Everything a lifecycle has beyond its transitions is derived, with no vocabulary of
//! its own: its states, its initial state and an operation's target entity. Reads are
//! resolving (ADR-0039): a transition declared on a base entity's field is a transition
//! of every entity that extends it. It is not a transition of an entity whose field merely
//! `extends` that field: a field extends another to share its values.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::errors::{ERR_BAD_ATTR_VALUE, MetaError};
use crate::loader::split_child_tail;
use crate::node::{NodeId, PACKAGE_SEP, Tree};
use crate::parser::{TYPE_FIELD, TYPE_OBJECT};
use crate::validate::field_expr::{condition_message, fields_by_name};
use crate::validate::{Ctx, Findings};

pub const ERR_TRANSITION_UNKNOWN_STATE: &str = "ERR_TRANSITION_UNKNOWN_STATE";
pub const ERR_TRANSITION_NOT_ON_ENTITY: &str = "ERR_TRANSITION_NOT_ON_ENTITY";
pub const ERR_LIFECYCLE_NO_INITIAL: &str = "ERR_LIFECYCLE_NO_INITIAL";
pub const ERR_LIFECYCLE_REDECLARED: &str = "ERR_LIFECYCLE_REDECLARED";
pub const ERR_TRANSITION_NAME_COLLISION: &str = "ERR_TRANSITION_NAME_COLLISION";
pub const ERR_OPERATION_SHAPE: &str = "ERR_OPERATION_SHAPE";
pub const ERR_OPERATION_TARGET_UNRESOLVED: &str = "ERR_OPERATION_TARGET_UNRESOLVED";
pub const ERR_OPERATION_TARGET_MISMATCH: &str = "ERR_OPERATION_TARGET_MISMATCH";
pub const ERR_OPERATION_UNKNOWN_TRANSITION: &str = "ERR_OPERATION_UNKNOWN_TRANSITION";
pub const ERR_PERMISSION_PUBLIC_CONFLICT: &str = "ERR_PERMISSION_PUBLIC_CONFLICT";
pub const ERR_BINDING_PATH_MISMATCH: &str = "ERR_BINDING_PATH_MISMATCH";

const T_API: &str = "api";
const T_OPERATION: &str = "operation";
const T_BINDING: &str = "binding";
const T_TRANSITION: &str = "transition";
const T_SOURCE: &str = "source";
const T_IDENTITY: &str = "identity";

const SUB_ENTITY: &str = "entity";
const SUB_PROJECTION: &str = "projection";
const SUB_VALUE: &str = "value";
const SUB_ENUM: &str = "enum";
const SUB_ACTION: &str = "action";
const SUB_COMMAND: &str = "command";
const SUB_QUERY: &str = "query";
const SUB_REST: &str = "rest";
const SUB_PRIMARY: &str = "primary";

const A_DEFAULT: &str = "default";
const A_VALUES: &str = "values";
const A_FROM: &str = "from";
const A_TO: &str = "to";
const A_CONDITION: &str = "condition";
const A_PERMISSION: &str = "permission";
const A_PUBLIC: &str = "public";
const A_ERRORS: &str = "errors";
const A_INPUT_REF: &str = "inputRef";
const A_OUTPUT_REF: &str = "outputRef";
const A_OBJECT_REF: &str = "objectRef";
const A_TRANSITIONS: &str = "transitions";
const A_MANY: &str = "many";
const A_METHOD: &str = "method";
const A_PATH: &str = "path";
const A_FIELDS: &str = "fields";
const A_KIND: &str = "kind";

const KIND_TABLE: &str = "table";
const READ_ONLY_KINDS: [&str; 4] = ["view", "materializedView", "storedProc", "tableFunction"];
const METHOD_POST: &str = "POST";
const METHOD_GET: &str = "GET";

/// Names a declared operation or a transition may not take: the derived CRUD verbs of
/// the same service.
const RESERVED_OPERATION_NAMES: [&str; 5] = ["create", "get", "list", "update", "delete"];

/// Wire error codes an operation's route answers on its own, so a body may not declare
/// them in `@errors`.
const RESERVED_ERROR_CODES: [&str; 11] = [
    "not_found",
    "forbidden",
    "invalid_transition",
    "transition_condition_failed",
    "state_managed",
    "validation",
    "invalid_json",
    "invalid_id",
    "method_not_allowed",
    "constraint_violation",
    "internal",
];

// ---- small helpers ------------------------------------------------------------------

/// A derived name is compared without case: a command, a permission constant or a file
/// named from it collides with another that differs only in case on a case-folding target.
fn is_reserved_name(name: &str) -> bool {
    RESERVED_OPERATION_NAMES.contains(&name.to_lowercase().as_str())
}

fn reserved_list() -> String {
    RESERVED_OPERATION_NAMES.join(", ")
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A declared `@permission`: identifiers joined by `.`, where a package prefix may use
/// `::` (the reference's `PERMISSION_NAME_PATTERN`).
fn is_permission_name(s: &str) -> bool {
    s.split(PACKAGE_SEP)
        .all(|part| part.split('.').all(is_identifier))
}

/// A declared business error code: lower snake case (the reference's
/// `BUSINESS_ERROR_CODE_PATTERN`).
fn is_business_error_code(s: &str) -> bool {
    let word = |w: &str| {
        !w.is_empty()
            && w.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    let mut words = s.split('_');
    words
        .next()
        .is_some_and(|first| first.starts_with(|c: char| c.is_ascii_lowercase()) && word(first))
        && words.all(word)
}

/// What each `{...}` of a path holds, in order.
fn placeholders(path: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let Some(len) = rest[open + 1..].find('}') else {
            break;
        };
        out.push(&rest[open + 1..open + 1 + len]);
        rest = &rest[open + len + 2..];
    }
    out
}

/// A path with every placeholder's name removed, so two routes that differ only in what
/// they call a placeholder compare equal.
fn route_shape(path: &str) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let Some(len) = rest[open + 1..].find('}') else {
            break;
        };
        out.push_str(&rest[..open]);
        out.push_str("{}");
        rest = &rest[open + len + 2..];
    }
    out.push_str(rest);
    out
}

fn quote_list<S: AsRef<str>>(xs: &[S]) -> String {
    xs.iter()
        .map(|x| format!("\"{}\"", x.as_ref()))
        .collect::<Vec<_>>()
        .join(", ")
}

fn sorted<'a>(xs: &[&'a str]) -> Vec<&'a str> {
    let mut v = xs.to_vec();
    v.sort_unstable();
    v
}

/// The distinct values, first occurrence first.
fn unique<'a>(xs: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let mut out: Vec<&str> = Vec::new();
    for x in xs {
        if !out.contains(&x) {
            out.push(x);
        }
    }
    out
}

/// `"Entity.field.transition"` for a transition, `"Api.operation"` for an operation. A
/// binding is unnamed, so its label is its operation's.
fn label(tree: &Tree, node: NodeId) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut cur = node;
    while let Some(parent) = tree.node(cur).parent {
        let name = tree.node(cur).name.as_str();
        if !name.is_empty() {
            parts.push(name);
        }
        cur = parent;
    }
    parts.reverse();
    parts.join(".")
}

/// A string-array attr read resolving; a bare string is one element.
fn string_list<'a>(tree: &'a Tree, node: NodeId, attr: &str) -> Vec<&'a str> {
    match tree.attr(node, attr) {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(s)) => vec![s.as_str()],
        _ => Vec::new(),
    }
}

fn str_attr<'a>(tree: &'a Tree, node: NodeId, attr: &str) -> Option<&'a str> {
    tree.attr(node, attr).and_then(Value::as_str)
}

fn is_true(tree: &Tree, node: NodeId, attr: &str) -> bool {
    tree.attr(node, attr) == Some(&Value::Bool(true))
}

fn is_a(tree: &Tree, node: NodeId, type_name: &str, sub_type: &str) -> bool {
    let n = tree.node(node);
    n.type_name == type_name && n.sub_type == sub_type
}

fn is_entity(tree: &Tree, node: NodeId) -> bool {
    is_a(tree, node, TYPE_OBJECT, SUB_ENTITY)
}

struct Sink<'a> {
    tree: &'a Tree,
    errors: Vec<MetaError>,
    seen: HashSet<(NodeId, &'static str)>,
}

impl Sink<'_> {
    fn add(&mut self, node: NodeId, code: &'static str, message: String) {
        if self.seen.insert((node, code)) {
            self.errors.push(MetaError::at(
                code,
                message,
                self.tree.node(node).source.clone(),
            ));
        }
    }
}

// ---- lifecycle and target derivation ------------------------------------------------

/// The `transition.action` children of a field, resolving.
fn transitions_of(tree: &Tree, field: NodeId) -> Vec<NodeId> {
    tree.children(field)
        .iter()
        .copied()
        .filter(|&c| is_a(tree, c, T_TRANSITION, SUB_ACTION))
        .collect()
}

/// An entity and every entity it extends, nearest first.
fn entity_lineage(tree: &Tree, entity: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    let mut cur = Some(entity);
    while let Some(e) = cur.filter(|e| !out.contains(e)) {
        out.push(e);
        cur = tree.node(e).super_node;
    }
    out
}

/// The transitions a field gives the entity whose lineage this is: those declared on a
/// field of the entity itself or of an entity it extends. A transition reached only
/// through the field's own `extends` of another entity's field is not one.
fn lifecycle_transitions_of(tree: &Tree, lineage: &[NodeId], field: NodeId) -> Vec<NodeId> {
    transitions_of(tree, field)
        .into_iter()
        .filter(|&t| {
            tree.node(t)
                .parent
                .and_then(|f| tree.node(f).parent)
                .is_some_and(|owner| lineage.contains(&owner))
        })
        .collect()
}

/// Every transition of an object, across all its lifecycles (its enum fields with at
/// least one transition), in effective field order. Only an `object.entity` has any.
fn entity_transitions(tree: &Tree, obj: NodeId) -> Vec<NodeId> {
    if !is_entity(tree, obj) {
        return Vec::new();
    }
    let lineage = entity_lineage(tree, obj);
    tree.children(obj)
        .iter()
        .copied()
        .filter(|&f| is_a(tree, f, TYPE_FIELD, SUB_ENUM))
        .flat_map(|f| lifecycle_transitions_of(tree, &lineage, f))
        .collect()
}

/// The primary key field names of an entity: its effective `identity.primary` `@fields`.
fn primary_key_fields(tree: &Tree, entity: NodeId) -> Vec<&str> {
    tree.children(entity)
        .iter()
        .copied()
        .find(|&c| is_a(tree, c, T_IDENTITY, SUB_PRIMARY))
        .map(|primary| string_list(tree, primary, A_FIELDS))
        .unwrap_or_default()
}

/// The package a node's references resolve in: its top-level node's effective package.
fn referrer_package_of(tree: &Tree, node: NodeId) -> String {
    tree.effective_package(tree.top_level_of(node))
}

/// Resolve an object reference written on `node` (owner part only).
fn resolve_object_on(ctx: &Ctx<'_>, node: NodeId, reference: &str) -> Option<NodeId> {
    ctx.objects.resolve(
        split_child_tail(reference).0,
        &referrer_package_of(ctx.tree, node),
    )
}

/// The object a member's `extends` names, and the member it names there. `id extends
/// PurchaseRequest.id` names `PurchaseRequest` even when that entity inherits `id` from
/// an abstract base, which is where the resolved super node physically lives.
fn extended_member<'a>(ctx: &Ctx<'a>, member: NodeId) -> Option<(NodeId, &'a str)> {
    let tree = ctx.tree;
    let node = tree.node(member);
    let reference = node.super_ref.as_deref()?;
    let sup = node.super_node?;
    let name = tree.node(sup).name.as_str();
    let (owner, tail) = split_child_tail(reference);
    if !tail.is_empty()
        && !owner.is_empty()
        && !owner.ends_with(PACKAGE_SEP)
        && let Some(named) = ctx
            .objects
            .resolve(owner, &referrer_package_of(tree, member))
    {
        return Some((named, name));
    }
    let parent = tree.node(sup).parent?;
    (tree.node(parent).type_name == TYPE_OBJECT).then_some((parent, name))
}

/// The entities whose whole primary key a value object borrows, once: every primary key
/// field of the entity is extended by exactly one field of the value. A value that
/// borrows part of a composite key, or one key field twice (`fromId` and `toId`), names
/// no single row of that entity, so it borrows nothing from it.
fn borrowed_key_entities(ctx: &Ctx<'_>, value: NodeId) -> Vec<NodeId> {
    let tree = ctx.tree;
    let mut counts: Vec<(NodeId, HashMap<&str, usize>)> = Vec::new();
    for &f in tree.children(value).iter() {
        if tree.node(f).type_name != TYPE_FIELD {
            continue;
        }
        let Some((owner, member)) = extended_member(ctx, f) else {
            continue;
        };
        if tree.node(owner).sub_type != SUB_ENTITY
            || !primary_key_fields(tree, owner).contains(&member)
        {
            continue;
        }
        let slot = match counts.iter().position(|(o, _)| *o == owner) {
            Some(i) => i,
            None => {
                counts.push((owner, HashMap::new()));
                counts.len() - 1
            }
        };
        *counts[slot].1.entry(member).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .filter(|(owner, members)| {
            primary_key_fields(tree, *owner)
                .iter()
                .all(|k| members.get(k) == Some(&1))
        })
        .map(|(owner, _)| owner)
        .collect()
}

/// The base entity of a projection: the entity its extended identity names, else the one
/// entity its extended fields name. `None` when there is none or more than one.
fn projection_base_entity(ctx: &Ctx<'_>, projection: NodeId) -> Option<NodeId> {
    let tree = ctx.tree;
    let kids = tree.children(projection);
    let entity_named_by = |member: NodeId| {
        extended_member(ctx, member)
            .map(|(owner, _)| owner)
            .filter(|&owner| tree.node(owner).sub_type == SUB_ENTITY)
    };
    if let Some(owner) = kids
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == T_IDENTITY)
        .find_map(entity_named_by)
    {
        return Some(owner);
    }
    let mut owners: Vec<NodeId> = Vec::new();
    for owner in kids
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_FIELD)
        .filter_map(entity_named_by)
    {
        if !owners.contains(&owner) {
            owners.push(owner);
        }
    }
    (owners.len() == 1).then(|| owners[0])
}

/// How an operation's target was derived.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Via {
    /// The input borrows the target's key.
    Input,
    Output,
}

/// The target entity derived from an operation's shapes:
///  1. the one entity whose whole primary key the `@inputRef` value borrows (by
///     `extends`), each key field once;
///  2. else the `@outputRef`: an entity is its own target, a projection its base entity.
///
/// Whole keys of two entities, part of a key, or one key field borrowed twice derive
/// nothing from the input.
fn derive_operation_target(ctx: &Ctx<'_>, op: NodeId) -> Option<(NodeId, Via)> {
    let tree = ctx.tree;
    if let Some(input) = str_attr(tree, op, A_INPUT_REF)
        .and_then(|r| resolve_object_on(ctx, op, r))
        .filter(|&i| tree.node(i).sub_type == SUB_VALUE)
    {
        let borrowed = borrowed_key_entities(ctx, input);
        if borrowed.len() == 1 {
            return Some((borrowed[0], Via::Input));
        }
    }
    let output = str_attr(tree, op, A_OUTPUT_REF).and_then(|r| resolve_object_on(ctx, op, r))?;
    match tree.node(output).sub_type.as_str() {
        SUB_ENTITY => Some((output, Via::Output)),
        SUB_PROJECTION => projection_base_entity(ctx, output).map(|base| (base, Via::Output)),
        _ => None,
    }
}

/// Whether the operation addresses one row of its target by key: its input borrows the
/// target's key, or it is a query with no input and no `@many` whose target comes from
/// its output (a get by key).
fn operation_is_keyed(ctx: &Ctx<'_>, op: NodeId, derived: Option<(NodeId, Via)>) -> bool {
    let tree = ctx.tree;
    match derived {
        None => false,
        Some((_, Via::Input)) => true,
        Some((_, Via::Output)) => {
            tree.node(op).sub_type == SUB_QUERY
                && str_attr(tree, op, A_INPUT_REF).is_none()
                && !is_true(tree, op, A_MANY)
        }
    }
}

// ---- the rules ----------------------------------------------------------------------

/// P1 and P2 for an operation or a transition.
fn check_permission(tree: &Tree, node: NodeId, sink: &mut Sink<'_>) {
    let n = tree.node(node);
    let permission = tree.attr(node, A_PERMISSION);
    if is_true(tree, node, A_PUBLIC) && permission.is_some() {
        sink.add(
            node,
            ERR_PERMISSION_PUBLIC_CONFLICT,
            format!(
                "{}.{} \"{}\" declares both @public: true and @permission; a public {} calls no permission check, so remove one.",
                n.type_name,
                n.sub_type,
                label(tree, node),
                n.type_name
            ),
        );
    }
    if let Some(Value::String(p)) = permission
        && !is_permission_name(p)
    {
        sink.add(
            node,
            ERR_BAD_ATTR_VALUE,
            format!(
                "{}.{} \"{}\" @permission \"{p}\" is not a dotted identifier path; use names of letters, digits and _ joined by \".\" (a package prefix may use \"::\"), such as \"purchasing.approve\".",
                n.type_name,
                n.sub_type,
                label(tree, node)
            ),
        );
    }
}

/// L1, L3, L4, L5, L7, L8, L9, P1 and P2 for the transitions declared on one field.
fn check_declared_transitions(ctx: &Ctx<'_>, field: NodeId, sink: &mut Sink<'_>) {
    let tree = ctx.tree;
    // ADR-0039: own — each transition is checked where it is declared.
    let declared: Vec<NodeId> = tree
        .own_children(field)
        .iter()
        .copied()
        .filter(|&c| is_a(tree, c, T_TRANSITION, SUB_ACTION))
        .collect();
    if declared.is_empty() {
        return;
    }
    let fnode = tree.node(field);
    let Some(owner) = fnode.parent.filter(|&o| is_entity(tree, o)) else {
        let place = match fnode.parent.map(|o| tree.node(o)) {
            Some(o) if o.type_name == TYPE_OBJECT => {
                format!("object.{} \"{}\"", o.sub_type, o.name)
            }
            _ => "the document root".to_string(),
        };
        for t in declared {
            sink.add(
                t,
                ERR_TRANSITION_NOT_ON_ENTITY,
                format!(
                    "transition.action \"{}\" is declared on a field of {place}; a lifecycle belongs to an object.entity with a writable source.",
                    label(tree, t)
                ),
            );
        }
        return;
    };
    if fnode.sub_type == SUB_ENUM && str_attr(tree, field, A_DEFAULT).is_none() {
        sink.add(
            field,
            ERR_LIFECYCLE_NO_INITIAL,
            format!(
                "field.enum \"{}\" declares transitions but no @default; its @default is the lifecycle's initial state.",
                label(tree, field)
            ),
        );
    }
    if tree.resolved_is_array(field) {
        sink.add(
            field,
            ERR_BAD_ATTR_VALUE,
            format!(
                "field.{} \"{}\" declares transitions but is an array (@isArray: true); a lifecycle's state is one value.",
                fnode.sub_type,
                label(tree, field)
            ),
        );
    }
    let states = unique(string_list(tree, field, A_VALUES));
    let mut owner_fields = None;
    for t in declared {
        check_permission(tree, t, sink);
        let from = string_list(tree, t, A_FROM);
        if from.is_empty() {
            sink.add(
                t,
                ERR_BAD_ATTR_VALUE,
                format!(
                    "transition.action \"{}\" @from is empty; name at least one state the transition leaves.",
                    label(tree, t)
                ),
            );
        }
        let unknown: Vec<&str> = unique(from.into_iter().chain(str_attr(tree, t, A_TO)))
            .into_iter()
            .filter(|s| !states.contains(s))
            .collect();
        if !unknown.is_empty() {
            sink.add(
                t,
                ERR_TRANSITION_UNKNOWN_STATE,
                format!(
                    "transition.action \"{}\" names {}, which {} of \"{}\" @values ({}).",
                    label(tree, t),
                    quote_list(&unknown),
                    if unknown.len() == 1 {
                        "is not a member"
                    } else {
                        "are not members"
                    },
                    fnode.name,
                    quote_list(&states)
                ),
            );
        }
        let name = &tree.node(t).name;
        if is_reserved_name(name) {
            sink.add(
                t,
                ERR_TRANSITION_NAME_COLLISION,
                format!(
                    "transition.action \"{}\" is named \"{name}\", which is a derived CRUD verb ({}); rename it.",
                    label(tree, t),
                    reserved_list()
                ),
            );
        }
        if let Some(condition) = tree.attr(t, A_CONDITION) {
            let fields = owner_fields.get_or_insert_with(|| fields_by_name(ctx, owner));
            let opening = format!("transition.action \"{}\" @condition", label(tree, t));
            if let Some(message) =
                condition_message(ctx, condition, &tree.node(owner).name, fields, &opening)
            {
                sink.add(t, ERR_BAD_ATTR_VALUE, message);
            }
        }
    }
}

/// L10: an entity's field named like an ancestor's lifecycle field that does not carry
/// that lifecycle's transitions. Redeclaring the field replaces it, so the base's state
/// machine would silently stop applying to this entity.
fn check_redeclared_lifecycles(
    tree: &Tree,
    entity: NodeId,
    lineage: &[NodeId],
    sink: &mut Sink<'_>,
) {
    for (depth, &ancestor) in lineage.iter().enumerate().skip(1) {
        // ADR-0039: own — the lifecycle fields the ancestor itself declares.
        for &base_field in tree.own_children(ancestor) {
            if tree.node(base_field).type_name != TYPE_FIELD {
                continue;
            }
            let base_transitions = lifecycle_transitions_of(tree, &lineage[depth..], base_field);
            if base_transitions.is_empty() {
                continue;
            }
            let base_name = &tree.node(base_field).name;
            let Some(field) = tree.children(entity).iter().copied().find(|&c| {
                let n = tree.node(c);
                n.type_name == TYPE_FIELD && n.name == *base_name
            }) else {
                continue;
            };
            if field == base_field {
                continue;
            }
            let kept = lifecycle_transitions_of(tree, lineage, field);
            if base_transitions.iter().all(|t| kept.contains(t)) {
                continue;
            }
            sink.add(
                field,
                ERR_LIFECYCLE_REDECLARED,
                format!(
                    "field.{} \"{}\" redeclares \"{}\", which has a lifecycle, and drops its transitions; extend it (\"extends\": \"{}.{base_name}\") or give the field another name.",
                    tree.node(field).sub_type,
                    label(tree, field),
                    label(tree, base_field),
                    tree.node(ancestor).name
                ),
            );
        }
    }
}

/// A source that is not one of the read-only kinds; `table` is the default.
fn is_writable_source(tree: &Tree, node: NodeId) -> bool {
    tree.node(node).type_name == T_SOURCE && {
        let kind = str_attr(tree, node, A_KIND)
            .filter(|k| !k.is_empty())
            .unwrap_or(KIND_TABLE);
        !READ_ONLY_KINDS.contains(&kind)
    }
}

/// L2, L6 and L10 for one entity, over its effective (inherited) lifecycles.
fn check_entity_lifecycles(tree: &Tree, entity: NodeId, sink: &mut Sink<'_>) {
    check_redeclared_lifecycles(tree, entity, &entity_lineage(tree, entity), sink);
    let transitions = entity_transitions(tree, entity);
    if transitions.is_empty() {
        return;
    }
    let enode = tree.node(entity);
    let mut by_name: HashMap<String, NodeId> = HashMap::new();
    for &t in &transitions {
        match by_name.get(&tree.node(t).name.to_lowercase()) {
            None => {
                by_name.insert(tree.node(t).name.to_lowercase(), t);
            }
            Some(&first) if first != t => sink.add(
                t,
                ERR_TRANSITION_NAME_COLLISION,
                format!(
                    "transition.action \"{}\" has the same name as \"{}\" (names are compared without case); the transitions of \"{}\" share one namespace (each may derive a command), so rename one.",
                    label(tree, t),
                    label(tree, first),
                    enode.name
                ),
            ),
            Some(_) => {}
        }
    }
    let kids = tree.children(entity);
    // A lifecycle is live once the entity declares or inherits a source. With no source
    // at all it loads and is inert, like everything else on a sourceless entity.
    let live = kids.iter().any(|&c| tree.node(c).type_name == T_SOURCE);
    if !enode.is_abstract && live && !kids.iter().any(|&c| is_writable_source(tree, c)) {
        let fields = unique(transitions.iter().map(|&t| {
            tree.node(t)
                .parent
                .map_or("", |f| tree.node(f).name.as_str())
        }));
        sink.add(
            entity,
            ERR_TRANSITION_NOT_ON_ENTITY,
            format!(
                "object.entity \"{}\" has a lifecycle (transitions on {}) and a source, but no writable one; a transition is a guarded update of a stored row. (An entity with no source at all may carry a lifecycle: it is inert until a source is added.)",
                enode.name,
                quote_list(&fields)
            ),
        );
    }
}

/// The `binding.rest` children an operation declares that carry a `@path`.
fn declared_paths(tree: &Tree, op: NodeId) -> Vec<(NodeId, &str)> {
    // ADR-0039: own — a binding is checked on the operation that declares it.
    tree.own_children(op)
        .iter()
        .copied()
        .filter(|&b| is_a(tree, b, T_BINDING, SUB_REST))
        .filter_map(|b| str_attr(tree, b, A_PATH).map(|path| (b, path)))
        .collect()
}

/// O0 to O5, P1, P2 and B1 for one operation.
fn check_operation(ctx: &Ctx<'_>, op: NodeId, sink: &mut Sink<'_>) {
    let tree = ctx.tree;
    let onode = tree.node(op);
    let sub = onode.sub_type.as_str();
    let op_label = label(tree, op);
    if is_reserved_name(&onode.name) {
        sink.add(
            op,
            ERR_TRANSITION_NAME_COLLISION,
            format!(
                "operation.{sub} \"{op_label}\" is named \"{}\", which is a derived CRUD verb ({}); rename it.",
                onode.name,
                reserved_list()
            ),
        );
    }
    check_permission(tree, op, sink);

    // O5 — the business errors.
    let codes = string_list(tree, op, A_ERRORS);
    let bad: Vec<&str> = codes
        .iter()
        .copied()
        .filter(|c| !is_business_error_code(c))
        .collect();
    let dup = unique(
        codes
            .iter()
            .enumerate()
            .filter(|&(i, c)| codes.iter().position(|x| x == c) != Some(i))
            .map(|(_, c)| *c),
    );
    let reserved = unique(
        codes
            .iter()
            .copied()
            .filter(|c| RESERVED_ERROR_CODES.contains(c)),
    );
    let why = if !bad.is_empty() {
        let one = bad.len() == 1;
        Some(format!(
            "{} {} lower snake case code{}",
            quote_list(&bad),
            if one { "is not a" } else { "are not" },
            if one { "" } else { "s" }
        ))
    } else if !dup.is_empty() {
        Some(format!(
            "{} {} listed twice",
            quote_list(&dup),
            if dup.len() == 1 { "is" } else { "are" }
        ))
    } else if !reserved.is_empty() {
        Some(format!(
            "{} {} the route answers itself ({})",
            quote_list(&reserved),
            if reserved.len() == 1 {
                "is a code"
            } else {
                "are codes"
            },
            RESERVED_ERROR_CODES.join(", ")
        ))
    } else {
        None
    };
    if let Some(why) = why {
        sink.add(
            op,
            ERR_BAD_ATTR_VALUE,
            format!("operation.{sub} \"{op_label}\" @errors: {why}."),
        );
    }

    // O1 — shapes.
    let found = |target: Option<NodeId>| match target {
        None => "names no object".to_string(),
        Some(t) => format!("is an object.{}", tree.node(t).sub_type),
    };
    if let Some(input_ref) = str_attr(tree, op, A_INPUT_REF) {
        let input = resolve_object_on(ctx, op, input_ref);
        if input.is_none_or(|i| tree.node(i).sub_type != SUB_VALUE) {
            sink.add(
                op,
                ERR_OPERATION_SHAPE,
                format!(
                    "operation.{sub} \"{op_label}\" @inputRef \"{input_ref}\" {}; an operation's input is an object.value.",
                    found(input)
                ),
            );
            return;
        }
    }
    if let Some(output_ref) = str_attr(tree, op, A_OUTPUT_REF) {
        let output = resolve_object_on(ctx, op, output_ref);
        let legal = output.is_some_and(|o| {
            [SUB_ENTITY, SUB_PROJECTION, SUB_VALUE].contains(&tree.node(o).sub_type.as_str())
        });
        if !legal {
            sink.add(
                op,
                ERR_OPERATION_SHAPE,
                format!(
                    "operation.{sub} \"{op_label}\" @outputRef \"{output_ref}\" {}; an operation returns an object.entity, object.projection or object.value.",
                    found(output)
                ),
            );
            return;
        }
    }

    // O2, O3 — the target.
    let derived = derive_operation_target(ctx, op);
    let mut target = derived.map(|(entity, _)| entity);
    if let Some(object_ref) = str_attr(tree, op, A_OBJECT_REF) {
        let declared = resolve_object_on(ctx, op, object_ref);
        let Some(declared) = declared.filter(|&d| tree.node(d).sub_type == SUB_ENTITY) else {
            sink.add(
                op,
                ERR_OPERATION_TARGET_UNRESOLVED,
                format!(
                    "operation.{sub} \"{op_label}\" @objectRef \"{object_ref}\" {}; an operation acts on an object.entity.",
                    found(declared)
                ),
            );
            return;
        };
        if let Some(derived) = target.filter(|&d| d != declared) {
            sink.add(
                op,
                ERR_OPERATION_TARGET_MISMATCH,
                format!(
                    "operation.{sub} \"{op_label}\" @objectRef names \"{}\", but its input and output derive \"{}\"; remove @objectRef or make them agree.",
                    tree.node(declared).name,
                    tree.node(derived).name
                ),
            );
            return;
        }
        target = Some(declared);
    }
    let transitions = if sub == SUB_COMMAND {
        string_list(tree, op, A_TRANSITIONS)
    } else {
        Vec::new()
    };
    if !transitions.is_empty() && target.is_none() {
        sink.add(
            op,
            ERR_OPERATION_TARGET_UNRESOLVED,
            format!(
                "operation.command \"{op_label}\" lists @transitions but has no target entity: the @inputRef does not borrow one entity's whole primary key (each key field extended exactly once), no @outputRef has a base entity, and there is no @objectRef."
            ),
        );
        return;
    }

    // O4 — the transitions it may make.
    if let Some(target) = target.filter(|_| !transitions.is_empty()) {
        let known: Vec<&str> = entity_transitions(tree, target)
            .into_iter()
            .map(|t| tree.node(t).name.as_str())
            .collect();
        let unknown: Vec<&str> = unique(transitions)
            .into_iter()
            .filter(|n| !known.contains(n))
            .collect();
        if !unknown.is_empty() {
            sink.add(
                op,
                ERR_OPERATION_UNKNOWN_TRANSITION,
                format!(
                    "operation.command \"{op_label}\" @transitions names {}, which {} of \"{}\".",
                    quote_list(&unknown),
                    if unknown.len() == 1 {
                        "is not a transition"
                    } else {
                        "are not transitions"
                    },
                    tree.node(target).name
                ),
            );
        }
    }

    // B1 — binding paths.
    for (binding, path) in declared_paths(tree, op) {
        let found = placeholders(path);
        let expected = match target {
            Some(t) if operation_is_keyed(ctx, op, derived) => primary_key_fields(tree, t),
            _ => Vec::new(),
        };
        if sorted(&found) == sorted(&expected) {
            continue;
        }
        let takes = match target {
            Some(t) if !expected.is_empty() => format!(
                "\"{op_label}\" addresses one \"{}\" by key, so its path takes exactly [{}].",
                tree.node(t).name,
                quote_list(&expected)
            ),
            _ => format!("\"{op_label}\" addresses no row by key, so its path takes none."),
        };
        sink.add(
            binding,
            ERR_BINDING_PATH_MISMATCH,
            format!(
                "binding.rest on \"{}\" @path \"{path}\" has placeholders [{}]; {takes}",
                label(tree, binding),
                quote_list(&found)
            ),
        );
    }
}

/// Whether two attr values as written are the same value. A list or a map is never the
/// same as another (the reference compares them by identity), so two operations that
/// both carry a malformed value are not declared identically.
fn same_written(a: &Value, b: &Value) -> bool {
    !a.is_array() && !a.is_object() && a == b
}

/// A reference attr's identity: the node it resolves to, else the value as written.
enum RefIdentity<'a> {
    Node(NodeId),
    Raw(&'a Value),
    Absent,
}

impl PartialEq for RefIdentity<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Node(a), Self::Node(b)) => a == b,
            (Self::Raw(a), Self::Raw(b)) => same_written(a, b),
            (Self::Absent, Self::Absent) => true,
            _ => false,
        }
    }
}

fn ref_identity<'a>(ctx: &Ctx<'a>, op: NodeId, attr: &str) -> RefIdentity<'a> {
    match ctx.tree.attr(op, attr) {
        None => RefIdentity::Absent,
        Some(v) => v
            .as_str()
            .and_then(|r| resolve_object_on(ctx, op, r))
            .map_or(RefIdentity::Raw(v), RefIdentity::Node),
    }
}

/// A list attr as a set, for comparison.
fn set_of<'a>(tree: &'a Tree, op: NodeId, attr: &str) -> Vec<&'a str> {
    sorted(&unique(string_list(tree, op, attr)))
}

/// Whether two operations of one package in different APIs are one operation exposed
/// twice, as a versioned API beside its successor does (ADR-0067: one router per API, one
/// service): the same name and subtype, and the same contract. The contract is every
/// operation attribute: the referenced shapes (compared by the node they resolve to), the
/// transitions and errors (as sets), the permission, public and many. Bindings are per
/// API and are not compared.
fn same_operation(ctx: &Ctx<'_>, a: NodeId, b: NodeId) -> bool {
    let tree = ctx.tree;
    let (na, nb) = (tree.node(a), tree.node(b));
    na.name == nb.name
        && na.sub_type == nb.sub_type
        && [A_INPUT_REF, A_OUTPUT_REF, A_OBJECT_REF]
            .iter()
            .all(|attr| ref_identity(ctx, a, attr) == ref_identity(ctx, b, attr))
        && [A_TRANSITIONS, A_ERRORS]
            .iter()
            .all(|attr| set_of(tree, a, attr) == set_of(tree, b, attr))
        && match (tree.attr(a, A_PERMISSION), tree.attr(b, A_PERMISSION)) {
            (None, None) => true,
            (Some(x), Some(y)) => same_written(x, y),
            _ => false,
        }
        && is_true(tree, a, A_PUBLIC) == is_true(tree, b, A_PUBLIC)
        && is_true(tree, a, A_MANY) == is_true(tree, b, A_MANY)
}

/// B2 across the operations of one API.
fn check_api_routes(tree: &Tree, ops: &[NodeId], sink: &mut Sink<'_>) {
    let mut by_route: HashMap<String, NodeId> = HashMap::new();
    for &op in ops {
        for (binding, path) in declared_paths(tree, op) {
            // The effective method: the declared one, else the derived (ADR-0066).
            let method = str_attr(tree, binding, A_METHOD).unwrap_or(
                if tree.node(op).sub_type == SUB_COMMAND {
                    METHOD_POST
                } else {
                    METHOD_GET
                },
            );
            let route = format!("{method} {}", route_shape(path));
            match by_route.get(&route) {
                None => {
                    by_route.insert(route, binding);
                }
                Some(&other) => sink.add(
                    binding,
                    ERR_BINDING_PATH_MISMATCH,
                    format!(
                        "binding.rest on \"{}\" declares {method} \"{path}\", the same route as the binding on \"{}\"; two operations cannot share a method and path.",
                        label(tree, binding),
                        label(tree, other)
                    ),
                ),
            }
        }
    }
}

/// The rules pass. Runs after the reference-bearing validation, where the reference runs it.
pub fn validate_rules(ctx: &Ctx<'_>, f: &mut Findings) {
    let tree = ctx.tree;
    let mut sink = Sink {
        tree,
        errors: Vec::new(),
        seen: HashSet::new(),
    };
    let mut any_transition = false;
    // ADR-0039: own — a structural walk over the declarations themselves: every field
    // declared at the root and on every object. A root extends nothing, so its own
    // children are its children.
    let top_level = tree.own_children(ctx.root);
    for &top in top_level {
        let fields: &[NodeId] = match tree.node(top).type_name.as_str() {
            TYPE_FIELD => &[top],
            TYPE_OBJECT => tree.own_children(top),
            _ => &[],
        };
        for &field in fields {
            if tree.node(field).type_name != TYPE_FIELD {
                continue;
            }
            // ADR-0039: own — the same declared-here walk as check_declared_transitions.
            any_transition |= tree
                .own_children(field)
                .iter()
                .any(|&c| tree.node(c).type_name == T_TRANSITION);
            check_declared_transitions(ctx, field, &mut sink);
        }
    }
    // An entity has a lifecycle only when some field of some object declares a
    // transition, so a model with none (most of them) skips the per-entity walk.
    if any_transition {
        for &obj in top_level {
            if is_entity(tree, obj) {
                check_entity_lifecycles(tree, obj, &mut sink);
            }
        }
    }
    // O6 — keyed by package, then by the name without case.
    let mut by_name: HashMap<(String, String), NodeId> = HashMap::new();
    for &api in top_level {
        if tree.node(api).type_name != T_API {
            continue;
        }
        let ops: Vec<NodeId> = tree
            .children(api)
            .iter()
            .copied()
            .filter(|&c| tree.node(c).type_name == T_OPERATION)
            .collect();
        for &op in &ops {
            check_operation(ctx, op, &mut sink);
        }
        let package = tree.effective_package(api);
        for &op in &ops {
            let key = (package.clone(), tree.node(op).name.to_lowercase());
            match by_name.get(&key) {
                None => {
                    by_name.insert(key, op);
                }
                Some(&first) if first != op && !same_operation(ctx, first, op) => sink.add(
                    op,
                    ERR_TRANSITION_NAME_COLLISION,
                    format!(
                        "operation.{} \"{}\" has the same name as \"{}\" (names are compared without case) and is not the same operation; the operations of package \"{package}\" share one namespace (each derives the permission name <package>.<operation>), so rename one, or declare both identically to expose one operation in two APIs.",
                        tree.node(op).sub_type,
                        label(tree, op),
                        label(tree, first)
                    ),
                ),
                Some(_) => {}
            }
        }
        check_api_routes(tree, &ops, &mut sink);
    }
    f.errors.extend(sink.errors);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_in_the_catalogue() {
        let raw = include_str!("../../../../../fixtures/conformance/ERROR-CODES.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for c in [
            ERR_TRANSITION_UNKNOWN_STATE,
            ERR_TRANSITION_NOT_ON_ENTITY,
            ERR_LIFECYCLE_NO_INITIAL,
            ERR_LIFECYCLE_REDECLARED,
            ERR_TRANSITION_NAME_COLLISION,
            ERR_OPERATION_SHAPE,
            ERR_OPERATION_TARGET_UNRESOLVED,
            ERR_OPERATION_TARGET_MISMATCH,
            ERR_OPERATION_UNKNOWN_TRANSITION,
            ERR_PERMISSION_PUBLIC_CONFLICT,
            ERR_BINDING_PATH_MISMATCH,
            ERR_BAD_ATTR_VALUE,
        ] {
            assert!(codes.contains_key(c), "{c}");
        }
    }

    #[test]
    fn a_written_list_or_map_is_never_the_same_value_as_another() {
        let s = |v: &str| Value::String(v.to_string());
        assert!(same_written(
            &s("purchasing.approve"),
            &s("purchasing.approve")
        ));
        assert!(!same_written(
            &s("purchasing.approve"),
            &s("purchasing.decide")
        ));
        assert!(same_written(&Value::Bool(true), &Value::Bool(true)));
        let list = serde_json::json!(["a"]);
        assert!(!same_written(&list, &list.clone()));
        let map = serde_json::json!({ "a": 1 });
        assert!(!same_written(&map, &map.clone()));
    }

    #[test]
    fn permission_names_are_dotted_identifier_paths() {
        for ok in [
            "approve",
            "purchasing.approve",
            "_a.b_1",
            "acme::purchasing.PurchaseRequest.submit",
        ] {
            assert!(is_permission_name(ok), "{ok}");
        }
        for bad in [
            "",
            "purchasing.",
            ".approve",
            "a..b",
            "a b",
            "a/b",
            "1a",
            "a:b",
            "a:::b",
            "a::",
            "a-b",
            "a\n",
        ] {
            assert!(!is_permission_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn business_error_codes_are_lower_snake_case() {
        for ok in ["over_budget", "a", "a1_2b", "insufficient_funds"] {
            assert!(is_business_error_code(ok), "{ok}");
        }
        for bad in [
            "",
            "OverBudget",
            "over-budget",
            "_a",
            "a_",
            "a__b",
            "1a",
            "over budget",
        ] {
            assert!(!is_business_error_code(bad), "{bad:?}");
        }
    }

    #[test]
    fn placeholders_and_route_shapes() {
        assert_eq!(placeholders("/requests/{id}/decision"), vec!["id"]);
        assert_eq!(placeholders("/a/{x}/b/{y}"), vec!["x", "y"]);
        assert_eq!(placeholders("/plain"), Vec::<&str>::new());
        assert_eq!(placeholders("/a/{}"), vec![""]);
        assert_eq!(placeholders("/a/{open"), Vec::<&str>::new());
        assert_eq!(route_shape("/a/{x}/b/{y}"), "/a/{}/b/{}");
        assert_eq!(route_shape("/a/{open"), "/a/{open");
        assert_eq!(route_shape("/plain"), "/plain");
    }
}
