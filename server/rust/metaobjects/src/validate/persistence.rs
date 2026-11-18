//! Source, persistence, grid and index validation passes (the TypeScript
//! `validateSource*`, `validateColumnNameCollisions`, `validateIndexLookupFields`,
//! `validateDataGrid*`, `validateFilterableHas*` and `validateSortableHas*`).
//!
//! ADR-0039: effective (resolving) reads are the default. The `own_*` reads below
//! each carry a comment naming the sanctioned case (declaration-layer checks).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use super::util::{error_at, ops_for_field, ops_for_subtype};
use super::{Ctx, Findings};
use crate::errors::{MetaError, WARN_LEGACY};
use crate::node::{NodeId, Tree};

pub const ERR_SOURCE_NO_PRIMARY: &str = "ERR_SOURCE_NO_PRIMARY";
pub const ERR_SOURCE_MULTIPLE_PRIMARY: &str = "ERR_SOURCE_MULTIPLE_PRIMARY";
pub const ERR_ENTITY_PRIMARY_SOURCE_READONLY: &str = "ERR_ENTITY_PRIMARY_SOURCE_READONLY";
pub const ERR_SQL_BODY_WITH_UNMANAGED: &str = "ERR_SQL_BODY_WITH_UNMANAGED";
pub const ERR_SQL_BODY_ON_WRITABLE_KIND: &str = "ERR_SQL_BODY_ON_WRITABLE_KIND";
pub const ERR_ORIGIN_UNDER_SQL_BODY: &str = "ERR_ORIGIN_UNDER_SQL_BODY";
pub const WARN_ORIGIN_UNDER_UNMANAGED: &str = "WARN_ORIGIN_UNDER_UNMANAGED";
pub const ERR_BAD_ATTR_VALUE: &str = "ERR_BAD_ATTR_VALUE";
pub const ERR_PHYSICAL_NAME_MULTIPLE: &str = "ERR_PHYSICAL_NAME_MULTIPLE";
pub const ERR_PHYSICAL_NAME_KIND_MISMATCH: &str = "ERR_PHYSICAL_NAME_KIND_MISMATCH";
pub const WARN_LEGACY_PHYSICAL_NAME_ALIAS: &str = "WARN_LEGACY_PHYSICAL_NAME_ALIAS";
pub const ERR_PARAMETER_REF_UNRESOLVED: &str = "ERR_PARAMETER_REF_UNRESOLVED";
pub const ERR_PARAMETER_REF_NOT_VALUE_OBJECT: &str = "ERR_PARAMETER_REF_NOT_VALUE_OBJECT";
pub const ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND: &str = "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND";
pub const ERR_COLUMN_NAME_COLLISION: &str = "ERR_COLUMN_NAME_COLLISION";
pub const ERR_INVALID_INDEX: &str = "ERR_INVALID_INDEX";
pub const ERR_BAD_DEFAULT_SORT_FIELD: &str = "ERR_BAD_DEFAULT_SORT_FIELD";
pub const ERR_BAD_ATTR_FILTER: &str = "ERR_BAD_ATTR_FILTER";
pub const ERR_FILTERABLE_UNSUPPORTED_SUBTYPE: &str = "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE";
pub const ERR_SORTABLE_UNSUPPORTED_SUBTYPE: &str = "ERR_SORTABLE_UNSUPPORTED_SUBTYPE";

const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_SOURCE: &str = "source";
const TYPE_IDENTITY: &str = "identity";
const TYPE_INDEX: &str = "index";
const TYPE_LAYOUT: &str = "layout";
const TYPE_ORIGIN: &str = "origin";
const OBJECT_ENTITY: &str = "entity";
const OBJECT_VALUE: &str = "value";
const OBJECT_PROJECTION: &str = "projection";
const SOURCE_RDB: &str = "rdb";
const LAYOUT_DATA_GRID: &str = "dataGrid";
const IDENTITY_SECONDARY: &str = "secondary";
const INDEX_LOOKUP: &str = "lookup";
const FIELD_OBJECT: &str = "object";
const STORAGE_FLATTENED: &str = "flattened";

const ATTR_ROLE: &str = "role";
const ATTR_KIND: &str = "kind";
const ATTR_SQL: &str = "sql";
const ATTR_UNMANAGED: &str = "unmanaged";
const ATTR_PARAMETER_REF: &str = "parameterRef";
const ATTR_FILTER: &str = "filter";
const ATTR_FILTERABLE: &str = "filterable";
const ATTR_SORTABLE: &str = "sortable";
const ATTR_DB_INDEXED: &str = "db.indexed";
const ATTR_COLUMN: &str = "column";
const ATTR_FLATTENED_PREFIX: &str = "flattenedColumnPrefix";
const ATTR_STORAGE: &str = "storage";
const ATTR_OBJECT_REF: &str = "objectRef";
const ATTR_FIELDS: &str = "fields";
const ATTR_EXPR: &str = "expr";
const ATTR_DEFAULT_SORT_FIELD: &str = "defaultSortField";

const ROLE_PRIMARY: &str = "primary";
const KIND_TABLE: &str = "table";
const KIND_VIEW: &str = "view";
const KIND_MATERIALIZED_VIEW: &str = "materializedView";
const KIND_STORED_PROC: &str = "storedProc";
const KIND_TABLE_FUNCTION: &str = "tableFunction";
const READ_ONLY_KINDS: [&str; 4] = [
    KIND_VIEW,
    KIND_MATERIALIZED_VIEW,
    KIND_STORED_PROC,
    KIND_TABLE_FUNCTION,
];

/// Physical-name alias attr, by `@kind` (ADR-0018).
const ALIAS_BY_KIND: [(&str, &str); 5] = [
    (KIND_TABLE, "table"),
    (KIND_VIEW, "view"),
    (KIND_MATERIALIZED_VIEW, "materializedView"),
    (KIND_STORED_PROC, "proc"),
    (KIND_TABLE_FUNCTION, "function"),
];
const ALL_ALIASES: [&str; 5] = ["table", "view", "materializedView", "proc", "function"];

// ---- small readers ----------------------------------------------------------

fn str_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    tree.attr(id, name).and_then(Value::as_str)
}

fn nonempty_str_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    str_attr(tree, id, name).filter(|s| !s.is_empty())
}

fn effective_kind(tree: &Tree, s: NodeId) -> &str {
    nonempty_str_attr(tree, s, ATTR_KIND).unwrap_or(KIND_TABLE)
}

fn is_read_only(tree: &Tree, s: NodeId) -> bool {
    READ_ONLY_KINDS.contains(&effective_kind(tree, s))
}

fn sql_body_set(tree: &Tree, s: NodeId) -> bool {
    nonempty_str_attr(tree, s, ATTR_SQL).is_some()
}

fn is_unmanaged(tree: &Tree, s: NodeId) -> bool {
    tree.attr(s, ATTR_UNMANAGED) == Some(&Value::Bool(true))
}

/// The root's direct object children (the root has no super).
fn objects<'a>(tree: &'a Tree, root: NodeId) -> impl Iterator<Item = NodeId> + 'a {
    tree.own_children(root)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_OBJECT)
}

/// Own `source.rdb` children: the declaration layer (ADR-0039 own: the checks judge
/// what THIS object declares; an inherited source was judged where it is declared).
fn own_rdb_sources<'a>(tree: &'a Tree, obj: NodeId) -> impl Iterator<Item = NodeId> + 'a {
    tree.own_children(obj).iter().copied().filter(|&c| {
        let n = tree.node(c);
        n.type_name == TYPE_SOURCE && n.sub_type == SOURCE_RDB
    })
}

/// A JavaScript `String.prototype.trim() === ""`.
fn js_blank(s: &str) -> bool {
    s.chars()
        .all(|c| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
}

/// How JavaScript would print a JSON element in a template literal.
fn js_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// ---- reference resolution (ADR-0059 R2, objects only) ---------------------------

// ---- validateSourceRoles ----------------------------------------------------------

pub fn validate_source_roles(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        // ADR-0039 own: the one-primary rule counts sources declared on THIS object.
        let sources: Vec<NodeId> = tree
            .own_children(obj)
            .iter()
            .copied()
            .filter(|&c| tree.node(c).type_name == TYPE_SOURCE)
            .collect();
        if sources.is_empty() {
            continue;
        }
        let role = |s: NodeId| nonempty_str_attr(tree, s, ATTR_ROLE).unwrap_or(ROLE_PRIMARY);
        let primaries = sources.iter().filter(|&&s| role(s) == ROLE_PRIMARY).count();
        let name = &tree.node(obj).name;
        if primaries == 0 {
            out.errors.push(error_at(
                tree,
                obj,
                ERR_SOURCE_NO_PRIMARY,
                format!(
                    "object \"{name}\" declares {} source(s) but none has role \"{ROLE_PRIMARY}\"",
                    sources.len()
                ),
            ));
        } else if primaries > 1 {
            out.errors.push(error_at(
                tree,
                obj,
                ERR_SOURCE_MULTIPLE_PRIMARY,
                format!(
                    "object \"{name}\" declares {primaries} sources with role \"{ROLE_PRIMARY}\"; exactly one is required"
                ),
            ));
        }
        if tree.node(obj).sub_type == OBJECT_ENTITY {
            for &s in &sources {
                if role(s) == ROLE_PRIMARY && is_read_only(tree, s) {
                    out.errors.push(error_at(
                        tree,
                        s,
                        ERR_ENTITY_PRIMARY_SOURCE_READONLY,
                        format!(
                            "entity \"{name}\" has a primary source of read-only kind \"{}\" — read-only kinds are legal only in non-primary roles; a derived read model is an object.projection (FR-024, ADR-0028)",
                            effective_kind(tree, s)
                        ),
                    ));
                }
            }
        }
    }
}

// ---- validateSourceEscapes --------------------------------------------------------

/// A projection's effective `@filter` is present when any level of its `extends`
/// chain declares one (ADR-0039 own: each level contributes its own declaration).
fn has_effective_projection_filter(tree: &Tree, projection: NodeId) -> bool {
    let mut seen = vec![];
    let mut cur = Some(projection);
    while let Some(n) = cur {
        if seen.contains(&n) {
            break;
        }
        seen.push(n);
        if tree
            .own_attr(n, ATTR_FILTER)
            .is_some_and(|a| !a.value.is_null())
        {
            return true;
        }
        cur = tree.node(n).super_node;
    }
    false
}

pub fn validate_source_escapes(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let name = &tree.node(obj).name;
        let (mut sql_host, mut unmanaged_host) = (false, false);
        for s in own_rdb_sources(tree, obj) {
            let sql_set = sql_body_set(tree, s);
            let unmanaged = is_unmanaged(tree, s);
            if sql_set && unmanaged {
                out.errors.push(error_at(tree, s, ERR_SQL_BODY_WITH_UNMANAGED, format!(
                    "source.rdb on object \"{name}\" declares both @sql and @unmanaged — these are the mutually exclusive non-default states of one DDL-ownership axis (an author-supplied body contradicts \"someone else owns this DDL\")")));
            }
            if sql_set && !is_read_only(tree, s) {
                out.errors.push(error_at(tree, s, ERR_SQL_BODY_ON_WRITABLE_KIND, format!(
                    "source.rdb on object \"{name}\" declares @sql with a writable @kind (\"{}\") — @sql is legal only on a read-only kind (view/materializedView/storedProc/tableFunction); a writable table is either fully modeled or marked @unmanaged, never opaque-bodied",
                    effective_kind(tree, s))));
            }
            // The raw attr, not the narrowed body: present-but-empty must be seen.
            if let Some(raw) = tree.attr(s, ATTR_SQL)
                && raw.as_str().is_none_or(js_blank)
            {
                out.errors.push(error_at(tree, s, ERR_BAD_ATTR_VALUE, format!(
                    "source.rdb on object \"{name}\" sets @sql to an empty/whitespace-only value; @sql requires a non-empty SQL body")));
            }
            sql_host |= sql_set;
            unmanaged_host |= unmanaged;
        }
        if !sql_host && !unmanaged_host {
            continue;
        }
        // ADR-0039 own: origin.* never inherits (ADR-0029), so derived-ness is own-only.
        for &f in tree.own_children(obj) {
            if tree.node(f).type_name != TYPE_FIELD
                || !tree
                    .own_children(f)
                    .iter()
                    .any(|&c| tree.node(c).type_name == TYPE_ORIGIN)
            {
                continue;
            }
            let fname = &tree.node(f).name;
            if sql_host {
                out.errors.push(error_at(tree, f, ERR_ORIGIN_UNDER_SQL_BODY, format!(
                    "field \"{name}.{fname}\" carries an origin.* (derived) child, but \"{name}\" has a read source carrying @sql — the synthesized derivation and the author's verbatim SQL are two sources of truth for the same body")));
            } else {
                out.warnings.push(error_at(tree, f, WARN_ORIGIN_UNDER_UNMANAGED, format!(
                    "field \"{name}.{fname}\" carries an origin.* (derived) child, but \"{name}\" has a source marked @unmanaged — the tool never touches this object's DDL, so the derivation is documented lineage only (not acted on); this is informational, not an error")));
            }
        }
        if sql_host
            && tree.node(obj).sub_type == OBJECT_PROJECTION
            && has_effective_projection_filter(tree, obj)
        {
            out.errors.push(error_at(tree, obj, ERR_ORIGIN_UNDER_SQL_BODY, format!(
                "projection \"{name}\" declares both @filter and an @sql read source — a view-level @filter lowers to the outer WHERE of a synthesized body; with @sql the author owns the body (and its WHERE), so the two cannot be combined")));
        }
    }
}

// ---- validateSourcePhysicalNames -----------------------------------------------------

pub fn validate_source_physical_names(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let name = &tree.node(obj).name;
        for s in own_rdb_sources(tree, obj) {
            // ADR-0039 own: the "exactly one alias, non-empty" rule is a per-source
            // own-declaration constraint; resolving would conflate an inherited alias.
            let own_str = |a: &str| tree.own_attr(s, a).and_then(|x| x.value.as_str());
            for a in ALL_ALIASES {
                if own_str(a) == Some("") {
                    out.errors.push(error_at(tree, s, ERR_BAD_ATTR_VALUE, format!(
                        "source.rdb on object \"{name}\" sets @{a} to an empty string; physical name attrs require a non-empty value")));
                }
            }
            let set: Vec<&str> = ALL_ALIASES
                .into_iter()
                .filter(|a| own_str(a).is_some_and(|v| !v.is_empty()))
                .collect();
            if set.len() > 1 {
                let list = set
                    .iter()
                    .map(|a| format!("@{a}"))
                    .collect::<Vec<_>>()
                    .join(", ");
                out.errors.push(error_at(tree, s, ERR_PHYSICAL_NAME_MULTIPLE, format!(
                    "source.rdb on object \"{name}\" declares multiple physical-name aliases ({list}); set exactly one")));
                continue;
            }
            let Some(&chosen) = set.first() else { continue };
            let kind = effective_kind(tree, s);
            let expected = ALIAS_BY_KIND
                .iter()
                .find(|(k, _)| *k == kind)
                .map(|(_, a)| *a);
            if expected == Some(chosen) {
                continue;
            }
            if chosen == "table" {
                out.warnings.push(error_at(tree, s, WARN_LEGACY_PHYSICAL_NAME_ALIAS, format!(
                    "source.rdb on object \"{name}\" uses @table with @kind: \"{kind}\"; prefer the kind-matching alias @{} (ADR-0018)",
                    expected.unwrap_or("undefined"))));
                continue;
            }
            let for_alias = ALIAS_BY_KIND
                .iter()
                .find(|(_, a)| *a == chosen)
                .map_or("(unknown)", |(k, _)| *k);
            out.errors.push(error_at(tree, s, ERR_PHYSICAL_NAME_KIND_MISMATCH, format!(
                "source.rdb on object \"{name}\" uses @{chosen} with @kind: \"{kind}\"; @{chosen} is only valid for @kind: \"{for_alias}\"")));
        }
    }
}

// ---- validateSourceParameterRef ---------------------------------------------------------

pub fn validate_source_parameter_ref(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let n = tree.node(obj);
        let referrer_pkg = n
            .package
            .as_deref()
            .or(n.file_default_package.as_deref())
            .unwrap_or("");
        for s in own_rdb_sources(tree, obj) {
            // Resolving: a source may inherit @parameterRef via extends.
            let Some(reference) = nonempty_str_attr(tree, s, ATTR_PARAMETER_REF) else {
                continue;
            };
            let kind = effective_kind(tree, s);
            if kind != KIND_STORED_PROC && kind != KIND_TABLE_FUNCTION {
                out.errors.push(error_at(tree, s, ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND, format!(
                    "source.rdb on object \"{}\" has @parameterRef but @kind is \"{kind}\"; only \"storedProc\" or \"tableFunction\" accept parameters", n.name)));
                continue;
            }
            let idx = ctx.objects;
            let Some(target) = idx.resolve(reference, referrer_pkg) else {
                out.errors.push(error_at(tree, s, ERR_PARAMETER_REF_UNRESOLVED, format!(
                    "source.rdb on object \"{}\" @parameterRef = \"{reference}\" does not resolve to any known object", n.name)));
                continue;
            };
            let t = tree.node(target);
            if t.sub_type != OBJECT_VALUE {
                let reason = if t.sub_type == OBJECT_ENTITY {
                    "an object.entity (entities have identity; parameter shapes are value-objects)"
                        .to_string()
                } else {
                    format!("an object.{}", t.sub_type)
                };
                out.errors.push(error_at(tree, s, ERR_PARAMETER_REF_NOT_VALUE_OBJECT, format!(
                    "source.rdb on object \"{}\" @parameterRef = \"{reference}\" resolves to {reason}; use an object.value", n.name)));
            }
        }
    }
}

// ---- validateColumnNameCollisions ------------------------------------------------------------

/// `toSnakeCase` (ASCII word splitting, as the reference's two regexes): a run of
/// capitals followed by a lowercase letter splits before its last capital, and a
/// lowercase letter or digit followed by a capital splits between them.
fn to_snake_case(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut first = String::with_capacity(s.len() + 4);
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_uppercase() {
            let mut j = i;
            while j < chars.len() && chars[j].is_ascii_uppercase() {
                j += 1;
            }
            let split = j - i >= 2 && j < chars.len() && chars[j].is_ascii_lowercase();
            for (k, &c) in chars[i..j].iter().enumerate() {
                if split && i + k == j - 1 {
                    first.push('_');
                }
                first.push(c);
            }
            i = j;
        } else {
            first.push(chars[i]);
            i += 1;
        }
    }
    let mut out = String::with_capacity(first.len() + 4);
    let mut prev: Option<char> = None;
    for c in first.chars() {
        if c.is_ascii_uppercase()
            && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            out.push('_');
        }
        out.push(c);
        prev = Some(c);
    }
    out.to_lowercase()
}

/// The column of a field: `@column`, else the name under the default `snake_case` rule
/// (the Rust loader carries no `naming.columns` setting yet).
fn column_of<'a>(tree: &'a Tree, f: NodeId) -> std::borrow::Cow<'a, str> {
    match nonempty_str_attr(tree, f, ATTR_COLUMN) {
        Some(c) => c.into(),
        None => to_snake_case(&tree.node(f).name).into(),
    }
}

struct PhysicalColumn<'a> {
    column: std::borrow::Cow<'a, str>,
    field: NodeId,
    /// Set for a flattened member: the member's field node.
    member: Option<NodeId>,
}

impl PhysicalColumn<'_> {
    fn label(&self, tree: &Tree) -> String {
        match self.member {
            Some(m) => format!("{}.{}", tree.node(self.field).name, tree.node(m).name),
            None => tree.node(self.field).name.clone(),
        }
    }

    fn named(&self) -> NodeId {
        self.member.unwrap_or(self.field)
    }
}

fn has_explicit_column(tree: &Tree, f: NodeId) -> bool {
    nonempty_str_attr(tree, f, ATTR_COLUMN).is_some()
}

pub fn validate_column_name_collisions(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        if tree.node(obj).is_abstract {
            continue;
        }
        let kids = tree.children(obj);
        let mut has_source = false;
        let (mut all_read_only, mut sql_view) = (true, false);
        for &c in kids.iter() {
            if tree.node(c).type_name == TYPE_SOURCE {
                has_source = true;
                all_read_only &= is_read_only(tree, c);
                sql_view |= effective_kind(tree, c) == KIND_VIEW && sql_body_set(tree, c);
            }
        }
        if !has_source || (all_read_only && sql_view) {
            continue;
        }
        let mut seen: HashMap<String, PhysicalColumn<'_>> = HashMap::new();
        for &f in kids.iter() {
            if tree.node(f).type_name != TYPE_FIELD
                // ADR-0039 own: origin.* never inherits (ADR-0029), so derived-ness is own-only.
                || tree.own_children(f).iter().any(|&c| tree.node(c).type_name == TYPE_ORIGIN)
            {
                continue;
            }
            let mut columns: Vec<PhysicalColumn<'_>> = Vec::new();
            if tree.node(f).sub_type == FIELD_OBJECT
                && str_attr(tree, f, ATTR_STORAGE) == Some(STORAGE_FLATTENED)
            {
                let idx = ctx.objects;
                if let Some(target) = idx.ref_target(tree, f, ATTR_OBJECT_REF)
                    && tree.node(target).type_name == TYPE_OBJECT
                {
                    let prefix = match tree.attr(f, ATTR_FLATTENED_PREFIX).and_then(Value::as_str) {
                        Some(p) => p.to_string(),
                        None => format!("{}_", column_of(tree, f)),
                    };
                    for &m in tree.children(target).iter() {
                        if tree.node(m).type_name == TYPE_FIELD {
                            columns.push(PhysicalColumn {
                                column: format!("{prefix}{}", column_of(tree, m)).into(),
                                field: f,
                                member: Some(m),
                            });
                        }
                    }
                }
            } else {
                columns.push(PhysicalColumn {
                    column: column_of(tree, f),
                    field: f,
                    member: None,
                });
            }
            for col in columns {
                if let Some(first) = seen.get(col.column.as_ref()) {
                    let hint = if first.member.is_some() || col.member.is_some() {
                        "Give one flattened field a different @flattenedColumnPrefix, or rename one field."
                    } else if has_explicit_column(tree, first.named())
                        && has_explicit_column(tree, col.named())
                    {
                        "Rename one field, or point one @column at a different column."
                    } else {
                        "Rename one field, or give one an explicit @column so the two columns differ."
                    };
                    out.errors.push(error_at(tree, f, ERR_COLUMN_NAME_COLLISION, format!(
                        "fields \"{}\" and \"{}\" on \"{}\" both resolve to physical column \"{}\". {hint}",
                        first.label(tree), col.label(tree), tree.node(obj).name, col.column)));
                } else {
                    seen.insert(col.column.to_string(), col);
                }
            }
        }
    }
}

// ---- validateIndexLookupFields ------------------------------------------------------------------

/// The closing sentence of the contradiction hint (`attr-contradictions.ts`).
fn contradiction_hint(label: &str) -> String {
    let (why, effect) = if label == "index.lookup" {
        (
            "an index keys off plain columns (@fields) or a key expression (@expr), never both",
            "the index in your database is the expression one and dropping @fields changes no emitted DDL",
        )
    } else {
        (
            "a unique key keys off plain columns (@fields) or a key expression (@expr), never both",
            "the constraint in your database is the expression one and dropping @fields changes no emitted DDL",
        )
    };
    format!(
        "{why} — drop one. Declaring both previously loaded but silently discarded @fields, so {effect}. `meta upgrade --apply` drops it for you."
    )
}

pub fn validate_index_lookup_fields(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let kids = tree.children(obj);
        let keyed = |c: NodeId| {
            let n = tree.node(c);
            (n.type_name == TYPE_INDEX && n.sub_type == INDEX_LOOKUP)
                || (n.type_name == TYPE_IDENTITY && n.sub_type == IDENTITY_SECONDARY)
        };
        if !kids.iter().any(|&c| keyed(c)) {
            continue;
        }
        let mut names: Vec<&str> = Vec::new();
        let mut set: HashSet<&str> = HashSet::new();
        for &c in kids.iter() {
            if tree.node(c).type_name == TYPE_FIELD && set.insert(&tree.node(c).name) {
                names.push(&tree.node(c).name);
            }
        }
        let oname = &tree.node(obj).name;
        for &node in kids.iter().filter(|&&c| keyed(c)) {
            let n = tree.node(node);
            let label = format!("{}.{}", n.type_name, n.sub_type);
            let fields_attr = tree.attr(node, ATTR_FIELDS);
            let has_expr = str_attr(tree, node, ATTR_EXPR).is_some_and(|e| !js_blank(e));
            if fields_attr.is_some() && has_expr {
                out.errors.push(error_at(tree, node, ERR_INVALID_INDEX, format!(
                    "{label} \"{}\" on \"{oname}\" declares BOTH @{ATTR_FIELDS} and @{ATTR_EXPR}: {}",
                    n.name, contradiction_hint(&label))));
                continue;
            }
            let fields: &[Value] = fields_attr
                .and_then(Value::as_array)
                .map_or(&[], Vec::as_slice);
            if fields.is_empty() && !has_expr {
                out.errors.push(error_at(tree, node, ERR_INVALID_INDEX, format!(
                    "{label} \"{}\" on \"{oname}\" declares no key: it must have @{ATTR_FIELDS} (one or more columns) or @{ATTR_EXPR} (a key expression)",
                    n.name)));
                continue;
            }
            for fv in fields {
                if fv.as_str().is_none_or(|s| !set.contains(s)) {
                    let avail = if names.is_empty() {
                        "(none)".to_string()
                    } else {
                        names.join(", ")
                    };
                    out.errors.push(error_at(tree, node, ERR_INVALID_INDEX, format!(
                        "{label} \"{}\" on \"{oname}\" references field \"{}\" which does not exist on \"{oname}\". Available fields: {avail}",
                        n.name, js_display(fv))));
                }
            }
        }
    }
}

// ---- grid and filterable/sortable passes -------------------------------------------------------------

fn effective_field_names<'a>(tree: &'a Tree, kids: &[NodeId]) -> Vec<&'a str> {
    let mut seen = HashSet::new();
    kids.iter()
        .filter(|&&c| tree.node(c).type_name == TYPE_FIELD)
        .map(|&c| tree.node(c).name.as_str())
        .filter(|n| seen.insert(*n))
        .collect()
}

fn data_grids<'a>(tree: &'a Tree, kids: &'a [NodeId]) -> impl Iterator<Item = NodeId> + 'a {
    kids.iter().copied().filter(|&c| {
        let n = tree.node(c);
        n.type_name == TYPE_LAYOUT && n.sub_type == LAYOUT_DATA_GRID
    })
}

pub fn validate_data_grid_sort_fields(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let kids = tree.children(obj);
        let mut names: Option<(Vec<&str>, HashSet<&str>)> = None;
        for layout in data_grids(tree, &kids) {
            let Some(sort) = str_attr(tree, layout, ATTR_DEFAULT_SORT_FIELD) else {
                continue;
            };
            let (list, set) = names.get_or_insert_with(|| {
                let l = effective_field_names(tree, &kids);
                let s = l.iter().copied().collect();
                (l, s)
            });
            if !set.contains(sort) {
                out.errors.push(error_at(tree, layout, ERR_BAD_DEFAULT_SORT_FIELD, format!(
                    "dataGrid layout \"{}\" on entity \"{}\" has @defaultSortField \"{sort}\" but no such field exists on \"{}\". Available fields: {}",
                    tree.node(layout).name, tree.node(obj).name, tree.node(obj).name, list.join(", "))));
            }
        }
    }
}

pub fn validate_filterable_has_index(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let kids = tree.children(obj);
        let mut indexed: Option<HashSet<String>> = None;
        for &f in kids.iter() {
            if tree.node(f).type_name != TYPE_FIELD
                || tree.attr(f, ATTR_FILTERABLE) != Some(&Value::Bool(true))
                || tree.attr(f, ATTR_DB_INDEXED) == Some(&Value::Bool(true))
            {
                continue;
            }
            let set = indexed.get_or_insert_with(|| {
                let mut s = HashSet::new();
                for &i in kids
                    .iter()
                    .filter(|&&c| tree.node(c).type_name == TYPE_IDENTITY)
                {
                    match tree.attr(i, ATTR_FIELDS) {
                        Some(Value::String(v)) => {
                            s.extend(v.split(',').map(|x| x.trim().to_string()))
                        }
                        Some(Value::Array(a)) => {
                            s.extend(a.iter().filter_map(|x| x.as_str().map(String::from)))
                        }
                        _ => {}
                    }
                }
                s
            });
            let fname = &tree.node(f).name;
            if set.contains(fname.as_str()) {
                continue;
            }
            out.warnings.push(MetaError::code(WARN_LEGACY, format!(
                "[filterable-without-index] field \"{}.{fname}\" has @filterable: true but is not part of any identity. Filtering on this field will sequential-scan. Add @db.indexed: true to the field (when supported), or remove @filterable: true.",
                tree.node(obj).name)));
        }
    }
}

pub fn validate_filterable_has_supported_ops(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        for &f in tree.children(obj).iter() {
            if tree.node(f).type_name != TYPE_FIELD
                || tree.attr(f, ATTR_FILTERABLE) != Some(&Value::Bool(true))
            {
                continue;
            }
            let (oname, fname) = (&tree.node(obj).name, &tree.node(f).name);
            if tree.resolved_is_array(f) {
                out.errors.push(error_at(tree, f, ERR_FILTERABLE_UNSUPPORTED_SUBTYPE, format!(
                    "Field \"{oname}.{fname}\" has @filterable: true but is an array (isArray: true). No filter operator applies to a collection column. Remove @filterable from this field.")));
                continue;
            }
            if !ops_for_subtype(&tree.node(f).sub_type).is_empty() {
                continue;
            }
            out.errors.push(error_at(tree, f, ERR_FILTERABLE_UNSUPPORTED_SUBTYPE, format!(
                "Field \"{oname}.{fname}\" has @filterable: true but its subtype \"{}\" has no filter-operator band. Remove @filterable, or use a field subtype that supports filtering (string/enum/uuid/number/currency/date/boolean).",
                tree.node(f).sub_type)));
        }
    }
}

pub fn validate_sortable_has_supported_subtype(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        for &f in tree.children(obj).iter() {
            if tree.node(f).type_name != TYPE_FIELD
                || tree.attr(f, ATTR_SORTABLE) != Some(&Value::Bool(true))
            {
                continue;
            }
            let is_array = tree.resolved_is_array(f);
            if !is_array && !ops_for_subtype(&tree.node(f).sub_type).is_empty() {
                continue;
            }
            let why = if is_array {
                "is an array (isArray: true) — a collection column has no ordering.".to_string()
            } else {
                format!(
                    "its subtype \"{}\" cannot be ordered.",
                    tree.node(f).sub_type
                )
            };
            out.errors.push(error_at(tree, f, ERR_SORTABLE_UNSUPPORTED_SUBTYPE, format!(
                "Field \"{}.{}\" has @sortable: true but {why} Remove @sortable from this field.",
                tree.node(obj).name, tree.node(f).name)));
        }
    }
}

fn check_filter_clauses(
    filter: &Map<String, Value>,
    allow: &IndexAllow,
    entity: &str,
    layout: NodeId,
    tree: &Tree,
    out: &mut Vec<MetaError>,
) {
    for (key, clause) in filter {
        if key == "or" || key == "and" {
            if let Value::Array(subs) = clause {
                for sub in subs.iter().filter_map(Value::as_object) {
                    check_filter_clauses(sub, allow, entity, layout, tree, out);
                }
            }
            continue;
        }
        let lname = &tree.node(layout).name;
        let Some(ops) = allow.get(key) else {
            let keys: Vec<&str> = allow.keys().collect();
            let list = if keys.is_empty() {
                "(none)".to_string()
            } else {
                keys.join(", ")
            };
            out.push(error_at(tree, layout, ERR_BAD_ATTR_FILTER, format!(
                "dataGrid layout \"{lname}\" on entity \"{entity}\" has @filter over non-filterable field \"{key}\". Filterable fields: {list}")));
            continue;
        };
        if let Value::Object(c) = clause {
            for op in c.keys().filter(|op| !ops.contains(&op.as_str())) {
                out.push(error_at(tree, layout, ERR_BAD_ATTR_FILTER, format!(
                    "dataGrid layout \"{lname}\" on entity \"{entity}\" @filter uses disallowed op \"{key}.{op}\". Allowed ops for \"{key}\": {}",
                    ops.join(", "))));
            }
        }
    }
}

/// Filterable field name to its operator band, in first-insertion order.
struct IndexAllow(indexmap::IndexMap<String, &'static [&'static str]>);

impl IndexAllow {
    fn get(&self, k: &str) -> Option<&'static [&'static str]> {
        self.0.get(k).copied()
    }

    fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }
}

pub fn validate_data_grid_filter_values(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    for obj in objects(tree, ctx.root) {
        let kids = tree.children(obj);
        let mut allow: Option<IndexAllow> = None;
        for layout in data_grids(tree, &kids) {
            // Type errors (the legacy string form) are reported by the attr-schema pass.
            let Some(Value::Object(filter)) = tree.attr(layout, ATTR_FILTER) else {
                continue;
            };
            let allow = allow.get_or_insert_with(|| {
                let mut m = indexmap::IndexMap::new();
                for &f in kids.iter() {
                    if tree.node(f).type_name == TYPE_FIELD
                        && tree.attr(f, ATTR_FILTERABLE) == Some(&Value::Bool(true))
                    {
                        m.insert(tree.node(f).name.clone(), ops_for_field(tree, f));
                    }
                }
                IndexAllow(m)
            });
            check_filter_clauses(
                filter,
                allow,
                &tree.node(obj).name,
                layout,
                tree,
                &mut out.errors,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loader::Loader;
    use crate::providers::default_registry;

    #[test]
    fn every_code_is_in_the_shared_catalogue() {
        let raw = include_str!("../../../../../fixtures/conformance/ERROR-CODES.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for c in [
            ERR_SOURCE_NO_PRIMARY,
            ERR_SOURCE_MULTIPLE_PRIMARY,
            ERR_ENTITY_PRIMARY_SOURCE_READONLY,
            ERR_SQL_BODY_WITH_UNMANAGED,
            ERR_SQL_BODY_ON_WRITABLE_KIND,
            ERR_ORIGIN_UNDER_SQL_BODY,
            ERR_BAD_ATTR_VALUE,
            ERR_PHYSICAL_NAME_MULTIPLE,
            ERR_PHYSICAL_NAME_KIND_MISMATCH,
            ERR_PARAMETER_REF_UNRESOLVED,
            ERR_PARAMETER_REF_NOT_VALUE_OBJECT,
            ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND,
            ERR_COLUMN_NAME_COLLISION,
            ERR_INVALID_INDEX,
            ERR_BAD_DEFAULT_SORT_FIELD,
            ERR_BAD_ATTR_FILTER,
            ERR_FILTERABLE_UNSUPPORTED_SUBTYPE,
            ERR_SORTABLE_UNSUPPORTED_SUBTYPE,
        ] {
            assert!(codes.contains_key(c), "{c} is not in ERROR-CODES.json");
        }
    }

    #[test]
    fn snake_case_matches_the_reference_rule() {
        for (i, o) in [
            ("userId", "user_id"),
            ("userID", "user_id"),
            ("HTTPServer", "http_server"),
            ("address1Line", "address1_line"),
            ("id", "id"),
            ("ABC", "abc"),
            ("aBC", "a_bc"),
        ] {
            assert_eq!(to_snake_case(i), o, "{i}");
        }
    }

    #[test]
    fn resolves_bare_qualified_and_relative_refs() {
        let registry = default_registry().unwrap();
        let doc =
            r#"{"metadata.root":{"package":"a::b","children":[{"object.value":{"name":"P"}}]}}"#;
        let r = Loader::new(&registry).load_sources(&[("m.json".into(), doc.into())]);
        let idx = crate::validate::util::ObjectIndex::build(&r.tree, r.root);
        assert!(idx.resolve("P", "a::b").is_some());
        assert!(idx.resolve("a::b::P", "").is_some());
        assert!(idx.resolve("::a::b::P", "x").is_some());
        assert!(idx.resolve("..::b::P", "a::c").is_some());
        assert!(idx.resolve("P", "a").is_none());
        assert!(idx.resolve("..::..::..::P", "a::b").is_none());
    }

    #[test]
    fn js_blank_follows_javascript_trim() {
        assert!(js_blank("  \u{feff}\t"));
        assert!(!js_blank("\u{85}"));
        assert!(!js_blank(" x "));
    }
}
