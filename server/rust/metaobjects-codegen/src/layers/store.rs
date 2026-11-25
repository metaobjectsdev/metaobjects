//! The stored-entity walk: which entities a store crate reads and writes, with their table,
//! columns, key, lifecycle fields and traversals. The `repository` generator renders it, and
//! the `service` generator builds its operations over the same walk, so the two agree by
//! construction and an owned copy of either keeps calling it.

use std::collections::{BTreeMap, BTreeSet};

use metaobjects::naming::{
    NamingCtx, NamingRegistry, is_tph_subtype, resolve_column_name, resolve_table_name,
    resolve_table_schema, source_is_read_only, source_physical_name,
};
use metaobjects::node::{NodeId, Tree};
use metaobjects::rules_names::rules_names_of;
use metaobjects::validate::relationships::derive_m2m_fields;
use metaobjects::validate::util::ObjectIndex;

use crate::generator::{ERR_UNSUPPORTED, GenContext, GenError};
use crate::names::literal;
use crate::plan::{FieldPlan, Kind, Plan, Route, STORE_SUFFIX, SUPPORT_CRATE, StructPlan, Ty};

const ATTR_DISCRIMINATOR: &str = "discriminator";
const ATTR_DB_COLUMN_TYPE: &str = "dbColumnType";
const ATTR_DISCRIMINATOR_VALUE: &str = "discriminatorValue";
const ATTR_INT_VALUE_MAP: &str = "intValueMap";
const ATTR_STRING_VALUE_MAP: &str = "stringValueMap";
const ATTR_STORAGE: &str = "storage";
const STORAGE_FLATTENED: &str = "flattened";
const TYPE_ORIGIN: &str = "origin";
const TYPE_SOURCE: &str = "source";
const ATTR_SCHEMA: &str = "schema";
const TYPE_RELATIONSHIP: &str = "relationship";

/// One column of a stored entity, as `TABLE` describes it.
#[derive(Debug, Clone)]
pub struct ColumnPlan {
    pub field: String,
    pub column: String,
    /// The `meta_store::Kind` expression.
    pub kind: String,
    pub array: bool,
    /// For an enum stored as other values, the const that holds its map: its name, its type
    /// and each `(member, stored)` pair as Rust text. `kind` names the const.
    pub map: Option<(String, &'static str, Vec<String>)>,
    /// The column's own SQL type, from `@dbColumnType`.
    pub stored_as: Option<String>,
}

/// One lifecycle of a stored entity: the field and the path of its enum type.
pub struct LifecyclePlan {
    pub field: String,
    /// The field's member on the row type.
    pub ident: String,
    /// The row's member is an `Option`: the field is not `@required`.
    pub optional: bool,
    /// The function's name: `transition_<field in snake case>`.
    pub function: String,
    pub state_type: String,
}

/// One many-to-many relationship of a stored entity: its junction and the reads through it.
pub struct TraversalPlan {
    /// The relationship's name in the model.
    pub relation: String,
    /// The function's name: `<relation in snake case>_of`.
    pub function: String,
    /// The `Through` const's name: the relation in screaming snake case.
    pub constant: String,
    /// The junction entity's name in the model.
    pub junction: String,
    pub schema: Option<String>,
    pub table: String,
    pub source: ColumnPlan,
    pub target: ColumnPlan,
    pub symmetric: bool,
    /// The path of the target's `TABLE`, and of its row type.
    pub target_table: String,
    pub target_row: String,
}

/// One stored entity, with everything its file needs resolved.
pub struct StoredEntity {
    /// The object's name in the model.
    pub object: String,
    /// The object's node.
    pub node: NodeId,
    pub module: String,
    pub row: String,
    pub create: String,
    pub patch: String,
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<ColumnPlan>,
    /// The key field and the type a call takes it as, when the entity has a single key of
    /// text or a whole number.
    pub key: Option<(String, String)>,
    /// Every field of the primary identity, for `TABLE.key` when it is a single one.
    pub key_field: Option<String>,
    /// The key's member on the row type, with `key`.
    pub key_ident: Option<String>,
    pub read_only: bool,
    pub discriminator: Option<(String, String)>,
    pub lifecycles: Vec<LifecyclePlan>,
    /// Its many-to-many relationships, for an entity with a key.
    pub traversals: Vec<TraversalPlan>,
    /// The view an entity that writes its table reads its rows from, when it declares one.
    pub read: Option<ReadView>,
}

/// The read-only source an entity reads through: every field, the derived ones too.
#[derive(Debug, Clone)]
pub struct ReadView {
    pub schema: Option<String>,
    pub table: String,
    pub columns: Vec<ColumnPlan>,
}

fn unsupported(message: String) -> GenError {
    GenError::new(ERR_UNSUPPORTED, message)
}

fn ty_path(ty: &Ty) -> String {
    match ty {
        Ty::Str => "String".to_string(),
        Ty::Prim(p) => (*p).to_string(),
        Ty::Ip => "std::net::IpAddr".to_string(),
        Ty::Decimal => format!("{SUPPORT_CRATE}::wire::Decimal"),
        Ty::Duration => format!("{SUPPORT_CRATE}::wire::Duration"),
        Ty::Ref(r) => format!("{}::{}", r.crate_name, r.type_name),
        Ty::Map(v) => format!("std::collections::BTreeMap<String, {}>", ty_path(v)),
    }
}

/// The `{member: stored}` pairs of an enum's `@intValueMap` or `@stringValueMap`.
fn value_map(tree: &Tree, field: NodeId, attr: &str) -> Option<Vec<(String, serde_json::Value)>> {
    // ADR-0039: resolving. A field may take the map from the enum it extends.
    let map = tree.attr(field, attr)?.as_object()?;
    Some(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

type ColumnKind = (String, bool, Option<(String, &'static str, Vec<String>)>);

fn column_kind(tree: &Tree, f: &FieldPlan, what: &str) -> Result<ColumnKind, GenError> {
    let scalar = |k: &str| (format!("Kind::{k}"), f.array, None);
    let map_const = format!("{}_STORED", screaming(&f.wire));
    Ok(match f.kind {
        Kind::String | Kind::Uri => scalar("Text"),
        Kind::Int => scalar("Int"),
        Kind::Long | Kind::Currency => scalar("Long"),
        Kind::Double => scalar("Double"),
        Kind::Float => scalar("Float"),
        Kind::Boolean => scalar("Bool"),
        Kind::Decimal => scalar("Decimal"),
        Kind::Date => scalar("Date"),
        Kind::Time => scalar("Time"),
        Kind::Timestamp if f.local_time => scalar("Timestamp"),
        Kind::Timestamp => scalar("TimestampTz"),
        Kind::Uuid => scalar("Uuid"),
        Kind::Inet => scalar("Inet"),
        Kind::Duration => scalar("Duration"),
        Kind::Enum => {
            if let Some(map) = value_map(tree, f.node, ATTR_INT_VALUE_MAP) {
                let pairs = map
                    .iter()
                    .map(|(m, v)| {
                        v.as_i64()
                            .map(|i| format!("({}, {i})", literal(m)))
                            .ok_or_else(|| {
                                unsupported(format!(
                                    "{what}: @intValueMap maps {m} to a non-integer"
                                ))
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                (
                    format!("Kind::IntEnum({map_const})"),
                    f.array,
                    Some((map_const, "&[(&str, i64)]", pairs)),
                )
            } else if let Some(map) = value_map(tree, f.node, ATTR_STRING_VALUE_MAP) {
                let pairs = map
                    .iter()
                    .map(|(m, v)| {
                        v.as_str()
                            .map(|t| format!("({}, {})", literal(m), literal(t)))
                            .ok_or_else(|| {
                                unsupported(format!(
                                    "{what}: @stringValueMap maps {m} to a non-string"
                                ))
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                (
                    format!("Kind::StringEnum({map_const})"),
                    f.array,
                    Some((map_const, "&[(&str, &str)]", pairs)),
                )
            } else {
                scalar("Text")
            }
        }
        // A value object, a list of them and a map are each one JSON column.
        Kind::Object | Kind::Map => ("Kind::Json".to_string(), false, None),
    })
}

/// The base of `obj`'s single-table hierarchy's discriminator field, and `obj`'s own value.
fn discriminator(tree: &Tree, obj: NodeId) -> Option<(String, String)> {
    if !is_tph_subtype(tree, obj) {
        return None;
    }
    // ADR-0039 sanctioned own: `@discriminatorValue` is THIS subtype's value, and the field is
    // found by reading each ancestor's own `@discriminator`.
    let value = tree
        .own_attr(obj, ATTR_DISCRIMINATOR_VALUE)
        .and_then(|a| a.value.as_str())?
        .to_string();
    let mut seen = vec![obj];
    let mut cur = tree.node(obj).super_node;
    while let Some(n) = cur {
        if seen.contains(&n) {
            return None;
        }
        seen.push(n);
        // ADR-0039 sanctioned own: see above.
        if let Some(field) = tree
            .own_attr(n, ATTR_DISCRIMINATOR)
            .and_then(|a| a.value.as_str())
            .filter(|f| !f.is_empty())
        {
            return Some((field.to_string(), value));
        }
        cur = tree.node(n).super_node;
    }
    None
}

fn snake_ident(name: &str) -> String {
    metaobjects_codegen::names::snake(name)
}

/// `intEnumVal` as a const's name: `INT_ENUM_VAL`.
fn screaming(name: &str) -> String {
    snake_ident(name).trim_start_matches("r#").to_uppercase()
}

/// The stored entity of `s`.
fn stored_entity(
    tree: &Tree,
    naming: &NamingCtx<'_>,
    s: &StructPlan,
    route: &Route,
    lifecycles: &BTreeMap<NodeId, Vec<String>>,
) -> Result<StoredEntity, GenError> {
    let fail = |e: metaobjects::errors::MetaError| unsupported(e.to_string());
    let mut columns = Vec::new();
    // ADR-0039 sanctioned own: the read view is a source the entity declares itself.
    let view =
        s.is_entity
            .then(|| {
                tree.own_children(s.node).iter().copied().find(|&c| {
                    tree.node(c).type_name == TYPE_SOURCE && source_is_read_only(tree, c)
                })
            })
            .flatten();
    let mut read_columns = Vec::new();
    for f in &s.fields {
        let what = format!("{}.{}", s.name, f.wire);
        // A derived field is computed on read by a projection; an entity stores none, and
        // reads it through its read view when it has one.
        if s.is_entity
            && tree
                .children(f.node)
                .iter()
                .any(|&c| tree.node(c).type_name == TYPE_ORIGIN)
        {
            if view.is_some() {
                let (kind, array, map) = column_kind(tree, f, &what)?;
                read_columns.push(ColumnPlan {
                    field: f.wire.clone(),
                    column: resolve_column_name(tree, f.node, naming).map_err(fail)?,
                    kind,
                    array,
                    map,
                    stored_as: None,
                });
            }
            continue;
        }
        if f.kind == Kind::Object
            && tree.attr(f.node, ATTR_STORAGE).and_then(|v| v.as_str()) == Some(STORAGE_FLATTENED)
        {
            return Err(unsupported(format!(
                "{what} is stored flattened, which the Rust repository generator does not write yet"
            )));
        }
        let (kind, array, map) = column_kind(tree, f, &what)?;
        // ADR-0039 sanctioned own: `@dbColumnType` is physical and never inherited.
        let stored_as = tree
            .own_attr(f.node, ATTR_DB_COLUMN_TYPE)
            .and_then(|a| a.value.as_str())
            .map(str::to_string);
        columns.push(ColumnPlan {
            field: f.wire.clone(),
            // A report's column is its derived field's name, cased by the column strategy.
            column: if s.is_report {
                naming
                    .registry
                    .apply_column_naming_strategy(&f.wire, &naming.naming.columns)
                    .map_err(fail)?
            } else {
                resolve_column_name(tree, f.node, naming).map_err(fail)?
            },
            kind,
            array,
            map,
            stored_as,
        });
    }
    let read = match view {
        Some(v) => Some(ReadView {
            schema: tree
                .attr(v, ATTR_SCHEMA)
                .and_then(|a| a.as_str())
                .map(str::to_string),
            table: source_physical_name(tree, v, naming).map_err(fail)?,
            columns: columns.iter().cloned().chain(read_columns).collect(),
        }),
        None => None,
    };
    let primary: Vec<&FieldPlan> = s.fields.iter().filter(|f| f.primary).collect();
    let key_field = match primary.as_slice() {
        [only] => Some(only.wire.clone()),
        _ => None,
    };
    let key = route.key.map(|k| {
        let f = &s.fields[k];
        let ty = match &f.ty {
            Ty::Str => "&str".to_string(),
            other => ty_path(other),
        };
        (f.wire.clone(), ty)
    });
    let mut cycles = Vec::new();
    for field in lifecycles.get(&s.node).into_iter().flatten() {
        let Some(f) = s.fields.iter().find(|f| &f.wire == field) else {
            continue;
        };
        if f.array {
            continue;
        }
        cycles.push(LifecyclePlan {
            field: field.clone(),
            ident: f.ident.clone(),
            optional: f.optional,
            function: format!("transition_{}", snake_ident(field)),
            state_type: ty_path(&f.ty),
        });
    }
    let row = format!("{}::{}", s.crate_name, s.type_name);
    Ok(StoredEntity {
        object: s.name.clone(),
        node: s.node,
        key_ident: route.key.map(|k| s.fields[k].ident.clone()),
        module: s.module(),
        create: format!("{}::{}", s.crate_name, s.create_name()),
        patch: format!("{}::{}", s.crate_name, s.patch_name()),
        row,
        schema: resolve_table_schema(tree, s.node, naming).map_err(fail)?,
        table: resolve_table_name(tree, s.node, naming).map_err(fail)?,
        columns,
        key,
        key_field,
        read_only: route.read_only,
        discriminator: discriminator(tree, s.node),
        lifecycles: cycles,
        traversals: Vec::new(),
        read,
    })
}

/// The traversals of the stored entity `s`, with each target's store crate added to `deps`.
/// The junction and its two foreign keys come from the core's derivation, the one the
/// loader's pairing rule runs, so a relationship that loaded is one this can follow.
fn traversals(
    tree: &Tree,
    index: &ObjectIndex,
    naming: &NamingCtx<'_>,
    plan: &Plan,
    s: &StructPlan,
    route: &Route,
    deps: &mut BTreeSet<String>,
) -> Result<Vec<TraversalPlan>, GenError> {
    let fail = |e: metaobjects::errors::MetaError| unsupported(e.to_string());
    if route.key.is_none() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for t in &route.traversals {
        let what = format!("{}.{}", s.name, t.name);
        let rel = tree
            .children(s.node)
            .iter()
            .copied()
            .find(|&c| tree.node(c).type_name == TYPE_RELATIONSHIP && tree.node(c).name == t.name)
            .ok_or_else(|| unsupported(format!("{what} is not a relationship")))?;
        let m2m = derive_m2m_fields(tree, index, rel, s.node).map_err(unsupported)?;
        let junction = plan
            .structs
            .iter()
            .find(|j| j.node == m2m.junction)
            .ok_or_else(|| unsupported(format!("{what}: its junction is not a planned entity")))?;
        let column = |name: &str| -> Result<ColumnPlan, GenError> {
            let f = junction
                .fields
                .iter()
                .find(|f| f.wire == name)
                .ok_or_else(|| {
                    unsupported(format!(
                        "{what}: the junction {} has no field {name}",
                        junction.name
                    ))
                })?;
            let (kind, array, map) = column_kind(tree, f, &what)?;
            if array || map.is_some() {
                return Err(unsupported(format!(
                    "{what}: the junction key {name} is not a single text or number"
                )));
            }
            Ok(ColumnPlan {
                field: f.wire.clone(),
                column: resolve_column_name(tree, f.node, naming).map_err(fail)?,
                kind,
                array,
                map,
                // ADR-0039 sanctioned own: `@dbColumnType` is physical and never inherited.
                stored_as: tree
                    .own_attr(f.node, ATTR_DB_COLUMN_TYPE)
                    .and_then(|a| a.value.as_str())
                    .map(str::to_string),
            })
        };
        let target = &plan.structs[t.target];
        let store = format!("{}{STORE_SUFFIX}", target.crate_name);
        let own = format!("{}{STORE_SUFFIX}", s.crate_name);
        deps.insert(target.crate_name.clone());
        let target_table = if store == own {
            format!("crate::{}::TABLE", target.module())
        } else {
            deps.insert(store.clone());
            format!("{store}::{}::TABLE", target.module())
        };
        out.push(TraversalPlan {
            relation: t.name.clone(),
            function: format!("{}_of", snake_ident(&t.name).trim_start_matches("r#")),
            constant: screaming(&t.name),
            junction: junction.name.clone(),
            schema: resolve_table_schema(tree, junction.node, naming).map_err(fail)?,
            table: resolve_table_name(tree, junction.node, naming).map_err(fail)?,
            source: column(&m2m.source_field)?,
            target: column(&m2m.target_field)?,
            symmetric: m2m.symmetric,
            target_table,
            target_row: format!("{}::{}", target.crate_name, target.type_name),
        });
    }
    Ok(out)
}

/// One store crate: the stored entities of one model crate's package.
pub struct StoredCrate {
    /// The store crate's name: `<model crate>_store`.
    pub name: String,
    /// The model crate it reads and writes the types of.
    pub model: String,
    /// The metadata package.
    pub package: String,
    /// Its stored entities, in model order.
    pub entities: Vec<StoredEntity>,
    /// The model and store crates its files name.
    pub deps: BTreeSet<String>,
}

/// Every store crate the run writes, in crate order: the walk the `repository` generator
/// renders, and the one the `service` generator builds its operations over.
pub fn stored_crates(ctx: &GenContext<'_>) -> Result<Vec<StoredCrate>, GenError> {
    stored_crates_in(ctx, &Plan::of(ctx)?)
}

/// [`stored_crates`] over a plan the caller already built.
pub fn stored_crates_in(ctx: &GenContext<'_>, plan: &Plan) -> Result<Vec<StoredCrate>, GenError> {
    let tree = ctx.tree;
    let selected = plan.selected_crates(ctx.entities)?;
    let registry = NamingRegistry::builtin();
    let naming = NamingCtx::new(&registry, &ctx.collection.physical_naming);

    // The lifecycle fields of each entity, from the engine walk the rules layers share.
    let index = ObjectIndex::build(tree, ctx.root);
    let mut lifecycles: BTreeMap<NodeId, Vec<String>> = BTreeMap::new();
    for p in rules_names_of(
        tree,
        ctx.root,
        &index,
        &ctx.collection.config.rules,
        &|_| true,
    ) {
        for e in p.entities {
            lifecycles
                .entry(e.node)
                .or_default()
                .extend(e.lifecycles.into_iter().map(|l| l.field));
        }
    }

    let mut out = Vec::new();
    for (cname, c) in &plan.crates {
        if selected.as_ref().is_some_and(|sel| !sel.contains(cname)) {
            continue;
        }
        let served: Vec<&StructPlan> = plan.stored(c).collect();
        if served.is_empty() {
            continue;
        }
        let mut deps: BTreeSet<String> = BTreeSet::from([cname.to_string()]);
        let mut entities = Vec::new();
        for s in served {
            let route = s.route.as_ref().expect("a stored object has a route");
            let mut e = stored_entity(tree, &naming, s, route, &lifecycles)?;
            e.traversals = traversals(tree, &index, &naming, plan, s, route, &mut deps)?;
            for f in &s.fields {
                if let Some(t) = f.ty.type_ref() {
                    deps.insert(t.crate_name.clone());
                }
                if matches!(f.ty, Ty::Decimal | Ty::Duration) {
                    deps.insert(SUPPORT_CRATE.to_string());
                }
            }
            entities.push(e);
        }
        out.push(StoredCrate {
            name: format!("{cname}{STORE_SUFFIX}"),
            model: cname.to_string(),
            package: c.package.clone(),
            entities,
            deps,
        });
    }
    Ok(out)
}
