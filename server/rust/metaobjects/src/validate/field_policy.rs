//! `validateEnumNormalizeAmbiguity` / `validateEnumNormalizeCollision`
//! (`core/field/validate-enum-normalize-ambiguity.ts`) and `validateFieldMutability`
//! (`core/field/validate-field-mutability.ts`).

use serde_json::Value;

use super::util::error_at;
use super::{Ctx, Findings};
use crate::errors::MetaError;
use crate::node::NodeId;

pub const WARN_ENUM_NORMALIZE_AMBIGUOUS: &str = "WARN_ENUM_NORMALIZE_AMBIGUOUS";
pub const WARN_MUTABILITY_VALUE_OBJECT: &str = "WARN_MUTABILITY_VALUE_OBJECT";
pub const WARN_MUTABILITY_READONLY_HOST: &str = "WARN_MUTABILITY_READONLY_HOST";
pub const ERR_ENUM_NORMALIZE_COLLISION: &str = "ERR_ENUM_NORMALIZE_COLLISION";
pub const ERR_MUTABILITY_AUTOSET_CONFLICT: &str = "ERR_MUTABILITY_AUTOSET_CONFLICT";
pub const ERR_MUTABILITY_DOWNGRADE: &str = "ERR_MUTABILITY_DOWNGRADE";
pub const ERR_READONLY_ASSIGNED_PRIMARY: &str = "ERR_READONLY_ASSIGNED_PRIMARY";

const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_IDENTITY: &str = "identity";
const TYPE_SOURCE: &str = "source";
const SUB_ENUM: &str = "enum";
const SUB_VALUE: &str = "value";
const SUB_PROJECTION: &str = "projection";
const SUB_PRIMARY: &str = "primary";
const A_VALUES: &str = "values";
const A_NORMALIZE: &str = "normalize";
const A_MUTABILITY: &str = "mutability";
const A_AUTO_SET: &str = "autoSet";
const A_GENERATION: &str = "generation";
const A_FIELDS: &str = "fields";
const A_KIND: &str = "kind";
const NORMALIZE_DEFAULT: &str = "strip";
const GENERATION_ASSIGNED: &str = "assigned";
/// Declaration order is the tightening order.
const MUTABILITY_MODES: &[&str] = &["readWrite", "writeOnce", "readOnly"];
const READ_ONLY_SOURCE_KINDS: &[&str] =
    &["view", "materializedView", "storedProc", "tableFunction"];

fn strip_normalize(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            'a'..='z' => Some(c.to_ascii_uppercase()),
            'A'..='Z' | '0'..='9' => Some(c),
            _ => None,
        })
        .collect()
}

/// Fewest-segments word-break of `target` into two or more `dict` entries.
fn segment_into<'a>(target: &str, dict: &[(&'a str, &str)]) -> Option<Vec<&'a str>> {
    let n = target.len();
    let mut best: Vec<Option<Vec<&'a str>>> = vec![None; n + 1];
    best[0] = Some(Vec::new());
    for i in 0..n {
        let Some(prefix) = best[i].clone() else {
            continue;
        };
        for (member, stripped) in dict {
            let end = i + stripped.len();
            if end > n || !target[i..].starts_with(stripped) {
                continue;
            }
            let mut cand = prefix.clone();
            cand.push(member);
            if best[end].as_ref().is_none_or(|cur| cand.len() < cur.len()) {
                best[end] = Some(cand);
            }
        }
    }
    best[n].take().filter(|s| s.len() >= 2)
}

fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `(mode, explicit)`: own/inherited, then the owning object, then the default.
fn effective_normalize(ctx: &Ctx<'_>, field: NodeId) -> (String, bool) {
    let tree = ctx.tree;
    // ADR-0039: resolving — an enum extending an abstract enum sees its @normalize.
    if let Some(Value::String(m)) = tree.attr(field, A_NORMALIZE) {
        return (m.clone(), true);
    }
    if let Some(p) = tree
        .node(field)
        .parent
        .filter(|&p| tree.node(p).type_name == TYPE_OBJECT)
        && let Some(Value::String(m)) = tree.attr(p, A_NORMALIZE)
    {
        return (m.clone(), true);
    }
    (NORMALIZE_DEFAULT.to_string(), false)
}

/// Every field.enum in the tree with the members it declares itself (more than one),
/// when its effective mode is the default.
fn for_each_enum(ctx: &Ctx<'_>, mut f: impl FnMut(NodeId, Vec<String>, bool)) {
    fn visit(ctx: &Ctx<'_>, id: NodeId, f: &mut impl FnMut(NodeId, Vec<String>, bool)) {
        let tree = ctx.tree;
        let n = tree.node(id);
        if n.type_name == TYPE_FIELD && n.sub_type == SUB_ENUM {
            // ADR-0039: own — the vocabulary DECLARED here; an inheriting enum shares the super's.
            if let Some(Value::Array(vals)) = tree.own_attr(id, A_VALUES).map(|a| &a.value)
                && vals.len() > 1
            {
                let (mode, explicit) = effective_normalize(ctx, id);
                if mode == NORMALIZE_DEFAULT {
                    f(id, vals.iter().map(js_string).collect(), explicit);
                }
            }
        }
        // ADR-0039: own — a structural walk of what each node declares.
        for &c in tree.own_children(id) {
            visit(ctx, c, f);
        }
    }
    visit(ctx, ctx.root, &mut f);
}

pub fn validate_enum_normalize_ambiguity(ctx: &Ctx<'_>, out: &mut Findings) {
    for_each_enum(ctx, |id, members, explicit| {
        let entries: Vec<(&str, String)> = members
            .iter()
            .map(|m| (m.as_str(), strip_normalize(m)))
            .collect();
        for (i, (member, stripped)) in entries.iter().enumerate() {
            if stripped.is_empty() {
                continue;
            }
            // Exclude the member itself BY INDEX: two members can strip alike.
            let others: Vec<(&str, &str)> = entries
                .iter()
                .enumerate()
                .filter(|(j, (_, s))| *j != i && !s.is_empty())
                .map(|(_, (m, s))| (*m, s.as_str()))
                .collect();
            if let Some(seg) = segment_into(stripped, &others) {
                let plus = seg
                    .iter()
                    .map(|s| format!("'{s}'"))
                    .collect::<Vec<_>>()
                    .join(" + ");
                let delimited = seg
                    .iter()
                    .map(|s| s.to_lowercase())
                    .collect::<Vec<_>>()
                    .join("|");
                let name = &ctx.tree.node(id).name;
                out.warnings.push(MetaError::at(
                    WARN_ENUM_NORMALIZE_AMBIGUOUS,
                    format!(
                        "field.enum \"{name}\" member '{member}' is the concatenation of {plus} under @{A_NORMALIZE}: '{NORMALIZE_DEFAULT}'{}, which erases separators. A delimited value such as \"{delimited}\" would coerce silently to '{member}' and be reported as extracted rather than malformed. Set @{A_NORMALIZE}: 'collapse' on this field if it can receive delimited input.",
                        if explicit { "" } else { " (the default)" }
                    ),
                    ctx.tree.node(id).source.clone(),
                ));
                break;
            }
        }
    });
}

pub fn validate_enum_normalize_collision(ctx: &Ctx<'_>, out: &mut Findings) {
    for_each_enum(ctx, |id, members, explicit| {
        let mut by_key: indexmap::IndexMap<String, Vec<&str>> = indexmap::IndexMap::new();
        for m in &members {
            let key = strip_normalize(m);
            if !key.is_empty() {
                by_key.entry(key).or_default().push(m);
            }
        }
        for (key, ms) in by_key {
            let mut distinct: Vec<&str> = Vec::new();
            for m in ms {
                if !distinct.contains(&m) {
                    distinct.push(m);
                }
            }
            if distinct.len() < 2 {
                continue;
            }
            let list = distinct
                .iter()
                .map(|d| format!("'{d}'"))
                .collect::<Vec<_>>()
                .join(", ");
            let name = &ctx.tree.node(id).name;
            out.errors.push(error_at(ctx.tree, id, ERR_ENUM_NORMALIZE_COLLISION, format!(
                "field.enum \"{name}\" members {list} all normalize to '{key}' under @{A_NORMALIZE}: '{NORMALIZE_DEFAULT}'{}, which upper-cases and deletes everything outside A-Z0-9, so a reply naming one of them is indistinguishable from the others. Rename the members so they differ after that fold, or set @{A_NORMALIZE}: 'collapse' (keeps '_' distinct) or 'none' (exact match) on this field.",
                if explicit { "" } else { " (the default)" })));
            break;
        }
    });
}

// ---- field mutability ---------------------------------------------------------------

fn mode_of(v: Option<&Value>) -> Option<usize> {
    v.and_then(Value::as_str)
        .and_then(|s| MUTABILITY_MODES.iter().position(|m| *m == s))
}

/// The effective mode (resolving, ADR-0039); absent is `readWrite` (rank 0).
fn effective_mode(ctx: &Ctx<'_>, field: NodeId) -> usize {
    mode_of(ctx.tree.attr(field, A_MUTABILITY)).unwrap_or(0)
}

fn write_host_read_only(ctx: &Ctx<'_>, obj: NodeId) -> bool {
    let tree = ctx.tree;
    if tree.node(obj).sub_type == SUB_PROJECTION {
        return true;
    }
    // ADR-0039: resolving — a source may be inherited via extends.
    let sources: Vec<NodeId> = tree
        .children(obj)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_SOURCE)
        .collect();
    !sources.is_empty()
        && sources.iter().all(|&s| {
            let kind = tree
                .attr(s, A_KIND)
                .and_then(Value::as_str)
                .filter(|k| !k.is_empty())
                .unwrap_or("table");
            READ_ONLY_SOURCE_KINDS.contains(&kind)
        })
}

fn primary_assigned_names(ctx: &Ctx<'_>, obj: NodeId) -> Vec<String> {
    let tree = ctx.tree;
    let mut out = Vec::new();
    for &id in tree.children(obj).iter() {
        let n = tree.node(id);
        if n.type_name != TYPE_IDENTITY || n.sub_type != SUB_PRIMARY {
            continue;
        }
        if tree.attr(id, A_GENERATION).and_then(Value::as_str) != Some(GENERATION_ASSIGNED) {
            continue;
        }
        match tree.attr(id, A_FIELDS) {
            Some(Value::Array(a)) => {
                out.extend(a.iter().filter_map(Value::as_str).map(str::to_string))
            }
            Some(Value::String(s)) => out.push(s.clone()),
            _ => {}
        }
    }
    out
}

/// The declaring node of a same-named field up the extends chain.
fn inherited_field(ctx: &Ctx<'_>, obj: NodeId, name: &str) -> Option<NodeId> {
    let tree = ctx.tree;
    let mut cursor = tree.node(obj).super_node;
    let mut hops = 0;
    while let Some(c) = cursor {
        // ADR-0039: own — each level's OWN fields locate the declaring node.
        if let Some(&f) = tree
            .own_children(c)
            .iter()
            .find(|&&x| tree.node(x).type_name == TYPE_FIELD && tree.node(x).name == name)
        {
            return Some(f);
        }
        hops += 1;
        if hops > tree.len() {
            break;
        }
        cursor = tree.node(c).super_node;
    }
    None
}

pub fn validate_field_mutability(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for &obj in tree
        .children(ctx.root)
        .iter()
        .filter(|&&c| tree.node(c).type_name == TYPE_OBJECT)
    {
        let on = tree.node(obj);
        let is_value = on.sub_type == SUB_VALUE;
        let host_never_written = write_host_read_only(ctx, obj);
        // ADR-0039: own — own-vs-super comparisons by design.
        for &fld in tree
            .own_children(obj)
            .iter()
            .filter(|&&c| tree.node(c).type_name == TYPE_FIELD)
        {
            let fname = &tree.node(fld).name;
            let own = mode_of(tree.own_attr(fld, A_MUTABILITY).map(|a| &a.value));
            if is_value && let Some(m) = own.filter(|&m| m != 0) {
                out.warnings.push(MetaError::at(
                    WARN_MUTABILITY_VALUE_OBJECT,
                    format!("field \"{fname}\" on object.value \"{}\" declares @mutability: \"{}\"; value objects have no persistence semantics, so the write contract is advisory (codegen may use it for record/struct treatment).", on.name, MUTABILITY_MODES[m]),
                    tree.node(fld).source.clone(),
                ));
            }
            if let Some(m) = own
                && let Some(parent_field) = inherited_field(ctx, obj, fname)
                && let Some(pm) =
                    mode_of(tree.own_attr(parent_field, A_MUTABILITY).map(|a| &a.value))
                && m < pm
            {
                out.errors.push(error_at(tree, fld, ERR_MUTABILITY_DOWNGRADE, format!(
                    "field \"{fname}\" on \"{}\" sets @mutability: \"{}\", but its extends-chain parent declares \"{}\". A subtype may only TIGHTEN an inherited mode ({}), never loosen it (FR-037 R1).",
                    on.name, MUTABILITY_MODES[m], MUTABILITY_MODES[pm], MUTABILITY_MODES.join(" < "))));
            }
        }
        let fields: Vec<NodeId> = tree
            .children(obj)
            .iter()
            .copied()
            .filter(|&c| tree.node(c).type_name == TYPE_FIELD)
            .collect();
        for &fld in &fields {
            let mode = effective_mode(ctx, fld);
            let fname = &tree.node(fld).name;
            if mode != 0 && tree.attr(fld, A_AUTO_SET).is_some() {
                out.errors.push(error_at(tree, fld, ERR_MUTABILITY_AUTOSET_CONFLICT, format!(
                    "field \"{fname}\" on \"{}\" declares @autoSet together with @mutability: \"{}\". @autoSet already means the SERVER supplies the value; @mutability says who may write it. Drop @mutability (an @autoSet field is already excluded from every input shape) or drop @autoSet (FR-037 R1).",
                    on.name, MUTABILITY_MODES[mode])));
            }
            if mode == 1 && host_never_written {
                out.warnings.push(MetaError::at(
                    WARN_MUTABILITY_READONLY_HOST,
                    format!("field \"{fname}\" on \"{}\" declares @mutability: \"writeOnce\", but its host is never written (a projection, or a read-only source @kind). The declaration is inert — nothing creates a row here for it to be settable on.", on.name),
                    tree.node(fld).source.clone(),
                ));
            }
        }
        if !is_value {
            let assigned = primary_assigned_names(ctx, obj);
            if !assigned.is_empty() {
                for &fld in &fields {
                    let fname = &tree.node(fld).name;
                    if assigned.contains(fname) && effective_mode(ctx, fld) == 2 {
                        out.errors.push(error_at(tree, fld, ERR_READONLY_ASSIGNED_PRIMARY, format!(
                            "field \"{fname}\" on \"{}\" is @mutability: \"readOnly\" AND the target of identity.primary with @generation: \"assigned\"; the application has no path to populate the identity value. Use @mutability: \"writeOnce\" if the intent is \"set once on create, never changed\" (FR-037 R1).",
                            on.name)));
                    }
                }
            }
        }
    }
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
            ERR_ENUM_NORMALIZE_COLLISION,
            ERR_MUTABILITY_AUTOSET_CONFLICT,
            ERR_MUTABILITY_DOWNGRADE,
            ERR_READONLY_ASSIGNED_PRIMARY,
        ] {
            assert!(codes.contains_key(c), "{c}");
        }
    }

    #[test]
    fn strip_folds_ascii_only() {
        assert_eq!(strip_normalize("read_Write-1ß"), "READWRITE1");
    }

    #[test]
    fn word_break_finds_the_fewest_segments() {
        let dict = [("READ", "READ"), ("WRITE", "WRITE"), ("RW", "READWRITE")];
        assert_eq!(
            segment_into("READWRITE", &dict[..2]),
            Some(vec!["READ", "WRITE"])
        );
        assert_eq!(segment_into("READ", &dict[..2]), None);
        assert_eq!(
            segment_into("READWRITE", &dict),
            Some(vec!["RW"]).filter(|s| s.len() >= 2)
        );
    }
}
