//! Naming: how a metadata name becomes a physical name or a collection name.
//!
//! The Rust port of the TypeScript reference (`metadata/src/naming.ts`), checked by the
//! shared `fixtures/naming-conformance/` corpus. It holds
//!
//! * the string helpers ([`to_snake_case`], [`to_kebab_case`], [`to_pascal_column`],
//!   [`strip_package`], [`package_of_resolution_key`]);
//! * the strategy registry ([`NamingRegistry`]): the built-in column rules, table rules
//!   and pluralizers, and the ones an application registers (ADR-0058 Amendment 1);
//! * the project setting ([`PhysicalNaming`], `naming` in `.metaobjects/config.json`);
//! * both pluralizers: [`pluralize`] for every API and code surface, and the frozen
//!   [`pluralize_table_name_legacy`] for default physical names;
//! * the collection names and REST segments ([`collection_name_of`],
//!   [`collection_segment_of`]);
//! * the node-level resolvers over a loaded [`Tree`] ([`resolve_table_name`],
//!   [`resolve_column_name`], the flattened-column names, [`resolve_index_name`],
//!   [`resolve_table_schema`], [`build_name_map`]);
//! * the collection-name collision refusal ([`assert_no_collection_name_collisions`]).
//!
//! Unlike the TypeScript reference, the registry and the project setting are passed in
//! (a [`NamingCtx`]) rather than read from a process-wide registry and the loaded root:
//! the Rust tree carries no config, and a registry per context cannot leak between
//! tests.
//!
//! Reads follow ADR-0039: resolving accessors by default. The only own-only reads are
//! `@collectionName` (an inherited name would give every subtype one collection), the
//! TPH level walk, and `@dbColumnType`-style physical attrs, none of which this module
//! needs beyond the first two.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use indexmap::IndexMap;

use crate::errors::{ERR_COLLECTION_NAME_COLLISION, ERR_UNKNOWN, MetaError};
use crate::node::{NodeId, PACKAGE_SEP, Tree};

// ---- string helpers ----------------------------------------------------------

/// Strip the package prefix from a qualified name (`pkg::Name` becomes `Name`).
pub fn strip_package(name: &str) -> &str {
    match name.rfind(PACKAGE_SEP) {
        Some(i) => &name[i + PACKAGE_SEP.len()..],
        None => name,
    }
}

/// The package half of a resolution key (`a::b::C` becomes `a::b`; a bare `C` becomes `""`).
pub fn package_of_resolution_key(fqn: &str) -> &str {
    match fqn.rfind(PACKAGE_SEP) {
        Some(i) => &fqn[..i],
        None => "",
    }
}

/// snake_case with an acronym-aware split (`URLHost` becomes `url_host`, `taxID` becomes
/// `tax_id`). The two regex passes of the reference, written as local rules: an upper
/// case letter after an upper case letter and before a lower case one starts a word, and
/// so does an upper case letter after a lower case letter or digit. ASCII classes only.
pub fn to_snake_case(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    // Pass 1: ([A-Z]+)([A-Z][a-z]) -> $1_$2
    let mut pass1 = String::with_capacity(s.len() + 4);
    for (k, &c) in chars.iter().enumerate() {
        if k > 0
            && c.is_ascii_uppercase()
            && chars[k - 1].is_ascii_uppercase()
            && chars.get(k + 1).is_some_and(|n| n.is_ascii_lowercase())
        {
            pass1.push('_');
        }
        pass1.push(c);
    }
    // Pass 2: ([a-z0-9])([A-Z]) -> $1_$2
    let chars: Vec<char> = pass1.chars().collect();
    let mut pass2 = String::with_capacity(pass1.len() + 4);
    for (k, &c) in chars.iter().enumerate() {
        if k > 0
            && c.is_ascii_uppercase()
            && (chars[k - 1].is_ascii_lowercase() || chars[k - 1].is_ascii_digit())
        {
            pass2.push('_');
        }
        pass2.push(c);
    }
    pass2.to_lowercase()
}

/// kebab-case: [`to_snake_case`] with `-` for `_`.
pub fn to_kebab_case(s: &str) -> String {
    to_snake_case(s).replace('_', "-")
}

/// The `pascal` column rule: the first letter upper-cased, nothing else changed
/// (`createdAt` becomes `CreatedAt`, `requestURL` becomes `RequestURL`).
///
/// One UTF-16 unit in and one out, as the other ports do: a letter whose upper case is
/// several characters (`ß`) or that is outside the basic plane stays as written.
pub fn to_pascal_column(s: &str) -> String {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut upper = first.to_uppercase();
    let replaced = match (upper.next(), upper.next()) {
        (Some(u), None) if first.len_utf16() == 1 && u.len_utf16() == 1 => u,
        _ => first,
    };
    let mut out = String::with_capacity(s.len());
    out.push(replaced);
    out.push_str(chars.as_str());
    out
}

// ---- pluralizers -------------------------------------------------------------

/// True when `s` already reads as a plural noun (`Stats`, `Settings`, `Series`): it ends
/// in `s` and the letter before that `s` is not one of s/u/i/a (`Status`, `Address`,
/// `Bonus`, `Alias`, `Gas` stay on the ordinary suffix path). A heuristic, not a
/// dictionary: `Lens` reads as already plural too.
fn is_already_plural(s: &str) -> bool {
    let mut rev = s.chars().rev();
    let (Some(last), Some(prev)) = (rev.next(), rev.next()) else {
        return false;
    };
    last.eq_ignore_ascii_case(&'s') && !matches!(prev.to_ascii_lowercase(), 's' | 'u' | 'i' | 'a')
}

/// The FROZEN suffix-only pluralizer: the default PHYSICAL name derivation, with no
/// already-plural detection. Changing it would make `meta migrate` propose a rename for
/// every already-plural entity name of an existing database. Never use it for an API or
/// code-surface name; those go through [`pluralize`].
pub fn pluralize_table_name_legacy(s: &str) -> String {
    let lower = s.to_ascii_lowercase();
    if lower.ends_with(['s', 'x', 'z']) || lower.ends_with("ch") || lower.ends_with("sh") {
        return format!("{s}es");
    }
    let mut rev = s.chars().rev();
    if let (Some(y), Some(before)) = (rev.next(), rev.next())
        && y.eq_ignore_ascii_case(&'y')
        && !matches!(before.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u')
    {
        let mut out = s.to_string();
        out.pop();
        out.push_str("ies");
        return out;
    }
    format!("{s}s")
}

/// API and code-surface pluralization: REST segments, generated hook, query, finder and
/// list names, collection variable names. Already-plural detection first, then the
/// suffix rule.
pub fn pluralize(s: &str) -> String {
    if is_already_plural(s) {
        s.to_string()
    } else {
        pluralize_table_name_legacy(s)
    }
}

// ---- strategies and the registry ---------------------------------------------

/// A naming strategy: a bare metadata name in, a physical (or collection) name out.
pub type NamingFunction = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// The column rules every port builds in, in the order the corpus lists them.
pub const BUILTIN_COLUMN_NAMING_STRATEGIES: [&str; 4] =
    ["snake_case", "literal", "kebab-case", "pascal"];
/// The table rules every port builds in.
pub const BUILTIN_TABLE_NAMING_RULES: [&str; 2] = ["snake_case", "literal"];
/// The pluralizers every port builds in.
pub const BUILTIN_PLURALIZER_NAMES: [&str; 2] = ["standard", "none"];
/// The pluralizer a project gets when `naming.collections` is absent.
pub const DEFAULT_PLURALIZER: &str = "standard";
/// The default column strategy in every port.
pub const DEFAULT_COLUMN_NAMING_STRATEGY: &str = "snake_case";
/// The default table rule in every port.
pub const DEFAULT_TABLE_NAMING_RULE: &str = "snake_case";

/// The port name every unknown-strategy message carries.
const NAMING_PORT: &str = "Rust";

/// The kinds of naming strategy a project selects in `naming` (ADR-0058).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamingKind {
    Columns,
    Tables,
    Collections,
}

impl NamingKind {
    /// The key in the `naming` block.
    pub fn key(self) -> &'static str {
        match self {
            NamingKind::Columns => "columns",
            NamingKind::Tables => "tables",
            NamingKind::Collections => "collections",
        }
    }

    fn label(self) -> &'static str {
        match self {
            NamingKind::Columns => "column-naming",
            NamingKind::Tables => "table-naming",
            NamingKind::Collections => "collection-naming (pluralizer)",
        }
    }

    fn builtins(self) -> &'static [&'static str] {
        match self {
            NamingKind::Columns => &BUILTIN_COLUMN_NAMING_STRATEGIES,
            NamingKind::Tables => &BUILTIN_TABLE_NAMING_RULES,
            NamingKind::Collections => &BUILTIN_PLURALIZER_NAMES,
        }
    }
}

/// The named strategies a project may select: the built-ins and the application's.
#[derive(Clone)]
pub struct NamingRegistry {
    columns: IndexMap<String, NamingFunction>,
    tables: IndexMap<String, NamingFunction>,
    collections: IndexMap<String, NamingFunction>,
}

impl fmt::Debug for NamingRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NamingRegistry")
            .field("columns", &self.columns.keys().collect::<Vec<_>>())
            .field("tables", &self.tables.keys().collect::<Vec<_>>())
            .field("collections", &self.collections.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl Default for NamingRegistry {
    fn default() -> Self {
        Self::builtin()
    }
}

fn func(f: impl Fn(&str) -> String + Send + Sync + 'static) -> NamingFunction {
    Arc::new(f)
}

impl NamingRegistry {
    /// A registry holding only the built-ins.
    pub fn builtin() -> Self {
        let mut columns: IndexMap<String, NamingFunction> = IndexMap::new();
        columns.insert("snake_case".into(), func(to_snake_case));
        columns.insert("literal".into(), func(str::to_string));
        columns.insert("kebab-case".into(), func(to_kebab_case));
        columns.insert("pascal".into(), func(to_pascal_column));
        let mut tables: IndexMap<String, NamingFunction> = IndexMap::new();
        tables.insert("snake_case".into(), func(to_snake_case));
        tables.insert("literal".into(), func(str::to_string));
        let mut collections: IndexMap<String, NamingFunction> = IndexMap::new();
        collections.insert("standard".into(), func(pluralize));
        collections.insert("none".into(), func(str::to_string));
        Self {
            columns,
            tables,
            collections,
        }
    }

    fn map(&self, kind: NamingKind) -> &IndexMap<String, NamingFunction> {
        match kind {
            NamingKind::Columns => &self.columns,
            NamingKind::Tables => &self.tables,
            NamingKind::Collections => &self.collections,
        }
    }

    /// Register under `name`. A built-in cannot be replaced; registering a name of your
    /// own again replaces it (an application registers once at startup).
    pub fn register(
        &mut self,
        kind: NamingKind,
        name: &str,
        apply: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> Result<(), MetaError> {
        if name.is_empty() {
            return Err(MetaError::code(
                ERR_UNKNOWN,
                format!("a {} strategy needs a non-empty name", kind.label()),
            ));
        }
        if kind.builtins().contains(&name) {
            return Err(MetaError::code(
                ERR_UNKNOWN,
                format!(
                    "\"{name}\" is a built in {} strategy and cannot be replaced; register yours under another name",
                    kind.label()
                ),
            ));
        }
        let map = match kind {
            NamingKind::Columns => &mut self.columns,
            NamingKind::Tables => &mut self.tables,
            NamingKind::Collections => &mut self.collections,
        };
        map.insert(name.to_string(), func(apply));
        Ok(())
    }

    /// Register a named column strategy.
    pub fn register_column_strategy(
        &mut self,
        name: &str,
        apply: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> Result<(), MetaError> {
        self.register(NamingKind::Columns, name, apply)
    }

    /// Register a named table rule.
    pub fn register_table_rule(
        &mut self,
        name: &str,
        apply: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> Result<(), MetaError> {
        self.register(NamingKind::Tables, name, apply)
    }

    /// Register a named pluralizer (an object name in, its collection name out).
    pub fn register_pluralizer(
        &mut self,
        name: &str,
        apply: impl Fn(&str) -> String + Send + Sync + 'static,
    ) -> Result<(), MetaError> {
        self.register(NamingKind::Collections, name, apply)
    }

    pub fn has_column_strategy(&self, name: &str) -> bool {
        self.columns.contains_key(name)
    }

    pub fn has_table_rule(&self, name: &str) -> bool {
        self.tables.contains_key(name)
    }

    pub fn has_pluralizer(&self, name: &str) -> bool {
        self.collections.contains_key(name)
    }

    /// Whether a strategy of `kind` is registered under `name`.
    pub fn has(&self, kind: NamingKind, name: &str) -> bool {
        self.map(kind).contains_key(name)
    }

    /// Every registered column strategy name: built-ins in corpus order, then the application's.
    pub fn column_strategy_names(&self) -> Vec<&str> {
        self.columns.keys().map(String::as_str).collect()
    }

    /// Every registered table rule name.
    pub fn table_rule_names(&self) -> Vec<&str> {
        self.tables.keys().map(String::as_str).collect()
    }

    /// Every registered pluralizer name.
    pub fn pluralizer_names(&self) -> Vec<&str> {
        self.collections.keys().map(String::as_str).collect()
    }

    /// What every port says when a config names a strategy nothing registered answers.
    /// Same words as the reference, with this port's name.
    pub fn unknown_strategy_message(&self, kind: NamingKind, name: &str) -> String {
        let builtins = kind.builtins();
        let registered: Vec<&str> = self
            .map(kind)
            .keys()
            .map(String::as_str)
            .filter(|n| !builtins.contains(n))
            .collect();
        format!(
            "\"naming.{}\" names \"{name}\", which no {} strategy registered in the \
             {NAMING_PORT} port answers (built in: {}; registered by the application: {}). \
             Register it before .metaobjects/config.json is read, or correct the name.",
            kind.key(),
            kind.label(),
            builtins.join(", "),
            if registered.is_empty() {
                "none".to_string()
            } else {
                registered.join(", ")
            },
        )
    }

    fn get(&self, kind: NamingKind, name: &str) -> Result<&NamingFunction, MetaError> {
        self.map(kind)
            .get(name)
            .ok_or_else(|| MetaError::code(ERR_UNKNOWN, self.unknown_strategy_message(kind, name)))
    }

    /// The column strategy registered as `name`; an error naming it when nothing answers.
    pub fn column_strategy(&self, name: &str) -> Result<&NamingFunction, MetaError> {
        self.get(NamingKind::Columns, name)
    }

    /// The table rule registered as `name`.
    pub fn table_rule(&self, name: &str) -> Result<&NamingFunction, MetaError> {
        self.get(NamingKind::Tables, name)
    }

    /// The pluralizer registered as `name`.
    pub fn pluralizer(&self, name: &str) -> Result<&NamingFunction, MetaError> {
        self.get(NamingKind::Collections, name)
    }

    /// `name` cased by the table rule registered as `rule`.
    pub fn apply_table_naming_rule(&self, name: &str, rule: &str) -> Result<String, MetaError> {
        Ok(self.table_rule(rule)?(name))
    }

    /// `name` through the column strategy registered as `strategy`: the one door every
    /// column resolution goes through. An unregistered name is an error, never a silent
    /// fallback to the default.
    pub fn apply_column_naming_strategy(
        &self,
        name: &str,
        strategy: &str,
    ) -> Result<String, MetaError> {
        Ok(self.column_strategy(strategy)?(name))
    }
}

// ---- the project setting -----------------------------------------------------

/// The project's physical-naming rules: `naming` in `.metaobjects/config.json` (ADR-0058).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhysicalNaming {
    /// The column strategy name.
    pub columns: String,
    /// The table rule name.
    pub tables: String,
    /// The pluralizer name for an object with no `@collectionName`; `None` is
    /// [`DEFAULT_PLURALIZER`] for collection names, and "not configured" for REST segments.
    pub collections: Option<String>,
}

impl Default for PhysicalNaming {
    fn default() -> Self {
        Self {
            columns: DEFAULT_COLUMN_NAMING_STRATEGY.to_string(),
            tables: DEFAULT_TABLE_NAMING_RULE.to_string(),
            collections: None,
        }
    }
}

/// A registry and the project setting, passed to every node-level resolver.
#[derive(Debug, Clone, Copy)]
pub struct NamingCtx<'a> {
    pub registry: &'a NamingRegistry,
    pub naming: &'a PhysicalNaming,
}

impl<'a> NamingCtx<'a> {
    pub fn new(registry: &'a NamingRegistry, naming: &'a PhysicalNaming) -> Self {
        Self { registry, naming }
    }
}

// ---- collection names and segments ---------------------------------------------

/// snake_case a collection name with an acronym-aware split: a trailing plural `s` or
/// `es` after a capital is a suffix of the acronym, not a word (`FAQs` becomes `faqs`,
/// `TaxIDs` becomes `tax_ids`, `PDFBoxes` becomes `pdf_boxes`).
pub fn snake_collection_name(s: &str) -> String {
    if let Some(t) = s.strip_suffix('s') {
        if t.ends_with(|c: char| c.is_ascii_uppercase()) {
            return format!("{}s", to_snake_case(t));
        }
        if let Some(u) = t.strip_suffix('e')
            && u.ends_with(|c: char| c.is_ascii_uppercase())
        {
            return format!("{}es", to_snake_case(u));
        }
    }
    to_snake_case(s)
}

/// The REST collection segment for an object named `name`
/// (`fixtures/naming-conformance/collection-segments.json`): a declared
/// `@collectionName` wins, snake-cased; else a configured pluralizer's output over the
/// name, snake-cased the same way; else the historical rule, snake_case then [`pluralize`].
pub fn collection_segment_of(
    registry: &NamingRegistry,
    name: &str,
    declared: Option<&str>,
    configured_pluralizer: Option<&str>,
) -> Result<String, MetaError> {
    if let Some(d) = declared {
        return Ok(snake_collection_name(d));
    }
    if let Some(p) = configured_pluralizer {
        return Ok(snake_collection_name(&registry.pluralizer(p)?(name)));
    }
    Ok(pluralize(&to_snake_case(name)))
}

const OBJECT_ATTR_COLLECTION_NAME: &str = "collectionName";

/// The collection name an object declares itself (`@collectionName`), if any.
pub fn declared_collection_name(tree: &Tree, obj: NodeId) -> Option<String> {
    // ADR-0039: own-only on purpose. A name inherited from an abstract base would give
    // every subtype one collection.
    match tree.own_attr(obj, OBJECT_ATTR_COLLECTION_NAME) {
        Some(a) => a
            .value
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        None => None,
    }
}

/// An object's collection name in its own casing: its `@collectionName`, else the
/// project's pluralizer over its name.
pub fn collection_name_of(
    tree: &Tree,
    obj: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    if let Some(d) = declared_collection_name(tree, obj) {
        return Ok(d);
    }
    let p = ctx
        .naming
        .collections
        .as_deref()
        .unwrap_or(DEFAULT_PLURALIZER);
    Ok(ctx.registry.pluralizer(p)?(&tree.node(obj).name))
}

/// The REST collection segment an object is served under.
pub fn collection_segment(
    tree: &Tree,
    obj: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    collection_segment_of(
        ctx.registry,
        &tree.node(obj).name,
        declared_collection_name(tree, obj).as_deref(),
        ctx.naming.collections.as_deref(),
    )
}

// ---- node-level resolvers --------------------------------------------------------

const TYPE_FIELD: &str = "field";
const TYPE_OBJECT: &str = "object";
const TYPE_SOURCE: &str = "source";
const SUBTYPE_RDB: &str = "rdb";
const SUBTYPE_VALUE: &str = "value";
const ATTR_COLUMN: &str = "column";
const ATTR_FLATTENED_PREFIX: &str = "flattenedColumnPrefix";
const ATTR_SCHEMA: &str = "schema";
const ATTR_KIND: &str = "kind";
const ATTR_ROLE: &str = "role";
const ATTR_TABLE: &str = "table";
const ATTR_DISCRIMINATOR: &str = "discriminator";
const ATTR_DISCRIMINATOR_VALUE: &str = "discriminatorValue";
const DEFAULT_SOURCE_KIND: &str = "table";
const DEFAULT_SOURCE_ROLE: &str = "primary";
const ROLE_PRIMARY: &str = "primary";
const READ_ONLY_KINDS: [&str; 4] = ["view", "materializedView", "storedProc", "tableFunction"];

/// The kind-matching physical-name alias of a `source.rdb` `@kind`.
fn physical_name_attr_for_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "table" => Some("table"),
        "view" => Some("view"),
        "materializedView" => Some("materializedView"),
        "storedProc" => Some("proc"),
        "tableFunction" => Some("function"),
        _ => None,
    }
}

fn str_attr<'t>(tree: &'t Tree, id: NodeId, name: &str) -> Option<&'t str> {
    tree.attr(id, name)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
}

/// True for a `source.rdb` node.
pub fn is_rdb_source(tree: &Tree, id: NodeId) -> bool {
    let n = tree.node(id);
    n.type_name == TYPE_SOURCE && n.sub_type == SUBTYPE_RDB
}

/// The effective `@kind` of a source (default `table`).
pub fn source_effective_kind(tree: &Tree, source: NodeId) -> &str {
    str_attr(tree, source, ATTR_KIND).unwrap_or(DEFAULT_SOURCE_KIND)
}

/// The effective `@role` of a source (default `primary`).
pub fn source_role(tree: &Tree, source: NodeId) -> &str {
    str_attr(tree, source, ATTR_ROLE).unwrap_or(DEFAULT_SOURCE_ROLE)
}

/// True when the source's effective kind is read-only.
pub fn source_is_read_only(tree: &Tree, source: NodeId) -> bool {
    READ_ONLY_KINDS.contains(&source_effective_kind(tree, source))
}

/// Resolved physical SQL name of a source, by the four-step rule (FR-016, ADR-0018):
/// the kind-matching alias, then `@table` for a non-table kind, then the source's own
/// structural name cased by the table rule, then the owning entity's name cased by the
/// table rule through the frozen legacy pluralizer.
pub fn source_physical_name(
    tree: &Tree,
    source: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    let kind = source_effective_kind(tree, source);
    let canonical = physical_name_attr_for_kind(kind);
    if let Some(attr) = canonical
        && let Some(v) = str_attr(tree, source, attr)
    {
        return Ok(v.to_string());
    }
    if canonical != Some(ATTR_TABLE)
        && let Some(v) = str_attr(tree, source, ATTR_TABLE)
    {
        return Ok(v.to_string());
    }
    let node = tree.node(source);
    if !node.name.is_empty() {
        return ctx
            .registry
            .apply_table_naming_rule(&node.name, &ctx.naming.tables);
    }
    if let Some(owner) = node.parent {
        let owner_name = &tree.node(owner).name;
        if !owner_name.is_empty() {
            let cased = ctx
                .registry
                .apply_table_naming_rule(owner_name, &ctx.naming.tables)?;
            return Ok(pluralize_table_name_legacy(&cased));
        }
    }
    Ok(String::new())
}

/// The resolved address of a source, rendered as the primary-source divergence refusal
/// compares it: `"schema"."name" (kind)`.
pub fn source_address_key(
    tree: &Tree,
    source: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    // RAW on purpose: an absent @schema is not folded into a dialect default.
    let qualifier = str_attr(tree, source, ATTR_SCHEMA)
        .map(|s| format!("\"{s}\"."))
        .unwrap_or_default();
    Ok(format!(
        "{qualifier}\"{}\" ({})",
        source_physical_name(tree, source, ctx)?,
        source_effective_kind(tree, source)
    ))
}

/// The `@role: primary` source of an entity, and the one place the divergence refusal
/// lives. Effective children, so a TPH subtype resolves to its base's source. `None`
/// when the object declares no primary source. Several primaries on distinct physical
/// addresses are refused.
pub fn primary_rdb_source(
    tree: &Tree,
    entity: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<Option<NodeId>, MetaError> {
    let primaries: Vec<NodeId> = tree
        .children(entity)
        .iter()
        .copied()
        .filter(|&c| is_rdb_source(tree, c) && source_role(tree, c) == ROLE_PRIMARY)
        .collect();
    let Some(&first) = primaries.first() else {
        return Ok(None);
    };
    let mut distinct: Vec<String> = Vec::new();
    for &p in &primaries {
        let key = source_address_key(tree, p, ctx)?;
        if !distinct.contains(&key) {
            distinct.push(key);
        }
    }
    if distinct.len() > 1 {
        distinct.sort();
        return Err(MetaError::code(
            ERR_UNKNOWN,
            format!(
                "{}: role=primary sources disagree on the object's physical address — {}. \
                 Every consumer binds ONE address. Give them a matching @kind, @schema \
                 and physical name, or drop the extra role=primary declaration.",
                tree.node(entity).name,
                distinct.join(" vs ")
            ),
        ));
    }
    Ok(Some(first))
}

/// The table name of an entity: its primary source's physical name, else the entity name
/// cased by the table rule through the frozen legacy pluralizer.
pub fn resolve_table_name(
    tree: &Tree,
    entity: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    if let Some(source) = primary_rdb_source(tree, entity, ctx)? {
        return source_physical_name(tree, source, ctx);
    }
    let cased = ctx
        .registry
        .apply_table_naming_rule(&tree.node(entity).name, &ctx.naming.tables)?;
    Ok(pluralize_table_name_legacy(&cased))
}

/// The schema declared on an entity's primary source, if any.
pub fn resolve_table_schema(
    tree: &Tree,
    entity: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<Option<String>, MetaError> {
    Ok(primary_rdb_source(tree, entity, ctx)?
        .and_then(|s| str_attr(tree, s, ATTR_SCHEMA).map(str::to_string)))
}

/// A field's column: its `@column`, else its name through the column strategy
/// (`strategy` defaults to the project's).
pub fn resolve_column_name_with(
    tree: &Tree,
    field: NodeId,
    ctx: &NamingCtx<'_>,
    strategy: &str,
) -> Result<String, MetaError> {
    // ADR-0039: resolving. A concrete field may inherit @column via extends.
    if let Some(col) = str_attr(tree, field, ATTR_COLUMN) {
        return Ok(col.to_string());
    }
    ctx.registry
        .apply_column_naming_strategy(&tree.node(field).name, strategy)
}

/// [`resolve_column_name_with`] under the project's column strategy.
pub fn resolve_column_name(
    tree: &Tree,
    field: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    resolve_column_name_with(tree, field, ctx, &ctx.naming.columns)
}

/// The text before each member's column when `field` (a flattened `field.object`)
/// expands its value object into the owning table: its `@flattenedColumnPrefix`
/// verbatim (`""` allowed), else its own resolved column and `_`.
pub fn resolve_flattened_column_prefix(
    tree: &Tree,
    field: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    // ADR-0039: resolving. The prefix and @column may be inherited through extends.
    if let Some(prefix) = tree
        .attr(field, ATTR_FLATTENED_PREFIX)
        .and_then(|v| v.as_str())
    {
        return Ok(prefix.to_string());
    }
    Ok(resolve_column_name(tree, field, ctx)? + "_")
}

/// The column a member of a flattened value object gets in the owning table.
pub fn resolve_flattened_column_name(
    tree: &Tree,
    field: NodeId,
    member: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<String, MetaError> {
    Ok(resolve_flattened_column_prefix(tree, field, ctx)?
        + &resolve_column_name(tree, member, ctx)?)
}

/// An index's database name: the metamodel `name` with any package qualifier stripped.
/// An empty name is refused, as nothing could be emitted.
pub fn resolve_index_name(
    type_name: &str,
    sub_type: &str,
    name: &str,
) -> Result<String, MetaError> {
    let short = strip_package(name);
    if short.is_empty() {
        return Err(MetaError::code(
            ERR_UNKNOWN,
            format!(
                "{type_name}.{sub_type} declares an empty name; an index's database name IS \
                 its metamodel name, so there is nothing to emit. Give it a name."
            ),
        ));
    }
    Ok(short.to_string())
}

/// Per-entity `{name <-> column}` maps, built once per entity.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EntityNameMap {
    pub js_to_db: HashMap<String, String>,
    pub db_to_js: HashMap<String, String>,
}

/// Build the name map over the entity's effective fields (a TPH subtype's map covers the
/// inherited base fields and its own).
pub fn build_name_map(
    tree: &Tree,
    entity: NodeId,
    ctx: &NamingCtx<'_>,
) -> Result<EntityNameMap, MetaError> {
    let mut map = EntityNameMap::default();
    for &child in tree.children(entity).iter() {
        if tree.node(child).type_name != TYPE_FIELD {
            continue;
        }
        let col = resolve_column_name(tree, child, ctx)?;
        let name = tree.node(child).name.clone();
        map.db_to_js.insert(col.clone(), name.clone());
        map.js_to_db.insert(name, col);
    }
    Ok(map)
}

// ---- collection-name collision refusal -------------------------------------------

/// Where the generated entity modules live: one directory, or one per metadata package.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputLayout {
    #[default]
    Flat,
    Package,
}

/// Which name sets a run emits, and the layout of its entity modules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollectionNameScopes {
    pub layout: OutputLayout,
    /// Whether the pluralized module names are checked.
    pub modules: bool,
    /// Whether the REST segments are checked.
    pub routes: bool,
}

impl Default for CollectionNameScopes {
    fn default() -> Self {
        Self {
            layout: OutputLayout::Flat,
            modules: true,
            routes: true,
        }
    }
}

fn is_abstract(tree: &Tree, obj: NodeId) -> bool {
    tree.node(obj).is_abstract
}

/// True when the object emits instance artifacts: not abstract and declaring or
/// inheriting a `source.rdb` (#248: participation derives from a declared source).
pub fn emits_instance_artifacts(tree: &Tree, obj: NodeId) -> bool {
    !is_abstract(tree, obj) && tree.children(obj).iter().any(|&c| is_rdb_source(tree, c))
}

/// True when the object is a TPH subtype: it declares `@discriminatorValue` and an
/// ancestor declares `@discriminator`.
pub fn is_tph_subtype(tree: &Tree, obj: NodeId) -> bool {
    // ADR-0039: own-only on purpose. A subtype declares its OWN @discriminatorValue and
    // the base level is found by walking each ancestor's OWN @discriminator.
    let has_value = tree
        .own_attr(obj, ATTR_DISCRIMINATOR_VALUE)
        .and_then(|a| a.value.as_str())
        .is_some_and(|s| !s.is_empty());
    if !has_value {
        return false;
    }
    let mut seen = vec![obj];
    let mut cur = tree.node(obj).super_node;
    while let Some(n) = cur {
        if seen.contains(&n) {
            break;
        }
        seen.push(n);
        // ADR-0039: own-only, see above.
        if tree
            .own_attr(n, ATTR_DISCRIMINATOR)
            .and_then(|a| a.value.as_str())
            .is_some_and(|s| !s.is_empty())
        {
            return true;
        }
        cur = tree.node(n).super_node;
    }
    false
}

fn capitalize_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn collision(message: String) -> MetaError {
    MetaError::code(ERR_COLLECTION_NAME_COLLISION, message)
}

/// Refuse two objects that claim one generated name in ONE scope. There is no run-wide
/// rule: a name collides only where the artifact carrying it lives. The pluralized names
/// are exports of the entity modules (one scope under the flat layout, one per package
/// under the package layout); the REST segment is unique across every routed object.
/// Counted over the objects that emit those names ([`emits_instance_artifacts`]), so an
/// abstract or sourceless object is in no scope. Deterministic: the first object to
/// claim a name owns it, and the error names the second. The error code is
/// `ERR_COLLECTION_NAME_COLLISION`.
pub fn assert_no_collection_name_collisions(
    tree: &Tree,
    objects: &[NodeId],
    scopes: &CollectionNameScopes,
    ctx: &NamingCtx<'_>,
) -> Result<(), MetaError> {
    if scopes.modules {
        assert_no_module_name_collisions(tree, objects, scopes.layout, ctx)?;
    }
    if scopes.routes {
        assert_no_route_segment_collisions(tree, objects, ctx)?;
    }
    Ok(())
}

fn assert_no_module_name_collisions(
    tree: &Tree,
    objects: &[NodeId],
    layout: OutputLayout,
    ctx: &NamingCtx<'_>,
) -> Result<(), MetaError> {
    let mut owner: HashMap<(String, String), NodeId> = HashMap::new();
    for &obj in objects {
        if tree.node(obj).sub_type == SUBTYPE_VALUE || !emits_instance_artifacts(tree, obj) {
            continue;
        }
        let plural = capitalize_first(&collection_name_of(tree, obj, ctx)?);
        let scope = match layout {
            OutputLayout::Package => tree.effective_package(obj),
            OutputLayout::Flat => String::new(),
        };
        let key = (scope.clone(), plural.clone());
        match owner.get(&key) {
            Some(&existing) if tree.resolution_key(existing) != tree.resolution_key(obj) => {
                return Err(collision(format!(
                    "\"{}\" and \"{}\" both pluralize to the collection name \"{plural}\" in one \
                     module scope ({}; generated hook/query/finder/list names, the collection \
                     variable) — rename one entity, give one a distinct @collectionName, or \
                     place the modules by package (outputLayout: \"package\"). Default PHYSICAL \
                     table names are unaffected by this rule.",
                    tree.resolution_key(existing),
                    tree.resolution_key(obj),
                    if scope.is_empty() {
                        "the entity modules' directory".to_string()
                    } else {
                        format!("package {scope}")
                    }
                )));
            }
            Some(_) => {}
            None => {
                owner.insert(key, obj);
            }
        }
    }
    Ok(())
}

fn assert_no_route_segment_collisions(
    tree: &Tree,
    objects: &[NodeId],
    ctx: &NamingCtx<'_>,
) -> Result<(), MetaError> {
    let mut owner: HashMap<String, NodeId> = HashMap::new();
    for &obj in objects {
        if tree.node(obj).sub_type == SUBTYPE_VALUE
            || !emits_instance_artifacts(tree, obj)
            || is_tph_subtype(tree, obj)
        {
            continue;
        }
        let segment = collection_segment(tree, obj, ctx)?;
        match owner.get(&segment) {
            Some(&existing) if tree.resolution_key(existing) != tree.resolution_key(obj) => {
                return Err(collision(format!(
                    "\"{}\" and \"{}\" both resolve to the REST collection segment \"{segment}\" \
                     — rename one entity, or give one a distinct @collectionName, so its route \
                     segment is distinct.",
                    tree.resolution_key(existing),
                    tree.resolution_key(obj),
                )));
            }
            Some(_) => {}
            None => {
                owner.insert(segment, obj);
            }
        }
    }
    Ok(())
}

/// Every top-level `object.*` of a loaded tree, in declaration order: the set a run
/// hands to [`assert_no_collection_name_collisions`].
pub fn top_level_objects(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    tree.children(root)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_OBJECT)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_case_handles_acronyms() {
        for (input, want) in [
            ("URLHost", "url_host"),
            ("TaxID", "tax_id"),
            ("FAQs", "fa_qs"),
            ("HTTPRequest", "http_request"),
            ("requestURL", "request_url"),
            ("createdAt", "created_at"),
            ("address_line1", "address_line1"),
            ("line1Item", "line1_item"),
            ("ABcDEf", "a_bc_d_ef"),
            ("ID", "id"),
            ("", ""),
            ("already_snake", "already_snake"),
        ] {
            assert_eq!(to_snake_case(input), want, "{input}");
        }
    }

    #[test]
    fn kebab_and_pascal() {
        assert_eq!(to_kebab_case("unitPriceCents"), "unit-price-cents");
        assert_eq!(to_kebab_case("URLHost"), "url-host");
        assert_eq!(to_pascal_column("createdAt"), "CreatedAt");
        assert_eq!(to_pascal_column("requestURL"), "RequestURL");
        assert_eq!(to_pascal_column("address_line1"), "Address_line1");
        assert_eq!(to_pascal_column("npi"), "Npi");
        assert_eq!(to_pascal_column(""), "");
        // One UTF-16 unit in, one out: `ß` and a non-BMP letter stay as written.
        assert_eq!(to_pascal_column("ßeta"), "ßeta");
        assert_eq!(to_pascal_column("\u{10428}x"), "\u{10428}x");
        assert_eq!(to_pascal_column("éa"), "Éa");
    }

    #[test]
    fn package_helpers() {
        assert_eq!(strip_package("a::b::C"), "C");
        assert_eq!(strip_package("C"), "C");
        assert_eq!(strip_package(""), "");
        assert_eq!(package_of_resolution_key("a::b::C"), "a::b");
        assert_eq!(package_of_resolution_key("C"), "");
    }

    #[test]
    fn snake_collection_names_keep_plural_acronym_suffix() {
        for (input, want) in [
            ("FAQs", "faqs"),
            ("TaxIDs", "tax_ids"),
            ("PDFBoxes", "pdf_boxes"),
            ("queues", "queues"),
            ("ConsignmentHistory", "consignment_history"),
            ("Stats", "stats"),
            ("Bs", "bs"),
        ] {
            assert_eq!(snake_collection_name(input), want, "{input}");
        }
    }

    #[test]
    fn pluralizers() {
        assert_eq!(pluralize("Stats"), "Stats");
        assert_eq!(pluralize("Status"), "Statuses");
        assert_eq!(pluralize("Lens"), "Lens");
        assert_eq!(pluralize("s"), "ses");
        assert_eq!(pluralize("Category"), "Categories");
        assert_eq!(pluralize("Day"), "Days");
        assert_eq!(pluralize("BOX"), "BOXes");
        assert_eq!(pluralize("Match"), "Matches");
        assert_eq!(pluralize_table_name_legacy("Stats"), "Statses");
        assert_eq!(pluralize_table_name_legacy("y"), "ys");
        assert_eq!(pluralize_table_name_legacy("KEY"), "KEYs");
        assert_eq!(pluralize_table_name_legacy("COMPANY"), "COMPANies");
    }

    #[test]
    fn registry_registration_rules() {
        let mut r = NamingRegistry::builtin();
        assert!(r.has_column_strategy("pascal"));
        assert!(!r.has_table_rule("pascal"));
        assert!(r.has_pluralizer("none"));
        assert!(r.register_column_strategy("pascal", |n| n.into()).is_err());
        assert!(r.register_column_strategy("", |n| n.into()).is_err());
        r.register_column_strategy("shout", |n| n.to_ascii_uppercase())
            .unwrap();
        // Registering again replaces.
        r.register_column_strategy("shout", |n| format!("{n}!"))
            .unwrap();
        assert_eq!(r.apply_column_naming_strategy("a", "shout").unwrap(), "a!");
        assert_eq!(r.column_strategy_names().last(), Some(&"shout"));
        let err = r.apply_column_naming_strategy("a", "nope").unwrap_err();
        assert!(err.message.contains("\"naming.columns\" names \"nope\""));
        assert!(err.message.contains("registered by the application: shout"));
        assert!(err.message.contains("Rust port"));
        assert!(
            NamingRegistry::default()
                .unknown_strategy_message(NamingKind::Tables, "x")
                .contains("built in: snake_case, literal; registered by the application: none")
        );
    }

    #[test]
    fn index_names() {
        assert_eq!(
            resolve_index_name("index", "lookup", "acme::by_name").unwrap(),
            "by_name"
        );
        assert!(resolve_index_name("index", "lookup", "").is_err());
        assert!(resolve_index_name("index", "lookup", "pkg::").is_err());
    }
}
