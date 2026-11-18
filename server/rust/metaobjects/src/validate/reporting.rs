//! `validateReporting` (FR-044): cross-node rules for the reporting vocabulary
//! (dimensions, measures, segments, `object.report`) and the relative-date filter
//! value (rules F1/F2). The rule ids match the TypeScript reference
//! (`loader/reporting-validation.ts`); the error text is the contract.
//!
//! One broken rule yields one error: a member that fails a structural rule is not
//! checked further. Members are read through the resolving `children()` (ADR-0039):
//! pass 1 checks members against the entity that declares them, pass 2 the inherited
//! ones against each inheritor, and a repeat of an already-reported failure is dropped.

#![allow(clippy::collapsible_if)] // nested `if let` mirrors the reference rule-by-rule

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde_json::{Map, Value};

use super::util::{ObjectIndex, find_hop, ops_for_field, split_dotted};
use super::{Ctx, Findings};
use crate::errors::MetaError;
use crate::node::{NodeId, PACKAGE_SEP, Tree};

pub const ERR_INVALID_DIMENSION: &str = "ERR_INVALID_DIMENSION";
pub const ERR_INVALID_MEASURE: &str = "ERR_INVALID_MEASURE";
pub const ERR_INVALID_REPORT: &str = "ERR_INVALID_REPORT";
pub const ERR_REPORT_FOREIGN_MEASURE: &str = "ERR_REPORT_FOREIGN_MEASURE";
pub const ERR_BAD_ATTR_FILTER: &str = "ERR_BAD_ATTR_FILTER";

const T_OBJECT: &str = "object";
const T_FIELD: &str = "field";
const T_IDENTITY: &str = "identity";
const T_SOURCE: &str = "source";
const T_DIMENSION: &str = "dimension";
const T_MEASURE: &str = "measure";
const T_SEGMENT: &str = "segment";
const T_ORIGIN: &str = "origin";
const S_ENTITY: &str = "entity";
const S_PROJECTION: &str = "projection";
const S_REPORT: &str = "report";
const S_AGGREGATE: &str = "aggregate";
const S_DERIVED: &str = "derived";
const S_FIRST: &str = "first";
const S_TIME: &str = "time";
const A_OF: &str = "of";
const A_VIA: &str = "via";
const A_GRAINS: &str = "grains";
const A_AGG: &str = "agg";
const A_DISTINCT: &str = "distinct";
const A_FILTER: &str = "filter";
const A_SEGMENT: &str = "segment";
const A_NUMERATOR: &str = "numerator";
const A_DENOMINATOR: &str = "denominator";
const A_EXPR: &str = "expr";
const A_DEFAULT: &str = "default";
const A_FROM: &str = "from";
const A_DIMENSIONS: &str = "dimensions";
const A_MEASURES: &str = "measures";
const A_SPINE: &str = "spine";
const A_OBJECT_REF: &str = "objectRef";
const A_STORAGE: &str = "storage";
const A_CARDINALITY: &str = "cardinality";
const A_KIND: &str = "kind";
const ATTR_SUBTYPE_FILTER: &str = "filter";
const CARDINALITY_ONE: &str = "one";
const STORAGE_FLATTENED: &str = "flattened";
const KIND_TABLE: &str = "table";
const KIND_VIEW: &str = "view";
const READ_ONLY_KINDS: [&str; 4] = ["view", "materializedView", "storedProc", "tableFunction"];
const TIME_GRAINS: [&str; 6] = ["hour", "day", "week", "month", "quarter", "year"];
const GRAIN_HOUR: &str = "hour";
const DERIVED_FNS: [&str; 4] = ["add", "subtract", "multiply", "divide"];
const MEASURE_AGGS: [&str; 7] = ["count", "sum", "avg", "min", "max", "any", "all"];
const AGG_COUNT: &str = "count";
const AGG_SUM: &str = "sum";
const AGG_AVG: &str = "avg";
const AGG_MIN: &str = "min";
const AGG_MAX: &str = "max";
const AGG_ANY: &str = "any";
const AGG_ALL: &str = "all";
const NOW: &str = "now";
const START_OF: &str = "startOf";
const START_OF_UNITS: [&str; 3] = ["day", "week", "month"];
const NUMERIC: [&str; 6] = ["int", "long", "double", "float", "decimal", "currency"];
const UNORDERED: [&str; 3] = ["boolean", "object", "map"];
const TEMPORAL: [&str; 2] = ["date", "timestamp"];
const RELATIVE_OPS: [&str; 4] = ["gt", "gte", "lt", "lte"];

type Err<'a> = &'a dyn Fn(&str);

// ---- small readers ----------------------------------------------------------

fn str_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    tree.attr(id, name).and_then(Value::as_str)
}

fn string_list(v: Option<&Value>) -> Vec<&str> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(s)) => vec![s.as_str()],
        _ => Vec::new(),
    }
}

fn object_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a Map<String, Value>> {
    tree.attr(id, name).and_then(Value::as_object)
}

fn is_integral_number(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
}

fn js_number(v: &Value) -> String {
    match v.as_f64() {
        Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e15 => format!("{}", f as i64),
        _ => v.to_string(),
    }
}

fn is_self_or_ancestor(tree: &Tree, candidate: Option<NodeId>, entity: NodeId) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };
    let mut cur = Some(entity);
    let mut steps = 0usize;
    while let Some(n) = cur {
        if n == candidate {
            return true;
        }
        steps += 1;
        if steps > tree.len() {
            return false;
        }
        cur = tree.node(n).super_node;
    }
    false
}

fn child_label(tree: &Tree, id: NodeId) -> String {
    let n = tree.node(id);
    if n.name.is_empty() {
        format!("{}.{}", n.type_name, n.sub_type)
    } else {
        format!("{}.{} '{}'", n.type_name, n.sub_type, n.name)
    }
}

fn node_label(tree: &Tree, id: NodeId) -> String {
    let n = tree.node(id);
    let parent = n.parent;
    match parent {
        Some(p) if tree.node(p).parent.is_some() => {
            format!("{} in {}", child_label(tree, id), node_label(tree, p))
        }
        _ => format!(
            "{}.{} '{}'",
            n.type_name,
            n.sub_type,
            tree.resolution_key(id)
        ),
    }
}

/// Signed ISO-8601 duration, as `ISO_DURATION_RE` in the reference.
fn iso_duration(s: &str) -> bool {
    fn take<'a>(mut rest: &'a str, designators: &str) -> Option<&'a str> {
        let mut at = 0usize;
        loop {
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                return Some(rest);
            }
            let d = rest[digits..].chars().next()?;
            let p = designators.find(d)?;
            if p < at {
                return None;
            }
            at = p + 1;
            rest = &rest[digits + d.len_utf8()..];
        }
    }
    let s = s.strip_prefix(['+', '-']).unwrap_or(s);
    let Some(rest) = s.strip_prefix('P') else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    let Some(mut rest) = take(rest, "YMWD") else {
        return false;
    };
    if let Some(t) = rest.strip_prefix('T') {
        if !t.starts_with(|c: char| c.is_ascii_digit()) {
            return false;
        }
        let Some(r) = take(t, "HMS") else {
            return false;
        };
        rest = r;
    }
    rest.is_empty()
}

// ---- shared state ---------------------------------------------------------------

/// Collects errors, dropping the repeat of a failure an inherited member re-raises.
struct Sink<'a> {
    tree: &'a Tree,
    errors: RefCell<Vec<MetaError>>,
    seen: RefCell<HashMap<NodeId, HashSet<String>>>,
}

impl<'a> Sink<'a> {
    fn push(&self, node: NodeId, code: &'static str, head: &str, body: &str, suffix: &str) {
        let base = format!("{code}\0{head}{body}");
        let key = format!("{base}\0{suffix}");
        let mut seen = self.seen.borrow_mut();
        let keys = seen.entry(node).or_default();
        if keys.contains(&base) || keys.contains(&key) {
            return;
        }
        keys.insert(if suffix.is_empty() { base } else { key });
        self.errors.borrow_mut().push(MetaError::at(
            code,
            format!("{head}{suffix}{body}"),
            self.tree.node(node).source.clone(),
        ));
    }
}

struct Env<'a> {
    tree: &'a Tree,
    index: &'a ObjectIndex,
    /// Effective children per object, computed once: the tree is not frozen during
    /// validation, so `Tree::children` would recompute them on every call.
    kids: RefCell<HashMap<NodeId, Rc<[NodeId]>>>,
}

impl<'a> Env<'a> {
    fn kids(&self, obj: NodeId) -> Rc<[NodeId]> {
        if let Some(k) = self.kids.borrow().get(&obj) {
            return Rc::clone(k);
        }
        let k: Rc<[NodeId]> = self.tree.children(obj).into_owned().into();
        self.kids.borrow_mut().insert(obj, Rc::clone(&k));
        k
    }

    fn child_of_type(&self, obj: NodeId, ty: &str, name: &str) -> Option<NodeId> {
        let tree = self.tree;
        self.kids(obj).iter().copied().find(|&c| {
            let n = tree.node(c);
            n.type_name == ty && n.name == name
        })
    }

    fn field_of(&self, obj: NodeId, name: &str) -> Option<NodeId> {
        self.child_of_type(obj, T_FIELD, name)
    }

    fn objects(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.index.objects().iter().copied()
    }

    /// `resolveObjectRef` (see [`ObjectIndex::resolve`]).
    fn resolve_object(&self, reference: &str, referrer_pkg: &str) -> Option<NodeId> {
        self.index.resolve(reference, referrer_pkg)
    }

    /// `refTarget(node, attr)`.
    fn ref_target(&self, node: NodeId, attr: &str) -> Option<NodeId> {
        self.index.ref_target(self.tree, node, attr)
    }

    fn is_flattened(&self, field: NodeId) -> bool {
        self.tree.node(field).sub_type == "object"
            && str_attr(self.tree, field, A_STORAGE) == Some(STORAGE_FLATTENED)
    }

    fn ref_target_object(&self, field: NodeId) -> Option<NodeId> {
        self.ref_target(field, A_OBJECT_REF)
            .filter(|&t| self.tree.node(t).type_name == T_OBJECT)
    }

    fn flattened_member(&self, embedding: NodeId, name: &str) -> Option<NodeId> {
        if !self.is_flattened(embedding) {
            return None;
        }
        self.field_of(self.ref_target_object(embedding)?, name)
    }

    /// `resolveReportingFieldRefNamed`.
    fn field_ref(&self, r: &str, declaring: NodeId, host: Option<NodeId>) -> Option<NodeId> {
        let tree = self.tree;
        let seg = r.rfind(PACKAGE_SEP).map_or(0, |i| i + PACKAGE_SEP.len());
        let dot = seg + r[seg..].find('.')?;
        if dot == 0 {
            return None;
        }
        let path: Vec<&str> = r[dot + 1..].split('.').collect();
        if path.len() > 2 {
            return None;
        }
        let named = self.resolve_object(&r[..dot], &tree.effective_package(declaring))?;
        if host.is_some_and(|h| !is_self_or_ancestor(tree, Some(named), h)) {
            return None;
        }
        let field = self.field_of(host.unwrap_or(named), path[0])?;
        match path.get(1) {
            None => Some(field),
            Some(m) => self.flattened_member(field, m),
        }
    }

    /// `reportingViaHops`: the hop names of `via`, when its owner is `from` or an ancestor.
    fn via_hops<'r>(&self, via: &'r str, declaring: NodeId, from: NodeId) -> Option<Vec<&'r str>> {
        let (owner, hops) = split_dotted(via)?;
        let owner = self.resolve_object(owner, &self.tree.effective_package(declaring))?;
        is_self_or_ancestor(self.tree, Some(owner), from).then_some(hops)
    }

    /// One hop: a relationship, else an `identity.reference`, and its target object.
    fn hop(&self, current: NodeId, name: &str) -> Option<(NodeId, bool)> {
        find_hop(self.tree, current, name)
    }

    fn hop_target(&self, hop: NodeId, is_ref: bool) -> Option<NodeId> {
        self.index.hop_target(self.tree, hop, is_ref)
    }

    fn resolve_dimension_of(&self, dim: NodeId, from: NodeId) -> Option<NodeId> {
        let tree = self.tree;
        let of = str_attr(tree, dim, A_OF).unwrap_or("");
        let declaring = tree.node(dim).parent.unwrap_or(from);
        match str_attr(tree, dim, A_VIA) {
            None => self.field_ref(of, declaring, Some(from)),
            Some(via) => {
                let mut current = from;
                for h in self.via_hops(via, declaring, from)? {
                    let (hop, is_ref) = self.hop(current, h)?;
                    current = self.hop_target(hop, is_ref)?;
                }
                self.field_ref(of, current, Some(current))
            }
        }
    }

    /// `measureResultSubType`.
    fn measure_result(&self, m: NodeId, from: NodeId) -> Option<&'a str> {
        let tree = self.tree;
        let sub = tree.node(m).sub_type.as_str();
        if sub == "ratio" || sub == S_DERIVED {
            return Some("decimal");
        }
        let agg = measure_agg(tree, m);
        if agg == Some(AGG_COUNT) {
            return Some("long");
        }
        if agg == Some(AGG_ANY) || agg == Some(AGG_ALL) {
            return Some("boolean");
        }
        let cols = of_columns(tree, m);
        let declaring = tree.node(m).parent.unwrap_or(from);
        let of = self.field_ref(cols.first().copied().unwrap_or(""), declaring, Some(from))?;
        let src = tree.node(of).sub_type.as_str();
        Some(match agg {
            Some(AGG_SUM) => match src {
                "currency" => "currency",
                "int" | "long" => "long",
                "double" | "float" => "double",
                _ => "decimal",
            },
            Some(AGG_AVG) => match src {
                "double" | "float" => "double",
                _ => "decimal",
            },
            _ => src,
        })
    }
}

fn measure_agg(tree: &Tree, m: NodeId) -> Option<&str> {
    str_attr(tree, m, A_AGG).filter(|a| MEASURE_AGGS.contains(a))
}

fn of_columns(tree: &Tree, m: NodeId) -> Vec<&str> {
    string_list(tree.attr(m, A_OF))
}

fn is_time(tree: &Tree, dim: NodeId) -> bool {
    tree.node(dim).sub_type == S_TIME
}

fn grains(tree: &Tree, dim: NodeId) -> Vec<&str> {
    string_list(tree.attr(dim, A_GRAINS))
        .into_iter()
        .filter(|g| TIME_GRAINS.contains(g))
        .collect()
}

// ---- derived expressions ----------------------------------------------------------

/// `isDerivedExpr`: `{field}`, `{value}` or `{fn, args:[a, b]}`, recursively.
fn is_derived_expr(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    if o.len() == 1 {
        if let Some(f) = o.get("field") {
            return f.as_str().is_some_and(|s| !s.is_empty());
        }
        if let Some(n) = o.get("value") {
            return n.as_f64().is_some_and(f64::is_finite);
        }
        return false;
    }
    if let (2, Some(f), Some(Value::Array(args))) = (o.len(), o.get("fn"), o.get("args")) {
        return f.as_str().is_some_and(|s| DERIVED_FNS.contains(&s))
            && args.len() == 2
            && args.iter().all(is_derived_expr);
    }
    false
}

fn derived_fields<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    let Some(o) = v.as_object() else {
        return;
    };
    if let Some(f) = o.get("field").and_then(Value::as_str) {
        if !out.contains(&f) {
            out.push(f);
        }
    } else if let Some(Value::Array(args)) = o.get("args") {
        for a in args {
            derived_fields(a, out);
        }
    }
}

fn measure_expr(tree: &Tree, m: NodeId) -> Option<&Value> {
    tree.attr(m, A_EXPR).filter(|v| is_derived_expr(v))
}

// ---- entry point ------------------------------------------------------------------

pub fn validate_reporting(ctx: &Ctx<'_>, out: &mut Findings) {
    let tree = ctx.tree;
    let env = Env {
        tree,
        index: ctx.objects,
        kids: RefCell::new(HashMap::new()),
    };
    let sink = Sink {
        tree,
        errors: RefCell::new(Vec::new()),
        seen: RefCell::new(HashMap::new()),
    };
    let entities: Vec<NodeId> = env
        .objects()
        .filter(|&o| tree.node(o).sub_type == S_ENTITY)
        .collect();
    for declared_here in [true, false] {
        for &entity in &entities {
            check_entity_members(&env, entity, declared_here, &sink);
        }
    }
    for report in env.objects().filter(|&o| tree.node(o).sub_type == S_REPORT) {
        check_report(&env, report, &sink);
    }
    check_no_relative_dates(&env, ctx.root, &sink);
    out.errors.extend(sink.errors.into_inner());
}

// ---- members of an entity ---------------------------------------------------------

struct Member {
    id: NodeId,
    host: NodeId,
    declaring: NodeId,
    declared_here: bool,
}

impl Member {
    fn head(&self, tree: &Tree) -> String {
        let n = tree.node(self.id);
        format!(
            "{} '{}' on entity '{}'",
            n.type_name,
            n.name,
            tree.resolution_key(self.declaring)
        )
    }

    fn suffix(&self, tree: &Tree) -> String {
        if self.declared_here {
            String::new()
        } else {
            format!(" (inherited by '{}')", tree.resolution_key(self.host))
        }
    }

    fn fail(&self, env: &Env<'_>, sink: &Sink<'_>, code: &'static str, body: &str) {
        let tree = env.tree;
        sink.push(self.id, code, &self.head(tree), body, &self.suffix(tree));
    }

    /// The FQN a member message names for `entity`: the declaring entity in place of the host.
    fn shown(&self, tree: &Tree, entity: NodeId) -> String {
        tree.resolution_key(if entity == self.host {
            self.declaring
        } else {
            entity
        })
    }
}

fn check_entity_members(env: &Env<'_>, entity: NodeId, declared_here: bool, sink: &Sink<'_>) {
    let tree = env.tree;
    for &id in env.kids(entity).iter() {
        let ty = tree.node(id).type_name.as_str();
        if ty != T_DIMENSION && ty != T_MEASURE && ty != T_SEGMENT {
            continue;
        }
        let declaring = tree.node(id).parent.unwrap_or(entity);
        if (declaring == entity) != declared_here {
            continue;
        }
        let mc = Member {
            id,
            host: entity,
            declaring,
            declared_here,
        };
        match ty {
            T_DIMENSION => check_dimension(env, &mc, sink),
            T_MEASURE => check_measure(env, &mc, sink),
            _ => {
                if let Some(filter) = object_attr(tree, id, A_FILTER) {
                    let head = || mc.head(tree);
                    let suffix = || mc.suffix(tree);
                    check_filter(
                        env,
                        filter,
                        entity,
                        &|| tree.resolution_key(declaring),
                        &head,
                        id,
                        &suffix,
                        sink,
                    );
                }
            }
        }
    }
}

/// What a to-one walk resolves against and how its messages name it (D2 vs R8).
enum Walk {
    D2 { declaring: NodeId },
    Spine { from: NodeId },
}

impl Walk {
    fn attr(&self) -> &'static str {
        match self {
            Walk::D2 { .. } => A_VIA,
            Walk::Spine { .. } => A_SPINE,
        }
    }
    fn anchor(&self) -> NodeId {
        match self {
            Walk::D2 { declaring } => *declaring,
            Walk::Spine { from } => *from,
        }
    }
    fn start(&self, tree: &Tree) -> String {
        let key = tree.resolution_key(self.anchor());
        match self {
            Walk::D2 { .. } => format!("the owning entity '{key}'"),
            Walk::Spine { .. } => format!("@from '{key}'"),
        }
    }
    fn start_short(&self, tree: &Tree) -> String {
        match self {
            Walk::D2 { .. } => "the owning entity".to_string(),
            Walk::Spine { .. } => self.start(tree),
        }
    }
    fn to_one_reason(&self) -> &'static str {
        match self {
            Walk::D2 { .. } => {
                "A dimension follows only @cardinality: one relationships and identity.reference hops, so grouping can never multiply the measured rows."
            }
            Walk::Spine { .. } => {
                "A @spine follows only @cardinality: one relationships and identity.reference hops, so each fact row joins at most one row of the spine entity and is never counted twice."
            }
        }
    }
}

/// Walk `Owner.hop[.hop...]` from `host`; returns the terminal entity, or `None` after
/// reporting the first failure through `err`.
fn walk_to_one(
    env: &Env<'_>,
    host: NodeId,
    via: &str,
    err: Err<'_>,
    walk: &Walk,
) -> Option<NodeId> {
    let tree = env.tree;
    let named = format!("@{} '{via}'", walk.attr());
    let name_of = |e: NodeId| tree.resolution_key(if e == host { walk.anchor() } else { e });
    let Some((owner, hops)) = split_dotted(via) else {
        err(&format!(
            "{named} must be Owner.hop[.hop...], starting at {}.",
            walk.start_short(tree)
        ));
        return None;
    };
    let owner = env.resolve_object(owner, &tree.effective_package(walk.anchor()));
    if !is_self_or_ancestor(tree, owner, host) {
        err(&format!("{named} must start at {}.", walk.start(tree)));
        return None;
    }
    let mut current = host;
    for hop_name in hops {
        let Some((hop, is_ref)) = env.hop(current, hop_name) else {
            err(&format!(
                "{named} names '{hop_name}', which is not a relationship or identity.reference of '{}'.",
                name_of(current)
            ));
            return None;
        };
        if !is_ref && str_attr(tree, hop, A_CARDINALITY) != Some(CARDINALITY_ONE) {
            err(&format!(
                "{named} crosses relationship '{hop_name}' on '{}', which is not to-one. {}",
                name_of(current),
                walk.to_one_reason()
            ));
            return None;
        }
        let Some(target) = env.hop_target(hop, is_ref) else {
            err(&format!(
                "{named} hop '{hop_name}' on '{}' targets no object.",
                name_of(current)
            ));
            return None;
        };
        current = target;
    }
    Some(current)
}

/// R12: the column an `@of` path names on `entity` (`field`, or `field.member` of a
/// flattened value object).
fn of_column(
    env: &Env<'_>,
    entity: NodeId,
    path: &[&str],
    item: &str,
    err: Err<'_>,
    field_missing: &dyn Fn() -> String,
) -> Option<NodeId> {
    let tree = env.tree;
    let Some(field) = env.field_of(entity, path[0]) else {
        err(&field_missing());
        return None;
    };
    let Some(member_name) = path.get(1) else {
        return Some(field);
    };
    let value_object = if tree.node(field).sub_type == "object" {
        env.ref_target_object(field)
    } else {
        None
    };
    let Some(value_object) = value_object else {
        err(&format!(
            "@of '{item}' names member '{member_name}' of '{}', a field.{} with no value object.",
            path[0],
            tree.node(field).sub_type
        ));
        return None;
    };
    if !env.is_flattened(field) {
        let storage = str_attr(tree, field, A_STORAGE).unwrap_or("jsonb (the default)");
        err(&format!(
            "@of '{item}' names a member of '{}', whose value object is stored as {storage}. A report reads a member only under @storage: flattened, where the member has a column of its own.",
            path[0]
        ));
        return None;
    }
    let member = env.field_of(value_object, member_name);
    if member.is_none() {
        err(&format!(
            "@of '{item}' names no member '{member_name}' on value object '{}'.",
            tree.resolution_key(value_object)
        ));
    }
    member
}

fn has_object_ref(tree: &Tree, field: NodeId) -> bool {
    tree.attr(field, A_OBJECT_REF).is_some()
}

fn check_dimension(env: &Env<'_>, mc: &Member, sink: &Sink<'_>) {
    let tree = env.tree;
    let dim = mc.id;
    let err = |m: &str| mc.fail(env, sink, ERR_INVALID_DIMENSION, &format!(": {m}"));
    let mut of_entity = mc.host;
    let via = str_attr(tree, dim, A_VIA);
    if let Some(via) = via {
        match walk_to_one(
            env,
            mc.host,
            via,
            &|m| err(m),
            &Walk::D2 {
                declaring: mc.declaring,
            },
        ) {
            Some(t) => of_entity = t,
            None => return,
        }
    }
    let Some(of) = str_attr(tree, dim, A_OF) else {
        return;
    };
    let parts = split_dotted(of).filter(|(_, p)| p.len() <= 2);
    let Some((owner, path)) = parts else {
        err(&format!(
            "@of '{of}' must be Entity.field or Entity.field.member."
        ));
        return;
    };
    let owner_pkg = tree.effective_package(if via.is_none() {
        mc.declaring
    } else {
        of_entity
    });
    let named = env.resolve_object(owner, &owner_pkg);
    if !is_self_or_ancestor(tree, named, of_entity) {
        if via.is_none() {
            err(&format!(
                "@of '{of}' must name a field of the owning entity '{}'. Reach another entity's field with @via.",
                tree.resolution_key(mc.declaring)
            ));
        } else {
            err(&format!(
                "@of '{of}' must name a field of '{}', the entity @via '{}' reaches.",
                mc.shown(tree, of_entity),
                via.unwrap_or("")
            ));
        }
        return;
    }
    let field_name = path[0];
    let lookup = if via.is_none() {
        of_entity
    } else {
        named.unwrap_or(of_entity)
    };
    let missing = || {
        if lookup != of_entity && env.field_of(of_entity, field_name).is_some() {
            format!(
                "@of '{of}' names no field '{field_name}' on '{}': only '{}', the entity @via reaches, declares it. Name it '{}.{field_name}'.",
                mc.shown(tree, lookup),
                mc.shown(tree, of_entity),
                tree.node(of_entity).name
            )
        } else {
            format!(
                "@of '{of}' names no field '{field_name}' on '{}'.",
                mc.shown(tree, lookup)
            )
        }
    };
    let Some(field) = of_column(env, lookup, &path, of, &|m| err(m), &missing) else {
        return;
    };
    let fsub = tree.node(field).sub_type.as_str();
    // D5 — a dimension groups by a scalar.
    if fsub == "object" || has_object_ref(tree, field) {
        err(&format!(
            "@of '{of}' is a field.{fsub}{}, which a report cannot group by. Group by a scalar field of it.",
            if has_object_ref(tree, field) {
                " with an @objectRef"
            } else {
                ""
            }
        ));
        return;
    }
    if !is_time(tree, dim) {
        return;
    }
    if !TEMPORAL.contains(&fsub) {
        err(&format!(
            "a time dimension's @of must be a field.date or field.timestamp, but '{of}' is field.{fsub}."
        ));
        return;
    }
    if fsub == "date" && grains(tree, dim).contains(&GRAIN_HOUR) {
        err(&format!(
            "grain 'hour' is impossible on '{of}', a field.date (a date has no hour). Remove 'hour' from @grains."
        ));
    }
}

fn check_measure(env: &Env<'_>, mc: &Member, sink: &Sink<'_>) {
    let tree = env.tree;
    let m = mc.id;
    let err = |msg: &str| mc.fail(env, sink, ERR_INVALID_MEASURE, &format!(": {msg}"));
    let declared_default = tree.attr(m, A_DEFAULT);
    let invalid_default = declared_default.is_some_and(|v| !is_integral_number(v));
    let sub = tree.node(m).sub_type.as_str();
    if sub == "ratio" {
        check_ratio_operands(env, mc, &err);
        return;
    }
    if sub == S_DERIVED {
        check_derived_expr(env, mc, &err);
        return;
    }
    if sub != S_AGGREGATE {
        return;
    }
    let Some(of_field) = check_aggregate_columns(env, mc, &err) else {
        return;
    };
    if !invalid_default && let Some(d) = declared_default {
        let agg = measure_agg(tree, m);
        if agg == Some(AGG_COUNT) {
            err(
                "@default cannot apply to @agg: count. A count is never null (it is 0 when nothing matches); remove @default.",
            );
        } else if (agg == Some(AGG_ANY) || agg == Some(AGG_ALL))
            && d.as_f64().is_some_and(|f| f != 0.0 && f != 1.0)
        {
            err(&format!(
                "@default '{}' on @agg '{}' must be 0 (false) or 1 (true): the measure is a boolean.",
                js_number(d),
                agg.unwrap_or("")
            ));
        } else if (agg == Some(AGG_MIN) || agg == Some(AGG_MAX))
            && of_field.is_some_and(|f| !NUMERIC.contains(&tree.node(f).sub_type.as_str()))
        {
            let f = of_field.map_or("", |f| tree.node(f).sub_type.as_str());
            err(&format!(
                "@default is a number, but '{}', the @of of @agg '{}', is a field.{f}. A default is supported on numeric measures only.",
                of_columns(tree, m).first().copied().unwrap_or(""),
                agg.unwrap_or("")
            ));
        }
    }
    // M5 — @segment names a segment of the owning entity.
    let segment = str_attr(tree, m, A_SEGMENT);
    if let Some(seg) = segment
        && env.child_of_type(mc.host, T_SEGMENT, seg).is_none()
    {
        err(&format!(
            "@segment '{seg}' names no segment of '{}'.",
            tree.resolution_key(mc.declaring)
        ));
    }
    if let Some(filter) = object_attr(tree, m, A_FILTER) {
        let head = || mc.head(tree);
        let suffix = || mc.suffix(tree);
        check_filter(
            env,
            filter,
            mc.host,
            &|| tree.resolution_key(mc.declaring),
            &head,
            m,
            &suffix,
            sink,
        );
    }
}

/// M0-M4; `None` when one fired, else `Some(single resolved @of field)`.
fn check_aggregate_columns(
    env: &Env<'_>,
    mc: &Member,
    err: &dyn Fn(&str),
) -> Option<Option<NodeId>> {
    let tree = env.tree;
    let m = mc.id;
    let agg = measure_agg(tree, m);
    let columns = of_columns(tree, m);
    if columns.is_empty()
        && let Some(a) = agg
    {
        {
            if a != AGG_ANY && a != AGG_ALL {
                err(&format!(
                    "@agg '{a}' needs @of, the column it aggregates. Only @agg any / all may omit @of, to ask whether some row (any) or every row (all) passes the measure's @filter or @segment."
                ));
                return None;
            }
            if object_attr(tree, m, A_FILTER).is_none() && str_attr(tree, m, A_SEGMENT).is_none() {
                err(&format!(
                    "@agg '{a}' without @of quantifies the measure's row condition, but it declares neither @filter nor @segment. Name a field.boolean in @of, or add the condition."
                ));
                return None;
            }
            return Some(None);
        }
    }
    let declaring_key = || tree.resolution_key(mc.declaring);
    let mut fields = Vec::new();
    for item in &columns {
        let parts = split_dotted(item).filter(|(_, p)| p.len() <= 2);
        let Some((owner, path)) = parts else {
            err(&format!(
                "@of '{item}' must be Entity.field or Entity.field.member."
            ));
            return None;
        };
        let named = env.resolve_object(owner, &tree.effective_package(mc.declaring));
        if !is_self_or_ancestor(tree, named, mc.host) {
            err(&format!(
                "@of '{item}' must name a field of the owning entity '{}'. A measure aggregates its own entity's rows; declare it on the entity that owns the column.",
                declaring_key()
            ));
            return None;
        }
        let missing = || {
            format!(
                "@of '{item}' names no field '{}' on '{}'.",
                path[0],
                declaring_key()
            )
        };
        let field = of_column(env, mc.host, &path, item, err, &missing)?;
        let fsub = tree.node(field).sub_type.as_str();
        if fsub == "object" || has_object_ref(tree, field) {
            err(&format!(
                "@of '{item}' is a field.{fsub}{}, which a report cannot aggregate. Aggregate a scalar field of it.",
                if has_object_ref(tree, field) {
                    " with an @objectRef"
                } else {
                    ""
                }
            ));
            return None;
        }
        fields.push(field);
    }
    let distinct = tree.attr(m, A_DISTINCT) == Some(&Value::Bool(true));
    if columns.len() > 1 && (agg != Some(AGG_COUNT) || !distinct) {
        err(&format!(
            "@of lists {} columns; a tuple is legal only with @agg: count and @distinct: true (a distinct count of the tuple).",
            columns.len()
        ));
        return None;
    }
    if distinct && agg.is_some_and(|a| a != AGG_COUNT) {
        err(&format!(
            "@distinct: true requires @agg: count, not '{}'.",
            agg.unwrap_or("")
        ));
        return None;
    }
    let field = if fields.len() == 1 {
        Some(fields[0])
    } else {
        None
    };
    let (Some(field), Some(agg)) = (field, agg) else {
        return Some(field);
    };
    let item = columns[0];
    let fsub = tree.node(field).sub_type.as_str();
    if (agg == AGG_SUM || agg == AGG_AVG) && !NUMERIC.contains(&fsub) {
        err(&format!(
            "@agg '{agg}' needs a numeric field (field.int, long, double, float, decimal or currency), but '{item}' is field.{fsub}."
        ));
        return None;
    }
    if (agg == AGG_MIN || agg == AGG_MAX) && UNORDERED.contains(&fsub) {
        err(&format!(
            "@agg '{agg}' cannot order '{item}', a field.{fsub}."
        ));
        return None;
    }
    if (agg == AGG_ANY || agg == AGG_ALL) && fsub != "boolean" {
        err(&format!(
            "@agg '{agg}' needs a field.boolean, but '{item}' is field.{fsub}."
        ));
        return None;
    }
    Some(Some(field))
}

/// M6 — each operand names a measure.aggregate of the same entity whose result is a number.
fn check_ratio_operands(env: &Env<'_>, mc: &Member, err: &dyn Fn(&str)) {
    let tree = env.tree;
    for (attr, r) in [
        (A_NUMERATOR, str_attr(tree, mc.id, A_NUMERATOR)),
        (A_DENOMINATOR, str_attr(tree, mc.id, A_DENOMINATOR)),
    ] {
        let Some(r) = r else {
            continue;
        };
        match env.child_of_type(mc.host, T_MEASURE, r) {
            None => err(&format!(
                "@{attr} '{r}' names no measure of '{}'.",
                tree.resolution_key(mc.declaring)
            )),
            Some(t) if tree.node(t).sub_type != S_AGGREGATE => err(&format!(
                "@{attr} '{r}' is a measure.{}; a ratio's operands must be measure.aggregate (a ratio of ratios is not supported).",
                tree.node(t).sub_type
            )),
            Some(t) => {
                if let Some(result) = env.measure_result(t, mc.host) {
                    if !NUMERIC.contains(&result) {
                        err(&format!(
                            "@{attr} '{r}' is a {result} measure; a ratio divides numbers, so its operands must be numeric measures (a count, a sum, an avg, or a min or max of a numeric field)."
                        ));
                    }
                }
            }
        }
    }
}

/// M11 — a measure.derived's `@expr` operands.
fn check_derived_expr(env: &Env<'_>, mc: &Member, err: &dyn Fn(&str)) {
    let tree = env.tree;
    if tree.attr(mc.id, A_EXPR).is_none() {
        return;
    }
    let Some(expr) = measure_expr(tree, mc.id) else {
        err(&format!("@expr is not an arithmetic expression. Each node is {{ field: <measure or dimension> }}, {{ value: <number> }} or {{ fn: {} , args: [<a>, <b>] }}.", DERIVED_FNS.join(" | ")).replace(" , ", ", "));
        return;
    };
    let key = tree.resolution_key(mc.declaring);
    let mut names = Vec::new();
    derived_fields(expr, &mut names);
    for name in names {
        let target = env.child_of_type(mc.host, T_MEASURE, name);
        let dim = env.child_of_type(mc.host, T_DIMENSION, name);
        match (target, dim) {
            (Some(_), Some(_)) => err(&format!(
                "@expr names '{name}', which is both a measure and a dimension of '{key}'. Rename one."
            )),
            (Some(t), None) => {
                if tree.node(t).sub_type == S_DERIVED {
                    err(&format!(
                        "@expr names '{name}', a measure.derived. A derived measure reads aggregates, ratios and dimensions, not another derived measure."
                    ));
                } else if let Some(result) = env.measure_result(t, mc.host) {
                    if !NUMERIC.contains(&result) {
                        err(&format!(
                            "@expr names measure '{name}', whose result is a {result}, not a number."
                        ));
                    }
                }
            }
            (None, Some(d)) => {
                if is_time(tree, d) {
                    err(&format!(
                        "@expr names '{name}', a dimension.time. Arithmetic reads a numeric attribute dimension."
                    ));
                } else if let Some(f) = env.resolve_dimension_of(d, mc.host) {
                    let fsub = &tree.node(f).sub_type;
                    if !NUMERIC.contains(&fsub.as_str()) {
                        err(&format!(
                            "@expr names dimension '{name}', whose @of is a field.{fsub}, not a number."
                        ));
                    }
                }
            }
            (None, None) => err(&format!(
                "@expr names '{name}', which is no measure or dimension of '{key}'."
            )),
        }
    }
}

// ---- filters (S1 / F2) --------------------------------------------------------------

fn is_relative(v: &Value) -> bool {
    v.as_object().is_some_and(|o| o.contains_key(NOW))
}

fn relative_operand(v: &Value) -> Option<&Map<String, Value>> {
    match v {
        Value::Array(a) => a.iter().find(|x| is_relative(x)).and_then(Value::as_object),
        _ if is_relative(v) => v.as_object(),
        _ => None,
    }
}

fn operand_contains_relative(v: &Value) -> bool {
    if is_relative(v) {
        return true;
    }
    match v {
        Value::Array(a) => a.iter().any(operand_contains_relative),
        Value::Object(o) => o.values().any(operand_contains_relative),
        _ => false,
    }
}

fn filter_contains_relative(filter: &Value) -> bool {
    let Some(o) = filter.as_object() else {
        return false;
    };
    for (key, clause) in o {
        if key == "or" || key == "and" {
            if clause
                .as_array()
                .is_some_and(|a| a.iter().any(filter_contains_relative))
            {
                return true;
            }
            continue;
        }
        if is_relative(clause) {
            return true;
        }
        if clause
            .as_object()
            .is_some_and(|c| c.values().any(operand_contains_relative))
        {
            return true;
        }
    }
    false
}

fn quote_value(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => "undefined".to_string(),
    }
}

/// F2 — why a relative-date operand under `op` on `key` is refused.
fn relative_date_problem(
    key: &str,
    op: &str,
    rel: &Map<String, Value>,
    sub: Option<&str>,
) -> Option<String> {
    if !rel.keys().all(|k| k == NOW || k == START_OF) {
        return Some(format!(
            "@filter on '{key}' has a malformed relative date {}; a relative date is {{ now: \"<ISO-8601 duration>\" }} with an optional startOf, and no other keys.",
            Value::Object(rel.clone())
        ));
    }
    if let Some(sub) = sub {
        if !TEMPORAL.contains(&sub) {
            return Some(format!(
                "@filter on '{key}' uses a relative date ({{ now: ... }}), but '{key}' is field.{sub}; relative dates apply only to field.date and field.timestamp."
            ));
        }
    }
    if !RELATIVE_OPS.contains(&op) {
        return Some(format!(
            "@filter on '{key}' puts a relative date under op '{op}'; relative dates are legal only under gt, gte, lt and lte."
        ));
    }
    let duration = rel.get(NOW);
    if !duration.and_then(Value::as_str).is_some_and(iso_duration) {
        return Some(format!(
            "@filter on '{key}' has relative date '{}', which is not an ISO-8601 duration (e.g. '-P7D', '-PT12H').",
            quote_value(duration)
        ));
    }
    if let Some(s) = rel.get(START_OF) {
        if !s.as_str().is_some_and(|s| START_OF_UNITS.contains(&s)) {
            return Some(format!(
                "@filter on '{key}' has startOf '{}'; startOf is one of {}.",
                quote_value(Some(s)),
                START_OF_UNITS.join(", ")
            ));
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn check_filter(
    env: &Env<'_>,
    filter: &Map<String, Value>,
    entity: NodeId,
    entity_key: &dyn Fn() -> String,
    head: &dyn Fn() -> String,
    host: NodeId,
    suffix: &dyn Fn() -> String,
    sink: &Sink<'_>,
) {
    let tree = env.tree;
    let err = |m: &str| {
        sink.push(
            host,
            ERR_BAD_ATTR_FILTER,
            &head(),
            &format!(": {m}"),
            &suffix(),
        )
    };
    for (key, clause) in filter {
        if key == "or" || key == "and" {
            let Some(arr) = clause.as_array() else {
                err(&format!("@filter '{key}' must be an array of sub-clauses."));
                continue;
            };
            for sub in arr {
                match sub.as_object() {
                    Some(o) => check_filter(env, o, entity, entity_key, head, host, suffix, sink),
                    None => err(&format!(
                        "@filter '{key}' contains a non-object sub-clause."
                    )),
                }
            }
            continue;
        }
        let Some(field) = env.field_of(entity, key) else {
            err(&format!(
                "@filter names '{key}', which is not a field of '{}'.",
                entity_key()
            ));
            continue;
        };
        let Some(clause) = clause.as_object().filter(|c| !c.is_empty()) else {
            err(&format!(
                "@filter on '{key}' must be an {{ op: value }} object."
            ));
            continue;
        };
        let allowed = ops_for_field(tree, field);
        let fsub = tree.node(field).sub_type.as_str();
        for (op, operand) in clause {
            if !allowed.contains(&op.as_str()) {
                let list = if allowed.is_empty() {
                    "(none)".to_string()
                } else {
                    allowed.join(", ")
                };
                err(&format!(
                    "@filter on '{key}' uses op '{op}', which is not allowed for field.{fsub}. Allowed ops: {list}."
                ));
                continue;
            }
            if let Some(rel) = relative_operand(operand) {
                if let Some(p) = relative_date_problem(key, op, rel, Some(fsub)) {
                    err(&p);
                }
            }
        }
    }
}

// ---- object.report (R1-R13) --------------------------------------------------------

fn dimension_items(tree: &Tree, report: NodeId) -> Vec<(&str, Option<&str>)> {
    string_list(tree.attr(report, A_DIMENSIONS))
        .into_iter()
        .map(|raw| match raw.find(':') {
            None => (raw, None),
            Some(i) => (&raw[..i], Some(&raw[i + 1..])),
        })
        .collect()
}

fn derived_field_name(name: &str, grain: Option<&str>) -> String {
    match grain {
        None | Some("") => name.to_string(),
        Some(g) => {
            let mut c = g.chars();
            let first: String = c
                .next()
                .map(|f| f.to_uppercase().collect())
                .unwrap_or_default();
            format!("{name}{first}{}", c.as_str())
        }
    }
}

fn is_writable(tree: &Tree, source: NodeId) -> bool {
    !READ_ONLY_KINDS.contains(&effective_kind(tree, source))
}

fn effective_kind(tree: &Tree, source: NodeId) -> &str {
    str_attr(tree, source, A_KIND).unwrap_or(KIND_TABLE)
}

fn check_report(env: &Env<'_>, report: NodeId, sink: &Sink<'_>) {
    let tree = env.tree;
    let label = format!("report '{}'", tree.resolution_key(report));
    let err_at =
        |node: NodeId, code: &'static str, body: &str| sink.push(node, code, &label, body, "");
    let err = |body: &str| err_at(report, ERR_INVALID_REPORT, body);

    // R4 — ADR-0039 own: the rule is about what the author declared on THIS report.
    for &child in tree.own_children(report) {
        let ty = tree.node(child).type_name.as_str();
        if ty == T_FIELD || ty == T_IDENTITY {
            err_at(
                child,
                ERR_INVALID_REPORT,
                &format!(
                    " declares {}; a report's fields and identity are derived from @dimensions and @measures, never declared.",
                    child_label(tree, child)
                ),
            );
        }
    }
    // R5 / R10 — ADR-0039 resolving: an inherited source binds the report just the same.
    let kids = env.kids(report);
    let sources: Vec<NodeId> = kids
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == T_SOURCE)
        .collect();
    for &s in &sources {
        if is_writable(tree, s) {
            err_at(
                s,
                ERR_INVALID_REPORT,
                &format!(
                    ": {} is writable; a report is read-only, so its source must declare a read-only @kind (view, materializedView, storedProc or tableFunction).",
                    child_label(tree, s)
                ),
            );
        }
    }
    for &s in &sources {
        if !is_writable(tree, s) && effective_kind(tree, s) != KIND_VIEW {
            err_at(
                s,
                ERR_INVALID_REPORT,
                &format!(
                    ": {} has @kind '{}'; a report is read through a view, so its source must be @kind: view. For a view or materialized view you create yourself, declare @kind: view with @unmanaged: true.",
                    child_label(tree, s),
                    effective_kind(tree, s)
                ),
            );
        }
    }
    // R11
    if tree.node(report).is_abstract {
        err(
            ": is abstract; a report cannot be abstract, because its fields are derived from its own @dimensions and @measures and no port reads or serves an abstract report. Remove abstract: true.",
        );
    }
    // R1
    let Some(from_ref) = str_attr(tree, report, A_FROM) else {
        return;
    };
    let pkg = tree.effective_package(report);
    let Some(from) = env.resolve_object(from_ref, &pkg) else {
        err(&format!(
            ": @from '{from_ref}' does not resolve to an object."
        ));
        return;
    };
    let fnode = tree.node(from);
    if fnode.type_name != T_OBJECT || fnode.sub_type != S_ENTITY {
        err(&format!(
            ": @from '{from_ref}' is an {}.{}; a report aggregates the rows of an object.entity.",
            fnode.type_name, fnode.sub_type
        ));
        return;
    }
    let from_key = tree.resolution_key(from);

    // R6 bookkeeping
    let mut derived: HashMap<String, String> = HashMap::new();
    let mut claim = |field_name: String, what: String| match derived.get(&field_name) {
        Some(prior) if *prior == what => {
            err(&format!(": @measures lists '{field_name}' more than once."))
        }
        Some(prior) => err(&format!(
            ": {prior} and {what} both derive report field '{field_name}'. Report field names must be unique; rename the measure or drop one item."
        )),
        None => {
            derived.insert(field_name, what);
        }
    };

    // R2
    let items = dimension_items(tree, report);
    let mut seen_items: HashSet<String> = HashSet::new();
    for &(name, grain) in &items {
        let raw = match grain {
            None => name.to_string(),
            Some(g) => format!("{name}:{g}"),
        };
        if !seen_items.insert(raw.clone()) {
            err(&format!(": @dimensions lists '{raw}' more than once."));
            continue;
        }
        let Some(dim) = env.child_of_type(from, T_DIMENSION, name) else {
            err(&format!(
                ": @dimensions item '{raw}' names no dimension of @from '{from_key}'."
            ));
            continue;
        };
        if is_time(tree, dim) {
            let gs = grains(tree, dim);
            match grain {
                None => {
                    err(&format!(
                        ": @dimensions item '{raw}' names time dimension '{name}' without a grain; write '{name}:<grain>' with a grain from its @grains ({}).",
                        gs.join(", ")
                    ));
                    continue;
                }
                Some(g) if !gs.contains(&g) => {
                    err(&format!(
                        ": @dimensions item '{raw}' uses grain '{g}', which time dimension '{name}' does not declare. Its @grains: {}.",
                        gs.join(", ")
                    ));
                    continue;
                }
                Some(_) => {}
            }
        } else if grain.is_some() {
            err(&format!(
                ": @dimensions item '{raw}' gives a grain to attribute dimension '{name}'; only a time dimension takes a grain."
            ));
            continue;
        }
        claim(
            derived_field_name(name, grain),
            format!("dimension item '{raw}'"),
        );
    }

    // R3
    let measure_items = string_list(tree.attr(report, A_MEASURES));
    for item in &measure_items {
        if let Some(name) = check_report_measure(env, report, from, item, &label, sink) {
            claim(name.to_string(), format!("measure '{name}'"));
        }
    }

    // R12 / R13
    check_value_object_units(env, &items, &measure_items, from, &err);
    check_derived_dimensions(env, &items, &measure_items, from, &err);

    // R7
    if let Some(seg) = str_attr(tree, report, A_SEGMENT) {
        if env.child_of_type(from, T_SEGMENT, seg).is_none() {
            err(&format!(
                ": @segment '{seg}' names no segment of @from '{from_key}'."
            ));
        }
    }

    // R8 / R9
    let spine = str_attr(tree, report, A_SPINE).filter(|s| !s.is_empty());
    if let Some(spine) = spine {
        let terminal = walk_to_one(
            env,
            from,
            spine,
            &|m| err(&format!(": {m}")),
            &Walk::Spine { from },
        );
        if let Some(terminal) = terminal {
            let spine_hops = split_dotted(spine).map(|(_, p)| p).unwrap_or_default();
            if items.is_empty() {
                err(&format!(
                    ": @spine '{spine}' needs at least one dimension. The report's rows are the dimension tuples of '{}'; with no dimension it would be one totals row.",
                    tree.resolution_key(terminal)
                ));
            }
            let mut checked: HashSet<&str> = HashSet::new();
            for &(name, _) in &items {
                if !checked.insert(name) {
                    continue;
                }
                let Some(dim) = env.child_of_type(from, T_DIMENSION, name) else {
                    continue;
                };
                let Some(via) = str_attr(tree, dim, A_VIA) else {
                    err(&format!(
                        ": dimension '{name}' is read from @from '{from_key}', so it has no value in a row that has no facts. With @spine '{spine}' every dimension must be reached through it: declare the dimension over a field of '{}' (or an entity to-one from it) with an @via that begins '{spine}'.",
                        tree.resolution_key(terminal)
                    ));
                    continue;
                };
                let discard = |_: &str| {};
                let walk = Walk::D2 {
                    declaring: tree.node(dim).parent.unwrap_or(from),
                };
                if walk_to_one(env, from, via, &discard, &walk).is_none() {
                    continue;
                }
                let hops = split_dotted(via).map(|(_, p)| p).unwrap_or_default();
                if spine_hops
                    .iter()
                    .enumerate()
                    .all(|(i, h)| hops.get(i) == Some(h))
                {
                    continue;
                }
                err(&format!(
                    ": dimension '{name}' is reached by @via '{via}', which does not begin with the hops of @spine '{spine}'. Hop names are compared as written: if both name the same join, write the same hops; otherwise the dimension is not reached through the spine."
                ));
            }
        }
    }

    // S1 / F2
    if let Some(filter) = object_attr(tree, report, A_FILTER) {
        let key = || from_key.clone();
        check_filter(
            env,
            filter,
            from,
            &key,
            &|| label.clone(),
            report,
            &String::new,
            sink,
        );
    }
}

fn item_name(item: &str) -> &str {
    item.rfind('.').map_or(item, |i| &item[i + 1..])
}

fn check_report_measure<'a>(
    env: &Env<'_>,
    report: NodeId,
    from: NodeId,
    item: &'a str,
    label: &str,
    sink: &Sink<'_>,
) -> Option<&'a str> {
    let tree = env.tree;
    let from_key = tree.resolution_key(from);
    let mut owner: Option<NodeId>;
    let parts = split_dotted(item);
    match parts {
        Some((o, path)) if path.len() == 1 => {
            owner = env.resolve_object(o, &tree.effective_package(report));
            let name = path[0];
            if is_self_or_ancestor(tree, owner, from)
                && env.child_of_type(from, T_MEASURE, name).is_some()
            {
                return Some(name);
            }
            if let Some(ow) = owner {
                if env.child_of_type(ow, T_MEASURE, name).is_none() {
                    owner = None;
                }
            }
        }
        _ if !item.contains('.') => {
            if env.child_of_type(from, T_MEASURE, item).is_some() {
                return Some(item);
            }
            owner = env.objects().find(|&o| {
                tree.node(o).sub_type == S_ENTITY && env.child_of_type(o, T_MEASURE, item).is_some()
            });
        }
        _ => owner = None,
    }
    match owner {
        Some(ow) => {
            let owner_key = tree.resolution_key(ow);
            sink.push(report, ERR_REPORT_FOREIGN_MEASURE, label, &format!(" lists measure '{}', which belongs to '{owner_key}', not @from '{from_key}'. All measures of a report come from @from; make a second report over '{owner_key}'.", item_name(item)), "");
        }
        None => sink.push(report, ERR_INVALID_REPORT, label, &format!(": @measures item '{item}' names no measure of @from '{from_key}' or of any other entity."), ""),
    }
    None
}

/// The measures `listed` aggregates through (itself; a ratio's operands; a derived
/// measure's named operands, ratios read through theirs).
fn aggregates_read(env: &Env<'_>, listed: NodeId, from: NodeId) -> Vec<NodeId> {
    let tree = env.tree;
    let measure = |n: &str| env.child_of_type(from, T_MEASURE, n);
    let operands_of = |m: Option<NodeId>, out: &mut Vec<NodeId>| {
        let Some(m) = m else {
            return;
        };
        if tree.node(m).sub_type == "ratio" {
            out.extend(str_attr(tree, m, A_NUMERATOR).and_then(measure));
            out.extend(str_attr(tree, m, A_DENOMINATOR).and_then(measure));
        } else {
            out.push(m);
        }
    };
    let mut out = Vec::new();
    if tree.node(listed).sub_type == S_DERIVED {
        if let Some(expr) = measure_expr(tree, listed) {
            let mut names = Vec::new();
            derived_fields(expr, &mut names);
            for n in names {
                operands_of(measure(n), &mut out);
            }
        }
    } else {
        operands_of(Some(listed), &mut out);
    }
    out
}

/// R12 — amounts in different units are never combined.
fn check_value_object_units(
    env: &Env<'_>,
    items: &[(&str, Option<&str>)],
    measure_items: &[&str],
    from: NodeId,
    err: &dyn Fn(&str),
) {
    let tree = env.tree;
    let mut grouped: HashSet<String> = HashSet::new();
    for &(name, _) in items {
        let Some(dim) = env.child_of_type(from, T_DIMENSION, name) else {
            continue;
        };
        if is_time(tree, dim) || str_attr(tree, dim, A_VIA).is_some() {
            continue;
        }
        if let Some((_, path)) = split_dotted(str_attr(tree, dim, A_OF).unwrap_or("")) {
            if path.len() == 2 {
                grouped.insert(path.join("."));
            }
        }
    }
    let mut checked: HashSet<NodeId> = HashSet::new();
    for item in measure_items {
        let Some(listed) = env.child_of_type(from, T_MEASURE, item_name(item)) else {
            continue;
        };
        for m in aggregates_read(env, listed, from) {
            if tree.node(m).sub_type != S_AGGREGATE || !checked.insert(m) {
                continue;
            }
            let agg = measure_agg(tree, m);
            if !matches!(agg, Some(AGG_SUM | AGG_AVG | AGG_MIN | AGG_MAX)) {
                continue;
            }
            let of = of_columns(tree, m).first().copied().unwrap_or("");
            let Some((owner, path)) = split_dotted(of) else {
                continue;
            };
            if path.len() != 2 {
                continue;
            }
            let (field_name, member_name) = (path[0], path[1]);
            let Some(field) = env.field_of(from, field_name) else {
                continue;
            };
            if !env.is_flattened(field) {
                continue;
            }
            let Some(vo) = env.ref_target_object(field) else {
                continue;
            };
            let Some(member) = env.field_of(vo, member_name) else {
                continue;
            };
            if !NUMERIC.contains(&tree.node(member).sub_type.as_str()) {
                continue;
            }
            // ADR-0039: resolving — a unit member the value object inherits qualifies too.
            for &unit in env.kids(vo).iter() {
                let u = tree.node(unit);
                if u.type_name != T_FIELD
                    || NUMERIC.contains(&u.sub_type.as_str())
                    || grouped.contains(&format!("{field_name}.{}", u.name))
                {
                    continue;
                }
                err(&format!(
                    ": measure '{}' takes @agg '{}' of '{of}', a member of value object '{}', but the report does not group by its member '{}', so amounts with different '{}' values would be combined. List an attribute dimension of @from whose @of is '{owner}.{field_name}.{}'.",
                    tree.node(m).name,
                    agg.unwrap_or(""),
                    tree.resolution_key(vo),
                    u.name,
                    u.name,
                    u.name
                ));
            }
        }
    }
}

/// R13 — a derived measure reads only dimensions the report groups by.
fn check_derived_dimensions(
    env: &Env<'_>,
    items: &[(&str, Option<&str>)],
    measure_items: &[&str],
    from: NodeId,
    err: &dyn Fn(&str),
) {
    let tree = env.tree;
    let listed: HashSet<&str> = items.iter().map(|&(n, _)| n).collect();
    for item in measure_items {
        let Some(m) = env.child_of_type(from, T_MEASURE, item_name(item)) else {
            continue;
        };
        if tree.node(m).sub_type != S_DERIVED {
            continue;
        }
        let Some(expr) = measure_expr(tree, m) else {
            continue;
        };
        let mut names = Vec::new();
        derived_fields(expr, &mut names);
        for name in names {
            if listed.contains(name)
                || env.child_of_type(from, T_MEASURE, name).is_some()
                || env.child_of_type(from, T_DIMENSION, name).is_none()
            {
                continue;
            }
            err(&format!(
                ": measure '{}' reads dimension '{name}', which @dimensions does not list. A derived measure reads a dimension's value for each group, so the report must group by it.",
                tree.node(m).name
            ));
        }
    }
}

// ---- F1: relative-date values only on reporting hosts ------------------------------

fn is_reporting_filter_host(tree: &Tree, id: NodeId) -> bool {
    let n = tree.node(id);
    n.type_name == T_SEGMENT
        || (n.type_name == T_MEASURE && n.sub_type == S_AGGREGATE)
        || (n.type_name == T_OBJECT && n.sub_type == S_REPORT)
}

fn is_relative_view_host(tree: &Tree, id: NodeId) -> bool {
    let n = tree.node(id);
    (n.type_name == T_OBJECT && n.sub_type == S_PROJECTION)
        || (n.type_name == T_ORIGIN && (n.sub_type == S_FIRST || n.sub_type == S_AGGREGATE))
}

fn check_relative_shapes(
    env: &Env<'_>,
    filter: &Value,
    host: NodeId,
    target: Option<NodeId>,
    sink: &Sink<'_>,
) {
    let Some(o) = filter.as_object() else {
        return;
    };
    for (key, clause) in o {
        if key == "or" || key == "and" {
            if let Value::Array(a) = clause {
                for sub in a {
                    check_relative_shapes(env, sub, host, target, sink);
                }
            }
            continue;
        }
        let Some(c) = clause.as_object() else {
            continue;
        };
        for (op, operand) in c {
            let Some(rel) = relative_operand(operand) else {
                continue;
            };
            let sub = target
                .and_then(|t| env.field_of(t, key))
                .map(|f| env.tree.node(f).sub_type.as_str());
            if let Some(p) = relative_date_problem(key, op, rel, sub) {
                sink.push(
                    host,
                    ERR_BAD_ATTR_FILTER,
                    &node_label(env.tree, host),
                    &format!(": {p}"),
                    "",
                );
            }
        }
    }
}

fn check_no_relative_dates(env: &Env<'_>, node: NodeId, sink: &Sink<'_>) {
    let tree = env.tree;
    if is_relative_view_host(tree, node) {
        let target = if tree.node(node).type_name == T_ORIGIN {
            env.index.origin_filter_entity(tree, node)
        } else {
            Some(node)
        };
        // ADR-0039 own: only locally declared filters are lowered (origin.* never inherits).
        for (_, attr) in tree.own_attrs(node) {
            if attr.sub_type == ATTR_SUBTYPE_FILTER {
                check_relative_shapes(env, &attr.value, node, target, sink);
            }
        }
    } else if !is_reporting_filter_host(tree, node) {
        // ADR-0039 own: the walk visits every declared node once, at its declaration.
        for (name, attr) in tree.own_attrs(node) {
            if attr.sub_type == ATTR_SUBTYPE_FILTER && filter_contains_relative(&attr.value) {
                sink.push(node, ERR_BAD_ATTR_FILTER, &node_label(tree, node), &format!(": @{name} uses a relative date ({{ now: ... }}), which is legal only in the @filter of a segment, measure.aggregate, object.report, object.projection, origin.aggregate or origin.first."), "");
            }
        }
    }
    // ADR-0039 own: a tree walk; each declared node is visited once, at its declaration.
    for &child in tree.own_children(node) {
        check_no_relative_dates(env, child, sink);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_in_the_shared_catalogue() {
        let raw = include_str!("../../../../../fixtures/conformance/ERROR-CODES.json");
        let doc: Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for c in [
            ERR_INVALID_DIMENSION,
            ERR_INVALID_MEASURE,
            ERR_INVALID_REPORT,
            ERR_REPORT_FOREIGN_MEASURE,
            ERR_BAD_ATTR_FILTER,
        ] {
            assert!(codes.contains_key(c), "{c} is not in ERROR-CODES.json");
        }
    }

    #[test]
    fn iso_duration_matches_the_reference_pattern() {
        for ok in ["-P7D", "P1Y2M", "-PT12H", "+P1W", "P1DT1H30M5S"] {
            assert!(iso_duration(ok), "{ok}");
        }
        for bad in [
            "P", "PT", "P1YT", "7D", "-P1H", "P1D1Y", "P1.5D", "PT1H1D", "",
        ] {
            assert!(!iso_duration(bad), "{bad}");
        }
    }

    #[test]
    fn derived_field_names_capitalise_the_grain() {
        assert_eq!(derived_field_name("placed", Some("day")), "placedDay");
        assert_eq!(derived_field_name("region", None), "region");
    }

    #[test]
    fn split_dotted_splits_after_the_last_package_separator() {
        assert_eq!(
            split_dotted("a::b::P.x.y"),
            Some(("a::b::P", vec!["x", "y"]))
        );
        assert_eq!(split_dotted("P"), None);
        assert_eq!(split_dotted("P.x."), None);
    }
}
