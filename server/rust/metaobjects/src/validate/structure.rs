//! Structural validation: subtype rules, `maxOccurs`, projection identity
//! pass-through, identity sequences and TPH discriminators.
//!
//! Ports of `subtype-rules.ts`, `validate-max-occurs.ts`,
//! `core/identity/validate-identity-passthrough.ts`, `validateIdentitySequence`
//! (`loader/validation-passes.ts`) and `core/object/validate-discriminator.ts`.

use std::collections::HashMap;

use serde_json::Value;

use crate::errors::{MetaError, WARN_LEGACY};
use crate::json::{js_display, js_number};
use crate::node::{NodeId, Tree};
use crate::source::ErrorSource;
use crate::validate::util::error_at;
use crate::validate::{Ctx, Findings};

pub const ERR_IDENTITY_NAME_REQUIRED: &str = "ERR_IDENTITY_NAME_REQUIRED";
pub const ERR_SUBTYPE_RULE_VIOLATION: &str = "ERR_SUBTYPE_RULE_VIOLATION";
pub const ERR_PROJECTION_INHERITED_SOURCE: &str = "ERR_PROJECTION_INHERITED_SOURCE";
pub const ERR_PROJECTION_SOURCE_WRITABLE: &str = "ERR_PROJECTION_SOURCE_WRITABLE";
pub const ERR_TOO_MANY_OCCURRENCES: &str = "ERR_TOO_MANY_OCCURRENCES";
pub const ERR_PROJECTION_IDENTITY_NOT_EXTENDED: &str = "ERR_PROJECTION_IDENTITY_NOT_EXTENDED";
pub const ERR_IDENTITY_KEY_MISMATCH: &str = "ERR_IDENTITY_KEY_MISMATCH";
pub const ERR_SEQUENCE_WITHOUT_INCREMENT: &str = "ERR_SEQUENCE_WITHOUT_INCREMENT";
pub const ERR_SEQUENCE_START_OUT_OF_RANGE: &str = "ERR_SEQUENCE_START_OUT_OF_RANGE";
pub const ERR_DISCRIMINATOR_FIELD_NOT_FOUND: &str = "ERR_DISCRIMINATOR_FIELD_NOT_FOUND";
pub const ERR_DISCRIMINATOR_VALUE_DUPLICATE: &str = "ERR_DISCRIMINATOR_VALUE_DUPLICATE";
pub const ERR_DISCRIMINATOR_VALUE_MISSING: &str = "ERR_DISCRIMINATOR_VALUE_MISSING";
pub const ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH: &str = "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH";

const TYPE_OBJECT: &str = "object";
const TYPE_IDENTITY: &str = "identity";
const TYPE_SOURCE: &str = "source";
const TYPE_FIELD: &str = "field";
const SUB_ENTITY: &str = "entity";
const SUB_VALUE: &str = "value";
const SUB_PROJECTION: &str = "projection";
const SUB_PRIMARY: &str = "primary";
const SUB_REFERENCE: &str = "reference";
const ATTR_FIELDS: &str = "fields";
const ATTR_ENFORCE: &str = "enforce";
const ATTR_KIND: &str = "kind";
const ATTR_GENERATION: &str = "generation";
const ATTR_SEQUENCE_START: &str = "sequenceStart";
const ATTR_SEQUENCE_NAME: &str = "sequenceName";
const ATTR_DISCRIMINATOR: &str = "discriminator";
const ATTR_DISCRIMINATOR_VALUE: &str = "discriminatorValue";
const ATTR_VALUES: &str = "values";
const DEFAULT_SOURCE_KIND: &str = "table";
const READ_ONLY_KINDS: &[&str] = &["view", "materializedView", "storedProc", "tableFunction"];
const GENERATION_INCREMENT: &str = "increment";
const SEQUENCE_INT_MAX: f64 = 2_147_483_647.0;

/// Every node under `root` (the root included), each once where it is declared,
/// parents before children: the shape of the reference's structural walks.
pub(super) fn preorder(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::with_capacity(tree.len());
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        out.push(id);
        // ADR-0039: own: a structural walk visits every physical node once at its site.
        stack.extend(tree.own_children(id).iter().rev().copied());
    }
    out
}

fn is(tree: &Tree, id: NodeId, type_name: &str, sub_type: &str) -> bool {
    let n = tree.node(id);
    n.type_name == type_name && n.sub_type == sub_type
}

fn is_type(tree: &Tree, id: NodeId, type_name: &str) -> bool {
    tree.node(id).type_name == type_name
}

/// The effective `@kind` of a source node (resolving; `table` when unset).
fn effective_kind(tree: &Tree, id: NodeId) -> &str {
    match tree.attr(id, ATTR_KIND) {
        Some(Value::String(s)) if !s.is_empty() => s,
        _ => DEFAULT_SOURCE_KIND,
    }
}

// ---- subtype rules ---------------------------------------------------------

/// `validateSubtypeRules`: value purity, entity identity, projection licensing and
/// named identities. Warnings are the reference's legacy strings.
pub fn subtype_rules(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for id in preorder(tree, ctx.root) {
        let node = tree.node(id);
        if node.type_name == TYPE_IDENTITY && node.name.is_empty() {
            let owner = node.parent.map(|p| tree.node(p).fqn());
            let at = match owner.as_deref() {
                Some(o) if !o.is_empty() => format!(" under '{o}'"),
                _ => String::new(),
            };
            out.errors.push(error_at(
                tree,
                id,
                ERR_IDENTITY_NAME_REQUIRED,
                format!(
                    "identity.{}{at} has no name — identity nodes require an author-chosen name (e.g. \"id\") so dotted extends refs can address them (FR-024)",
                    node.sub_type
                ),
            ));
        }
        if node.type_name == TYPE_OBJECT {
            match node.sub_type.as_str() {
                SUB_VALUE => value_purity(tree, id, out),
                SUB_ENTITY => entity_identity(tree, id, out),
                SUB_PROJECTION => projection_licensing(tree, id, out),
                _ => {}
            }
        }
    }
}

fn value_purity(tree: &Tree, id: NodeId, out: &mut Findings) {
    let fqn = tree.node(id).fqn();
    for &child in tree.children(id).iter() {
        let c = tree.node(child);
        if c.type_name == TYPE_IDENTITY {
            if c.sub_type == SUB_REFERENCE {
                // ADR-0046: a navigation-only reference is the sanctioned exception.
                if tree.attr(child, ATTR_ENFORCE) == Some(&Value::Bool(false)) {
                    continue;
                }
                out.errors.push(error_at(
                    tree,
                    child,
                    ERR_SUBTYPE_RULE_VIOLATION,
                    format!(
                        "value object '{fqn}' has an enforced reference (identity.{} '{}') — a value is not persisted and has no table to hold a physical FK; declare a navigation-only reference with @enforce: false (FR-024, ADR-0028, ADR-0046)",
                        c.sub_type, c.name
                    ),
                ));
                continue;
            }
            out.errors.push(error_at(
                tree,
                child,
                ERR_SUBTYPE_RULE_VIOLATION,
                format!(
                    "value object '{fqn}' must not have an identity (identity.{} '{}') — value objects are pure data shapes; use subType: \"entity\" for records with identity (FR-024, ADR-0028)",
                    c.sub_type, c.name
                ),
            ));
        } else if c.type_name == TYPE_SOURCE {
            out.errors.push(error_at(
                tree,
                child,
                ERR_SUBTYPE_RULE_VIOLATION,
                format!(
                    "value object '{fqn}' must not have a source (source.{}) — value objects are not persisted shapes; use subType: \"entity\" or \"projection\" for stored objects (FR-024, ADR-0028)",
                    c.sub_type
                ),
            ));
        }
    }
}

fn entity_identity(tree: &Tree, id: NodeId, out: &mut Findings) {
    let node = tree.node(id);
    if node.is_abstract {
        return;
    }
    let has_primary = tree
        .children(id)
        .iter()
        .any(|&c| is(tree, c, TYPE_IDENTITY, SUB_PRIMARY));
    if !has_primary {
        out.warnings.push(MetaError::at(
            WARN_LEGACY,
            format!(
                "entity object '{}' has no primary identity (add an identity child or mark @isAbstract: true)",
                node.fqn()
            ),
            ErrorSource::Code,
        ));
    }
}

fn projection_licensing(tree: &Tree, id: NodeId, out: &mut Findings) {
    let node = tree.node(id);
    let fqn = node.fqn();
    let sup = node.super_node;
    if let Some(s) = sup
        && !is(tree, s, TYPE_OBJECT, SUB_PROJECTION)
    {
        let sn = tree.node(s);
        out.errors.push(error_at(
            tree,
            id,
            ERR_SUBTYPE_RULE_VIOLATION,
            format!(
                "projection '{fqn}' extends '{}' which is {}.{} — a projection may only extend another projection (FR-024, ADR-0028)",
                sn.fqn(),
                sn.type_name,
                sn.sub_type
            ),
        ));
    }
    let super_is_legal = sup.is_none_or(|s| is(tree, s, TYPE_OBJECT, SUB_PROJECTION));
    if !node.is_abstract && super_is_legal {
        // ADR-0039: own: the count of sources the projection declares itself, against
        // the effective count, finds the ones it inherits.
        let own_count = tree
            .own_children(id)
            .iter()
            .filter(|&&c| is_type(tree, c, TYPE_SOURCE))
            .count();
        let effective = tree.children(id);
        let mut sources = effective.iter().filter(|&&c| is_type(tree, c, TYPE_SOURCE));
        let total = sources.clone().count();
        if total > own_count {
            let sub = sources
                .nth(own_count)
                .map_or(node.sub_type.as_str(), |&s| tree.node(s).sub_type.as_str());
            out.errors.push(error_at(
                tree,
                id,
                ERR_PROJECTION_INHERITED_SOURCE,
                format!(
                    "projection '{fqn}' inherits a source (source.{sub}) through extends instead of declaring its own — a projection's extends is shape lineage, not a shared-storage hierarchy. Declare the source on this projection; an abstract projection base carries shape only (FR-024, ADR-0028)"
                ),
            ));
        }
    }
    // ADR-0039: own: OWN sources only; an inherited source is validated where declared.
    for &child in tree.own_children(id) {
        if !is_type(tree, child, TYPE_SOURCE) {
            continue;
        }
        let kind = effective_kind(tree, child);
        if !READ_ONLY_KINDS.contains(&kind) {
            out.errors.push(error_at(
                tree,
                child,
                ERR_PROJECTION_SOURCE_WRITABLE,
                format!(
                    "projection '{fqn}' has a writable source (@kind \"{kind}\") — a projection is a derived read-only representation; its sources must be read-only kinds (view, materializedView, storedProc, tableFunction) (FR-024, ADR-0028)"
                ),
            ));
        }
    }
}

// ---- maxOccurs ---------------------------------------------------------------

/// `validateMaxOccurs`: a type's `maxOccurs` against the children one node declares.
pub fn max_occurs(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let mut limits: HashMap<(&str, &str), Option<i64>> = HashMap::new();
    for id in preorder(tree, ctx.root) {
        // ADR-0039: own: maxOccurs constrains the declared layer; inherited children
        // were counted at their declaring parent.
        let children = tree.own_children(id);
        if children.len() < 2 {
            // One child exceeds only a limit of zero, which no type declares.
            continue;
        }
        let mut groups: Vec<((&str, &str), Vec<NodeId>)> = Vec::new();
        let mut index: HashMap<(&str, &str), usize> = HashMap::new();
        for &c in children {
            let n = tree.node(c);
            let key = (n.type_name.as_str(), n.sub_type.as_str());
            match index.get(&key) {
                Some(&i) => groups[i].1.push(c),
                None => {
                    index.insert(key, groups.len());
                    groups.push((key, vec![c]));
                }
            }
        }
        for ((t, s), group) in groups {
            let max = *limits
                .entry((t, s))
                .or_insert_with(|| ctx.registry.find(t, s).and_then(|d| d.max_occurs));
            let Some(max) = max else { continue };
            let Ok(limit) = usize::try_from(max) else {
                continue;
            };
            if group.len() > limit {
                let name = &tree.node(id).name;
                let owner = if name.is_empty() {
                    String::new()
                } else {
                    format!(" under '{name}'")
                };
                out.errors.push(error_at(
                    tree,
                    group[limit],
                    ERR_TOO_MANY_OCCURRENCES,
                    format!(
                        "{t}.{s} appears {} times{owner} but at most {max} is allowed",
                        group.len()
                    ),
                ));
            }
        }
    }
}

// ---- projection identity pass-through ---------------------------------------

/// An identity's `@fields` as a list: an array, or a comma string.
fn normalize_fields(raw: Option<&Value>) -> Option<Vec<String>> {
    match raw? {
        Value::Array(items) => Some(
            items
                .iter()
                .map(|v| js_display(v).trim().to_string())
                .collect(),
        ),
        Value::String(s) => Some(
            s.split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect(),
        ),
        _ => None,
    }
}

fn extends_chain_reaches(tree: &Tree, node: NodeId, target: NodeId) -> bool {
    let mut cur = tree.node(node).super_node;
    let mut hops = 0;
    while let Some(c) = cur {
        if c == target {
            return true;
        }
        hops += 1;
        if hops > tree.len() {
            return false;
        }
        cur = tree.node(c).super_node;
    }
    false
}

struct Passthrough {
    entity: NodeId,
    computed: Vec<String>,
    missing: Vec<String>,
}

fn resolve_passthrough(tree: &Tree, identity: NodeId) -> Option<Passthrough> {
    let extended = tree.node(identity).super_node?;
    if !is_type(tree, extended, TYPE_IDENTITY) {
        return None;
    }
    let entity = tree.node(extended).parent?;
    if !is_type(tree, entity, TYPE_OBJECT) {
        return None;
    }
    let owner = tree.node(identity).parent?;
    let extended_fields = normalize_fields(tree.attr(extended, ATTR_FIELDS)).unwrap_or_default();
    let entity_children = tree.children(entity);
    let mut computed = Vec::new();
    let mut missing = Vec::new();
    for name in extended_fields {
        let Some(entity_field) = entity_children
            .iter()
            .copied()
            .find(|&c| is_type(tree, c, TYPE_FIELD) && tree.node(c).name == name)
        else {
            missing.push(name);
            continue;
        };
        // ADR-0039: own: a pass-through field must be declared on the projection itself.
        let local = tree.own_children(owner).iter().copied().find(|&c| {
            is_type(tree, c, TYPE_FIELD) && extends_chain_reaches(tree, c, entity_field)
        });
        match local {
            Some(l) => computed.push(tree.node(l).name.clone()),
            None => missing.push(name),
        }
    }
    Some(Passthrough {
        entity,
        computed,
        missing,
    })
}

/// `validateIdentityPassthrough` (FR-024 B3).
pub fn identity_passthrough(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for &obj in tree.children(ctx.root).iter() {
        if !is(tree, obj, TYPE_OBJECT, SUB_PROJECTION) {
            continue;
        }
        let obj_name = &tree.node(obj).name;
        // ADR-0039: own: the projection's own identities are the pass-through subjects.
        for &identity in tree.own_children(obj) {
            if !is_type(tree, identity, TYPE_IDENTITY) {
                continue;
            }
            let iname = &tree.node(identity).name;
            if tree.node(identity).super_ref.is_none() {
                out.errors.push(error_at(
                    tree,
                    identity,
                    ERR_PROJECTION_IDENTITY_NOT_EXTENDED,
                    format!(
                        "identity '{iname}' on projection '{obj_name}' must extend an entity identity (e.g. extends: \"Customer.id\") — a projection identity is a pass-through (FR-024)"
                    ),
                ));
                continue;
            }
            // An unresolved or non-identity target was reported by super resolution.
            let Some(res) = resolve_passthrough(tree, identity) else {
                continue;
            };
            if !res.missing.is_empty() {
                let entity = &tree.node(res.entity).name;
                let refs: Vec<String> = res
                    .missing
                    .iter()
                    .map(|f| format!("'{entity}.{f}'"))
                    .collect();
                out.errors.push(error_at(
                    tree,
                    identity,
                    ERR_IDENTITY_KEY_MISMATCH,
                    format!(
                        "identity '{iname}' on projection '{obj_name}' does not correspond to its extended identity: no local field extends {} — every field of the extended identity needs a pass-through field on the projection (FR-024)",
                        refs.join(", ")
                    ),
                ));
                continue;
            }
            // ADR-0039: own: an explicit own @fields is compared with the computed key.
            let explicit = normalize_fields(
                tree.own_attr(identity, ATTR_FIELDS)
                    .map(|a| &a.value)
                    .filter(|v| !v.is_null()),
            );
            if let Some(explicit) = explicit
                && explicit != res.computed
            {
                out.errors.push(error_at(
                    tree,
                    identity,
                    ERR_IDENTITY_KEY_MISMATCH,
                    format!(
                        "identity '{iname}' on projection '{obj_name}' declares @fields [{}] but the computed pass-through key is [{}] — omit @fields (it is derived) or make them agree (FR-024)",
                        explicit.join(", "),
                        res.computed.join(", ")
                    ),
                ));
            }
        }
    }
}

// ---- identity sequence --------------------------------------------------------

fn own_declared(tree: &Tree, id: NodeId, name: &str) -> bool {
    tree.own_attr(id, name).is_some_and(|a| !a.value.is_null())
}

/// `validateIdentitySequence`: `@sequenceStart` / `@sequenceName` only on an
/// `increment` key, and the start inside the key's range.
pub fn identity_sequence(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for &obj in tree.children(ctx.root).iter() {
        if !is_type(tree, obj, TYPE_OBJECT) {
            continue;
        }
        let obj_name = &tree.node(obj).name;
        // ADR-0039: own: reported on the identity that declares the attribute.
        for &id in tree.own_children(obj) {
            if !is(tree, id, TYPE_IDENTITY, SUB_PRIMARY) {
                continue;
            }
            let declared: Vec<&str> = [ATTR_SEQUENCE_START, ATTR_SEQUENCE_NAME]
                .into_iter()
                .filter(|a| own_declared(tree, id, a))
                .collect();
            if declared.is_empty() {
                continue;
            }
            let iname = &tree.node(id).name;
            let generation = tree.attr(id, ATTR_GENERATION);
            if generation == Some(&Value::String(GENERATION_INCREMENT.into())) {
                if let Some(Value::Number(n)) = tree.attr(id, ATTR_SEQUENCE_START) {
                    let start = n.as_f64().unwrap_or(f64::NAN);
                    let key_name = match tree.attr(id, ATTR_FIELDS) {
                        Some(Value::Array(a)) => a.first().map(js_display),
                        Some(other) => Some(js_display(other)),
                        None => None,
                    };
                    let key = key_name.as_deref().and_then(|k| {
                        tree.children(obj)
                            .iter()
                            .copied()
                            .find(|&c| is_type(tree, c, TYPE_FIELD) && tree.node(c).name == k)
                    });
                    let key_is_int = key.is_some_and(|k| tree.node(k).sub_type == "int");
                    if start < 1.0 || (key_is_int && start > SEQUENCE_INT_MAX) {
                        let shown = key_name.as_deref().unwrap_or("undefined");
                        let sub = key
                            .map(|k| format!(" (field.{})", tree.node(k).sub_type))
                            .unwrap_or_default();
                        let upper = if key_is_int {
                            format!(" and at most {}", SEQUENCE_INT_MAX as i64)
                        } else {
                            String::new()
                        };
                        out.errors.push(error_at(
                            tree,
                            id,
                            ERR_SEQUENCE_START_OUT_OF_RANGE,
                            format!(
                                "identity.primary \"{obj_name}.{iname}\" @sequenceStart {} is out of range for its key \"{shown}\"{sub}: it must be at least 1{upper}.",
                                js_number(n)
                            ),
                        ));
                    }
                }
                continue;
            }
            let shown = match generation {
                Some(Value::String(s)) => format!("\"{s}\""),
                _ => "not set".to_string(),
            };
            let names = declared
                .iter()
                .map(|a| format!("@{a}"))
                .collect::<Vec<_>>()
                .join(" and ");
            out.errors.push(error_at(
                tree,
                id,
                ERR_SEQUENCE_WITHOUT_INCREMENT,
                format!(
                    "identity.primary \"{obj_name}.{iname}\" sets {names}, but its @generation is {shown}; only an @generation \"increment\" key draws from a sequence. Set @generation \"increment\", or remove {names}."
                ),
            ));
        }
    }
}

// ---- TPH discriminators --------------------------------------------------------

fn own_string<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    match tree.own_attr(id, name).map(|a| &a.value) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

/// A field named `name` on `entity`: its own children first, then up the extends chain.
fn find_field_on_entity(tree: &Tree, entity: NodeId, name: &str) -> Option<NodeId> {
    let mut cur = Some(entity);
    let mut hops = 0;
    while let Some(e) = cur {
        // ADR-0039: own: returns the DECLARING field node, level by level.
        if let Some(&f) = tree
            .own_children(e)
            .iter()
            .find(|&&c| is_type(tree, c, TYPE_FIELD) && tree.node(c).name == name)
        {
            return Some(f);
        }
        hops += 1;
        if hops > tree.len() {
            return None;
        }
        cur = tree.node(e).super_node;
    }
    None
}

/// The nearest entity (self first) up the extends chain that declares `@discriminator`.
fn find_discriminator_root(tree: &Tree, entity: NodeId) -> Option<(NodeId, &str)> {
    let mut cur = Some(entity);
    let mut hops = 0;
    while let Some(e) = cur {
        // ADR-0039: own: locates the physical declaration site of @discriminator.
        if let Some(v) = own_string(tree, e, ATTR_DISCRIMINATOR).filter(|v| !v.is_empty()) {
            return Some((e, v));
        }
        hops += 1;
        if hops > tree.len() {
            return None;
        }
        cur = tree.node(e).super_node;
    }
    None
}

fn is_int_literal(v: &str) -> bool {
    let digits = v.strip_prefix('-').unwrap_or(v);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// The numeric value of an integer literal as one canonical string ("01" is "1").
fn canonical_int(v: &str) -> String {
    let (neg, digits) = match v.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, v),
    };
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_string()
    } else if neg {
        format!("-{trimmed}")
    } else {
        trimmed.to_string()
    }
}

struct Binding<'a> {
    subtype: NodeId,
    value: &'a str,
    numeric: bool,
}

/// `validateDiscriminator` (FR-014): the TPH cross-attribute rules.
pub fn discriminator(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let entities: Vec<NodeId> = tree
        .children(ctx.root)
        .iter()
        .copied()
        .filter(|&c| is(tree, c, TYPE_OBJECT, SUB_ENTITY))
        .collect();

    // Pass 1: @discriminator names a field.
    for &obj in &entities {
        let Some(disc) = own_string(tree, obj, ATTR_DISCRIMINATOR).filter(|d| !d.is_empty()) else {
            continue;
        };
        if find_field_on_entity(tree, obj, disc).is_none() {
            out.errors.push(error_at(
                tree,
                obj,
                ERR_DISCRIMINATOR_FIELD_NOT_FOUND,
                format!(
                    "object.entity \"{}\" @discriminator: \"{disc}\" does not name a field on this entity (checked own children and the extends chain)",
                    tree.node(obj).name
                ),
            ));
        }
    }

    // Pass 2: @discriminatorValue matches the field's type; group by hierarchy root.
    let mut roots: Vec<Vec<Binding<'_>>> = Vec::new();
    let mut root_index: HashMap<NodeId, usize> = HashMap::new();
    for &obj in &entities {
        let Some(value) = own_string(tree, obj, ATTR_DISCRIMINATOR_VALUE).filter(|v| !v.is_empty())
        else {
            continue;
        };
        let Some((disc_root, field_name)) = find_discriminator_root(tree, obj) else {
            continue;
        };
        let Some(field) = find_field_on_entity(tree, disc_root, field_name) else {
            continue; // the root's own ERR_DISCRIMINATOR_FIELD_NOT_FOUND fires
        };
        let fsub = tree.node(field).sub_type.as_str();
        let name = &tree.node(obj).name;
        let numeric = fsub == "int" || fsub == "long";
        if fsub == "enum" {
            let list: Vec<String> = match tree.attr(field, ATTR_VALUES) {
                Some(Value::Array(a)) => a.iter().map(js_display).collect(),
                _ => Vec::new(),
            };
            if !list.iter().any(|m| m == value) {
                out.errors.push(error_at(
                    tree,
                    obj,
                    ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
                    format!(
                        "object.entity \"{name}\" @discriminatorValue: \"{value}\" is not a member of the discriminator enum field \"{field_name}\" @values [{}]",
                        list.join(", ")
                    ),
                ));
            }
        } else if numeric && !is_int_literal(value) {
            out.errors.push(error_at(
                tree,
                obj,
                ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
                format!(
                    "object.entity \"{name}\" @discriminatorValue: \"{value}\" does not coerce to numeric discriminator field \"{field_name}\" (field.{fsub})"
                ),
            ));
        }
        let slot = *root_index.entry(disc_root).or_insert_with(|| {
            roots.push(Vec::new());
            roots.len() - 1
        });
        roots[slot].push(Binding {
            subtype: obj,
            value,
            numeric,
        });
    }

    // Pass 3: one claim per value within a root ("1" and "01" are one value).
    for bindings in &roots {
        let mut seen: HashMap<String, NodeId> = HashMap::new();
        for b in bindings {
            let key = if b.numeric && is_int_literal(b.value) {
                canonical_int(b.value)
            } else {
                b.value.to_string()
            };
            match seen.get(&key) {
                Some(&prev) => out.errors.push(error_at(
                    tree,
                    b.subtype,
                    ERR_DISCRIMINATOR_VALUE_DUPLICATE,
                    format!(
                        "object.entity \"{}\" @discriminatorValue: \"{}\" duplicates the value already claimed by \"{}\"",
                        tree.node(b.subtype).name,
                        b.value,
                        tree.node(prev).name
                    ),
                )),
                None => {
                    seen.insert(key, b.subtype);
                }
            }
        }
    }

    // Pass 4: every concrete subtype of a discriminator root declares a value.
    for &obj in &entities {
        if tree.node(obj).is_abstract
            || own_string(tree, obj, ATTR_DISCRIMINATOR_VALUE).is_some()
            || own_string(tree, obj, ATTR_DISCRIMINATOR).is_some()
        {
            continue;
        }
        let Some((disc_root, _)) = find_discriminator_root(tree, obj) else {
            continue;
        };
        if disc_root == obj {
            continue;
        }
        out.errors.push(error_at(
            tree,
            obj,
            ERR_DISCRIMINATOR_VALUE_MISSING,
            format!(
                "object.entity \"{}\" extends the @discriminator-bearing root \"{}\" but is missing @discriminatorValue (required on every concrete subtype)",
                tree.node(obj).name,
                tree.node(disc_root).name
            ),
        ));
    }
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
            ERR_IDENTITY_NAME_REQUIRED,
            ERR_SUBTYPE_RULE_VIOLATION,
            ERR_PROJECTION_INHERITED_SOURCE,
            ERR_PROJECTION_SOURCE_WRITABLE,
            ERR_TOO_MANY_OCCURRENCES,
            ERR_PROJECTION_IDENTITY_NOT_EXTENDED,
            ERR_IDENTITY_KEY_MISMATCH,
            ERR_SEQUENCE_WITHOUT_INCREMENT,
            ERR_SEQUENCE_START_OUT_OF_RANGE,
            ERR_DISCRIMINATOR_FIELD_NOT_FOUND,
            ERR_DISCRIMINATOR_VALUE_DUPLICATE,
            ERR_DISCRIMINATOR_VALUE_MISSING,
            ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
        ] {
            assert!(
                codes.contains_key(code),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }

    #[test]
    fn integer_literals_compare_by_value() {
        assert!(is_int_literal("-12") && is_int_literal("007"));
        assert!(!is_int_literal("1\n") && !is_int_literal("") && !is_int_literal("-"));
        assert_eq!(canonical_int("007"), "7");
        assert_eq!(canonical_int("-0"), "0");
        assert_eq!(canonical_int("-010"), "-10");
    }
}
