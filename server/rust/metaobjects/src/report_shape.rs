//! Table B of the FR-044 Plan 2 contract: a report's derived fields, with Table C's
//! `required` (docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md,
//! which amends Table B for a report with `@spine` and a measure with `@default`).
//!
//! A rule-for-rule copy of the TypeScript reference
//! (`server/typescript/packages/metadata/src/core/reporting/report-shape.ts`), gated, like
//! every port's copy, by `fixtures/persistence-conformance/report-shapes.json`.
//!
//! ADR-0039: every read is RESOLVING (`Tree::attr`, `Tree::children`) unless a comment names
//! the sanctioned own read.

use serde_json::Value;

use crate::node::{NodeId, PACKAGE_SEP, Tree};
use crate::validate::util::{ObjectIndex, find_hop, split_dotted};

const T_OBJECT: &str = "object";
const T_FIELD: &str = "field";
const T_IDENTITY: &str = "identity";
const T_VALIDATOR: &str = "validator";
const T_DIMENSION: &str = "dimension";
const T_MEASURE: &str = "measure";
const S_PRIMARY: &str = "primary";
const S_REFERENCE: &str = "reference";
const S_REQUIRED: &str = "required";
const S_OBJECT: &str = "object";
const S_TIME: &str = "time";
const S_RATIO: &str = "ratio";
const S_DERIVED: &str = "derived";
const A_OF: &str = "of";
const A_VIA: &str = "via";
const A_AGG: &str = "agg";
const A_DEFAULT: &str = "default";
const A_FROM: &str = "from";
const A_DIMENSIONS: &str = "dimensions";
const A_MEASURES: &str = "measures";
const A_SPINE: &str = "spine";
const A_REQUIRED: &str = "required";
const A_FIELDS: &str = "fields";
const A_ENFORCE: &str = "enforce";
const A_REFERENCES: &str = "references";
const A_OBJECT_REF: &str = "objectRef";
const A_STORAGE: &str = "storage";
const A_SOURCE_REF_FIELD: &str = "sourceRefField";
const A_DISCRIMINATOR: &str = "discriminator";
const STORAGE_FLATTENED: &str = "flattened";
const GRAIN_SEPARATOR: char = ':';
const TIME_GRAINS: [&str; 6] = ["hour", "day", "week", "month", "quarter", "year"];
const GRAIN_HOUR: &str = "hour";
const AGG_COUNT: &str = "count";
const AGG_SUM: &str = "sum";
const AGG_AVG: &str = "avg";
const AGG_ANY: &str = "any";
const AGG_ALL: &str = "all";
const SUB_INT: &str = "int";
const SUB_LONG: &str = "long";
const SUB_DOUBLE: &str = "double";
const SUB_FLOAT: &str = "float";
const SUB_DECIMAL: &str = "decimal";
const SUB_CURRENCY: &str = "currency";
const SUB_BOOLEAN: &str = "boolean";
const SUB_DATE: &str = "date";
const SUB_TIMESTAMP: &str = "timestamp";
/// Trailing suffixes stripped from a candidate reference's name and FK field when pairing it
/// with a relationship name, first match winning (the reference's `PAIRING_SUFFIXES`).
const PAIRING_SUFFIXES: [&str; 4] = ["reference", "ref", "id", "key"];

/// Whether a report field is a dimension or a measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportFieldRole {
    Dimension,
    Measure,
}

impl ReportFieldRole {
    /// `dimension` or `measure`, as the shapes artifact writes it.
    pub fn as_str(self) -> &'static str {
        match self {
            ReportFieldRole::Dimension => "dimension",
            ReportFieldRole::Measure => "measure",
        }
    }
}

/// One derived field of a report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportField {
    pub name: String,
    pub role: ReportFieldRole,
    /// A field subtype name.
    pub sub_type: String,
    pub required: bool,
    /// The `@of` field whose type-shaping attrs this field carries (Table B).
    pub type_source: Option<NodeId>,
    pub dimension: Option<NodeId>,
    pub grain: Option<String>,
    pub measure: Option<NodeId>,
}

/// A report, the entity its rows are read from, and its derived fields: the dimensions in
/// `@dimensions` order, then the measures in `@measures` order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportShape {
    pub report: NodeId,
    pub from: NodeId,
    pub fields: Vec<ReportField>,
}

struct Ctx<'a> {
    tree: &'a Tree,
    index: &'a ObjectIndex,
}

fn str_attr<'a>(tree: &'a Tree, id: NodeId, name: &str) -> Option<&'a str> {
    tree.attr(id, name).and_then(Value::as_str)
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

fn unresolved(report: &str, what: &str) -> String {
    format!("report '{report}': {what} does not resolve.")
}

impl Ctx<'_> {
    fn is_object(&self, id: NodeId) -> bool {
        self.tree.node(id).type_name == T_OBJECT
    }

    /// True when `candidate` is `entity` or an entity it extends.
    fn is_self_or_ancestor(&self, candidate: NodeId, entity: NodeId) -> bool {
        let mut seen = Vec::new();
        let mut cur = Some(entity);
        while let Some(n) = cur {
            if n == candidate {
                return true;
            }
            if seen.contains(&n) {
                return false;
            }
            seen.push(n);
            cur = self.tree.node(n).super_node;
        }
        false
    }

    /// The entity that declares a dimension or measure reached through `from`: its parent.
    fn member_owner(&self, member: NodeId, from: NodeId) -> NodeId {
        self.tree.node(member).parent.unwrap_or(from)
    }

    fn package_of(&self, id: NodeId) -> String {
        let key = self.tree.resolution_key(id);
        key.rfind(PACKAGE_SEP)
            .map(|i| key[..i].to_string())
            .unwrap_or_default()
    }

    fn resolve(&self, owner: &str, declaring: NodeId) -> Option<NodeId> {
        self.index.resolve(owner, &self.package_of(declaring))
    }

    fn field(&self, obj: NodeId, name: &str) -> Option<NodeId> {
        self.tree.children(obj).iter().copied().find(|&c| {
            let n = self.tree.node(c);
            n.type_name == T_FIELD && n.name == name
        })
    }

    fn is_required(&self, field: NodeId) -> bool {
        if self.tree.attr(field, A_REQUIRED) == Some(&Value::Bool(true)) {
            return true;
        }
        self.tree.children(field).iter().any(|&c| {
            let n = self.tree.node(c);
            n.type_name == T_VALIDATOR && n.sub_type == S_REQUIRED
        })
    }

    fn is_flattened(&self, field: NodeId) -> bool {
        self.tree.node(field).sub_type == S_OBJECT
            && str_attr(self.tree, field, A_STORAGE) == Some(STORAGE_FLATTENED)
    }

    /// FR-044 R12: member `name` of the value object a flattened `field.object` embeds.
    fn flattened_member(&self, embedding: NodeId, name: &str) -> Option<NodeId> {
        if !self.is_flattened(embedding) {
            return None;
        }
        let value_object = self.index.ref_target(self.tree, embedding, A_OBJECT_REF)?;
        if !self.is_object(value_object) {
            return None;
        }
        self.field(value_object, name)
    }

    /// The reference's `resolveReportingFieldRefNamed`: the entity the reference's entity half
    /// names and the field read (from `host` when there is one).
    fn field_ref_named(
        &self,
        reference: &str,
        declaring: NodeId,
        host: Option<NodeId>,
    ) -> Option<(NodeId, NodeId)> {
        let seg = reference
            .rfind(PACKAGE_SEP)
            .map_or(0, |i| i + PACKAGE_SEP.len());
        let dot = seg + reference[seg..].find('.')?;
        if dot == 0 {
            return None;
        }
        let path: Vec<&str> = reference[dot + 1..].split('.').collect();
        if path.len() > 2 {
            return None;
        }
        let named = self.resolve(&reference[..dot], declaring)?;
        if !self.is_object(named) {
            return None;
        }
        if let Some(h) = host
            && !self.is_self_or_ancestor(named, h)
        {
            return None;
        }
        let field = self.field(host.unwrap_or(named), path[0])?;
        match path.get(1) {
            None => Some((named, field)),
            Some(member) => self.flattened_member(field, member).map(|m| (named, m)),
        }
    }

    /// The hop names of a `@via` or `@spine`: `Owner` resolves in the package of `declaring`
    /// and must be `from` or an entity `from` extends.
    fn via_hops(&self, via: &str, declaring: NodeId, from: NodeId) -> Option<Vec<String>> {
        let (owner, hops) = split_dotted(via)?;
        let owner = self.resolve(owner, declaring)?;
        if !self.is_self_or_ancestor(owner, from) {
            return None;
        }
        Some(hops.into_iter().map(str::to_string).collect())
    }

    /// One hop of a path: the relationship (through `@objectRef`) or `identity.reference`
    /// (through `@references`) of `current`, and its target when it reaches an object.
    fn via_hop(&self, current: NodeId, hop: &str) -> Option<(NodeId, bool, Option<NodeId>)> {
        let (node, is_ref) = find_hop(self.tree, current, hop)?;
        let attr = if is_ref { A_REFERENCES } else { A_OBJECT_REF };
        let target = self
            .index
            .ref_target(self.tree, node, attr)
            .filter(|&t| self.is_object(t));
        Some((node, is_ref, target))
    }

    fn via_terminal(&self, via: &str, declaring: NodeId, from: NodeId) -> Option<NodeId> {
        let mut current = from;
        for hop in self.via_hops(via, declaring, from)? {
            current = self.via_hop(current, &hop)?.2?;
        }
        Some(current)
    }

    /// A dimension's `@of`: read from `from` without `@via`, else from the entity the `@via`
    /// reaches, a bare entity name resolving in that entity's package.
    fn dimension_of(&self, dim: NodeId, from: NodeId) -> Option<(NodeId, NodeId)> {
        let of = str_attr(self.tree, dim, A_OF).unwrap_or("");
        let owner = self.member_owner(dim, from);
        match str_attr(self.tree, dim, A_VIA) {
            None => self.field_ref_named(of, owner, Some(from)),
            Some(via) => {
                let terminal = self.via_terminal(via, owner, from)?;
                self.field_ref_named(of, terminal, Some(terminal))
            }
        }
    }

    fn identity_fields(&self, identity: NodeId) -> Vec<String> {
        match self.tree.attr(identity, A_FIELDS) {
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| {
                    v.as_str()
                        .map_or_else(|| v.to_string(), str::to_string)
                        .trim()
                        .to_string()
                })
                .collect(),
            Some(Value::String(s)) => s
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            _ => Vec::new(),
        }
    }

    fn identities(&self, obj: NodeId, sub_type: &str) -> Vec<NodeId> {
        self.tree
            .children(obj)
            .iter()
            .copied()
            .filter(|&c| {
                let n = self.tree.node(c);
                n.type_name == T_IDENTITY && n.sub_type == sub_type
            })
            .collect()
    }

    fn is_primary_key_field(&self, entity: NodeId, field: NodeId) -> bool {
        let name = &self.tree.node(field).name;
        self.identities(entity, S_PRIMARY)
            .first()
            .is_some_and(|&pk| self.identity_fields(pk).iter().any(|f| f == name))
    }

    /// The reference's `resolveRelationshipReference` ladder: the one candidate onto
    /// `target`, else the one whose FK field `@sourceRefField` names, else the one that
    /// name-pairs with the relationship.
    fn relationship_reference(
        &self,
        holder: NodeId,
        relationship: &str,
        target: NodeId,
        source_ref_field: Option<&str>,
    ) -> Option<NodeId> {
        let fk = |r: NodeId| self.identity_fields(r).into_iter().next();
        let candidates: Vec<NodeId> = self
            .identities(holder, S_REFERENCE)
            .into_iter()
            .filter(|&r| fk(r).is_some())
            .filter(|&r| self.index.ref_target(self.tree, r, A_REFERENCES) == Some(target))
            .collect();
        match candidates.as_slice() {
            [] => return None,
            [only] => return Some(*only),
            _ => {}
        }
        if let Some(sr) = source_ref_field.filter(|s| !s.is_empty()) {
            return candidates
                .into_iter()
                .find(|&r| fk(r).as_deref() == Some(sr));
        }
        let strip = |v: &str| -> String {
            PAIRING_SUFFIXES
                .iter()
                .find(|s| v.len() > s.len() && v.ends_with(*s))
                .map_or_else(|| v.to_string(), |s| v[..v.len() - s.len()].to_string())
        };
        let keys = |r: NodeId| {
            let mut out = Vec::new();
            for v in [Some(self.tree.node(r).name.clone()), fk(r)]
                .into_iter()
                .flatten()
            {
                if v.is_empty() {
                    continue;
                }
                let lower = v.to_lowercase();
                out.push(strip(&lower));
                out.push(lower);
            }
            out
        };
        let wanted = relationship.to_lowercase();
        let paired: Vec<NodeId> = candidates
            .into_iter()
            .filter(|&r| keys(r).contains(&wanted))
            .collect();
        match paired.as_slice() {
            [only] => Some(*only),
            _ => None,
        }
    }

    /// True when a join onto `obj` carries a row scope of its own: a TPH subtype, or an
    /// abstract level beneath a TPH base.
    fn hides_rows(&self, obj: NodeId) -> bool {
        // ADR-0039 sanctioned own: the discriminator is declared on the level that owns it.
        if self.tree.own_attr(obj, A_DISCRIMINATOR).is_some() {
            return false;
        }
        let mut seen = vec![obj];
        let mut cur = self.tree.node(obj).super_node;
        while let Some(s) = cur {
            if seen.contains(&s) {
                break;
            }
            seen.push(s);
            // ADR-0039 sanctioned own: the TPH base is the ancestor that declares it.
            if self.tree.own_attr(s, A_DISCRIMINATOR).is_some() {
                return true;
            }
            cur = self.tree.node(s).super_node;
        }
        false
    }

    /// True when every hop, walked from `from`, is a required, enforced belongs-to reference
    /// onto a target that hides no rows: a LEFT OUTER join then returns what INNER would.
    fn via_always_matches(&self, hops: &[String], from: NodeId) -> bool {
        let mut current = from;
        for hop_name in hops {
            let Some((hop, is_ref, Some(target))) = self.via_hop(current, hop_name) else {
                return false;
            };
            let reference = if is_ref {
                Some(hop)
            } else {
                let sr = str_attr(self.tree, hop, A_SOURCE_REF_FIELD);
                self.relationship_reference(current, hop_name, target, sr)
            };
            let Some(reference) = reference else {
                return false;
            };
            if self.tree.attr(reference, A_ENFORCE) == Some(&Value::Bool(false)) {
                return false;
            }
            let fk = self.identity_fields(reference).into_iter().next();
            let required = fk
                .and_then(|f| self.field(current, &f))
                .is_some_and(|f| self.is_required(f));
            if !required || self.hides_rows(target) {
                return false;
            }
            current = target;
        }
        true
    }

    fn dimension_required(
        &self,
        dim: NodeId,
        named: NodeId,
        of: NodeId,
        from: NodeId,
        spine: Option<&[String]>,
        report: &str,
    ) -> Result<bool, String> {
        let via = str_attr(self.tree, dim, A_VIA);
        let owner = self.member_owner(dim, from);
        let hops = |via: &str| {
            self.via_hops(via, owner, from).ok_or_else(|| {
                unresolved(
                    report,
                    &format!("dimension '{}' @via '{via}'", self.tree.node(dim).name),
                )
            })
        };
        let Some(spine) = spine else {
            let Some(via) = via else {
                return Ok(self.is_required(of));
            };
            if !self.is_required(of) {
                return Ok(false);
            }
            return Ok(self.via_always_matches(&hops(via)?, from));
        };
        // A column of @from: null in a spine row with no facts.
        let Some(via) = via else { return Ok(false) };
        let on_spine = hops(via)? == spine;
        Ok(on_spine && (self.is_required(of) || self.is_primary_key_field(named, of)))
    }

    fn member(&self, from: NodeId, type_name: &str, name: &str) -> Option<NodeId> {
        self.tree.children(from).iter().copied().find(|&c| {
            let n = self.tree.node(c);
            n.type_name == type_name && n.name == name
        })
    }

    fn dimension_field(
        &self,
        item: &str,
        from: NodeId,
        report: &str,
        spine: Option<&[String]>,
    ) -> Result<ReportField, String> {
        let (name, grain) = match item.find(GRAIN_SEPARATOR) {
            None => (item, None),
            Some(i) => (&item[..i], Some(&item[i + 1..])),
        };
        let from_name = &self.tree.node(from).name;
        let dim = self
            .member(from, T_DIMENSION, name)
            .ok_or_else(|| unresolved(report, &format!("dimension '{name}' on '{from_name}'")))?;
        let owner = self.member_owner(dim, from);
        if let Some(via) = str_attr(self.tree, dim, A_VIA)
            && self.via_terminal(via, owner, from).is_none()
        {
            return Err(unresolved(
                report,
                &format!("dimension '{name}' @via '{via}'"),
            ));
        }
        let (named, of) = self
            .dimension_of(dim, from)
            .ok_or_else(|| unresolved(report, &format!("dimension '{name}' @of")))?;
        let derived = derived_field_name(name, grain);
        let required = self.dimension_required(dim, named, of, from, spine, report)?;
        let field =
            |sub_type: &str, type_source: Option<NodeId>, grain: Option<&str>| ReportField {
                name: derived.clone(),
                role: ReportFieldRole::Dimension,
                sub_type: sub_type.to_string(),
                required,
                type_source,
                dimension: Some(dim),
                grain: grain.map(str::to_string),
                measure: None,
            };
        if self.tree.node(dim).sub_type == S_TIME {
            let grain = grain.filter(|g| TIME_GRAINS.contains(g)).ok_or_else(|| {
                unresolved(
                    report,
                    &format!("time dimension '{name}' grain '{}'", grain.unwrap_or("")),
                )
            })?;
            if grain == GRAIN_HOUR {
                return Ok(field(SUB_TIMESTAMP, Some(of), Some(grain)));
            }
            return Ok(field(SUB_DATE, None, Some(grain)));
        }
        Ok(field(&self.tree.node(of).sub_type, Some(of), None))
    }

    /// Table B for one measure: its subtype and the `@of` field it carries type attrs from.
    fn derive_measure(&self, m: NodeId, from: NodeId) -> Option<(String, Option<NodeId>)> {
        let sub = self.tree.node(m).sub_type.as_str();
        // A quotient, and (R13) an arithmetic expression, are decimal whatever their operands.
        if sub == S_RATIO || sub == S_DERIVED {
            return Some((SUB_DECIMAL.into(), None));
        }
        let agg = str_attr(self.tree, m, A_AGG);
        match agg {
            Some(AGG_COUNT) => return Some((SUB_LONG.into(), None)),
            Some(AGG_ANY | AGG_ALL) => return Some((SUB_BOOLEAN.into(), None)),
            _ => {}
        }
        let first = string_list(self.tree.attr(m, A_OF))
            .into_iter()
            .next()
            .unwrap_or_default();
        let (_, of) = self.field_ref_named(&first, self.member_owner(m, from), Some(from))?;
        let src = self.tree.node(of).sub_type.as_str();
        let floating = src == SUB_DOUBLE || src == SUB_FLOAT;
        Some(match agg {
            Some(AGG_SUM) if src == SUB_CURRENCY => (SUB_CURRENCY.into(), Some(of)),
            Some(AGG_SUM) => {
                let s = if src == SUB_INT || src == SUB_LONG {
                    SUB_LONG
                } else if floating {
                    SUB_DOUBLE
                } else {
                    SUB_DECIMAL
                };
                (s.into(), None)
            }
            Some(AGG_AVG) => (
                (if floating { SUB_DOUBLE } else { SUB_DECIMAL }).into(),
                None,
            ),
            // min / max keep the source field's type.
            _ => (src.to_string(), Some(of)),
        })
    }

    fn measure_field(
        &self,
        item: &str,
        report: NodeId,
        from: NodeId,
    ) -> Result<ReportField, String> {
        let report_name = &self.tree.node(report).name;
        let from_name = &self.tree.node(from).name;
        let (qualifier, name) = match item.rfind('.') {
            None => (None, item),
            Some(i) => (Some(&item[..i]), &item[i + 1..]),
        };
        let missing = || unresolved(report_name, &format!("measure '{item}' on '{from_name}'"));
        if let Some(q) = qualifier {
            let owner = self.resolve(q, report).ok_or_else(missing)?;
            if !self.is_self_or_ancestor(owner, from) {
                return Err(missing());
            }
        }
        let m = self.member(from, T_MEASURE, name).ok_or_else(missing)?;
        let (sub_type, type_source) = self
            .derive_measure(m, from)
            .ok_or_else(|| unresolved(report_name, &format!("measure '{name}' @of")))?;
        let is_ratio = self.tree.node(m).sub_type == S_RATIO;
        let has_default = self
            .tree
            .attr(m, A_DEFAULT)
            .is_some_and(|v| v.as_i64().is_some() || v.as_u64().is_some());
        // Table C: a count is never null; any other measure is not null when it has a @default.
        let required =
            (!is_ratio && str_attr(self.tree, m, A_AGG) == Some(AGG_COUNT)) || has_default;
        Ok(ReportField {
            name: name.to_string(),
            role: ReportFieldRole::Measure,
            sub_type,
            required,
            type_source,
            dimension: None,
            grain: None,
            measure: Some(m),
        })
    }
}

/// The derived field name of a dimension item: `name`, or `name` and the capitalized grain.
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

/// Table B, with Table C's `required`, for one `object.report`. An error names the report
/// when a reference does not resolve (a report that passed the loader always resolves).
pub fn report_shape(
    tree: &Tree,
    index: &ObjectIndex,
    report: NodeId,
) -> Result<ReportShape, String> {
    let ctx = Ctx { tree, index };
    let name = &tree.node(report).name;
    let from_ref = str_attr(tree, report, A_FROM).ok_or_else(|| unresolved(name, "@from"))?;
    let from = ctx
        .resolve(from_ref, report)
        .filter(|&f| ctx.is_object(f))
        .ok_or_else(|| unresolved(name, &format!("@from '{from_ref}'")))?;
    let spine = match str_attr(tree, report, A_SPINE).filter(|s| !s.is_empty()) {
        None => None,
        Some(spine) => Some(
            ctx.via_hops(spine, from, from)
                .ok_or_else(|| unresolved(name, &format!("@spine '{spine}'")))?,
        ),
    };
    let mut fields = Vec::new();
    for item in string_list(tree.attr(report, A_DIMENSIONS)) {
        fields.push(ctx.dimension_field(&item, from, name, spine.as_deref())?);
    }
    for item in string_list(tree.attr(report, A_MEASURES)) {
        fields.push(ctx.measure_field(&item, report, from)?);
    }
    Ok(ReportShape {
        report,
        from,
        fields,
    })
}
