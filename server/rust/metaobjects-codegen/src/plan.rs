//! The read model the Rust generators share: what the loaded metadata means for Rust output.
//!
//! A generator turns a [`Plan`] into text and decides nothing about the model itself. The
//! plan answers, once and for every generator: which objects become types, which crate a
//! package becomes, what each field's Rust type is, which members a create or a patch body
//! carries, which rules a value must pass, and where an entity is served. `entity`, `client`
//! and `commands` therefore agree by construction, and an owned copy of any of them
//! (`cargo meta eject`) reads the same plan the shipped one does.
//!
//! Everything here reads EFFECTIVE metadata (ADR-0039): a field, validator or attribute
//! inherited through `extends` counts. The few own-only reads carry a comment saying why.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use metaobjects::collection::Collection;
use metaobjects::naming::{
    NamingCtx, NamingRegistry, collection_segment, emits_instance_artifacts, is_tph_subtype,
    primary_rdb_source, source_is_read_only,
};
use metaobjects::node::{NodeId, PACKAGE_SEP, Tree};
use metaobjects::validate::util::{ObjectIndex, ops_for_field};
use serde_json::Value;

use crate::emitted::pattern::Pattern;
use crate::emitted::wire::Duration;
use crate::generator::{
    ERR_CRATE_CYCLE, ERR_NAME_COLLISION, ERR_UNSUPPORTED, GenContext, GenError,
};
use crate::names::{crate_name, field_ident, module_name, pascal, type_ident};

/// The crate every generated model crate takes its wire types and checks from.
pub const SUPPORT_CRATE: &str = "meta_support";
/// The crate every generated client crate takes its transport from.
pub const CLIENT_CRATE: &str = "meta_client";
/// The crate every generated command crate takes its helpers from.
pub const CLI_CRATE: &str = "meta_cli";
/// The suffix of the client crate of a package: `shop` is served by `shop_client`.
pub const CLIENT_SUFFIX: &str = "_client";
/// The suffix of the command crate of a package: `shop` is driven by `shop_cli`.
pub const CLI_SUFFIX: &str = "_cli";

// ---- metamodel names -------------------------------------------------------------------

const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_IDENTITY: &str = "identity";
const TYPE_VALIDATOR: &str = "validator";
const TYPE_ORIGIN: &str = "origin";
const TYPE_RELATIONSHIP: &str = "relationship";
const TYPE_VIEW: &str = "view";
const VIEW_PASSWORD: &str = "password";
const OBJECT_ENTITY: &str = "entity";
const OBJECT_VALUE: &str = "value";
const IDENTITY_PRIMARY: &str = "primary";
const ATTR_DESCRIPTION: &str = "description";
const ATTR_VALUES: &str = "values";
const ATTR_INT_VALUE_MAP: &str = "intValueMap";
const ATTR_PROVIDED: &str = "provided";
const ATTR_OBJECT_REF: &str = "objectRef";
const ATTR_VALUE_TYPE: &str = "valueType";
const ATTR_REQUIRED: &str = "required";
const ATTR_FIELDS: &str = "fields";
const ATTR_GENERATION: &str = "generation";
const ATTR_MUTABILITY: &str = "mutability";
const ATTR_DEFAULT: &str = "default";
const ATTR_AUTO_SET: &str = "autoSet";
const ATTR_LENIENT: &str = "lenient";
const ATTR_LOCAL_TIME: &str = "localTime";
const ATTR_MAX_LENGTH: &str = "maxLength";
const ATTR_STRING_FORMAT: &str = "stringFormat";
const ATTR_FILTERABLE: &str = "filterable";
const ATTR_SORTABLE: &str = "sortable";
const ATTR_DISCRIMINATOR: &str = "discriminator";
const ATTR_DISCRIMINATOR_VALUE: &str = "discriminatorValue";
const ATTR_CARDINALITY: &str = "cardinality";
const ATTR_THROUGH: &str = "through";
const ATTR_MIN: &str = "min";
const ATTR_MAX: &str = "max";
const ATTR_PATTERN: &str = "pattern";
const ATTR_LEFT: &str = "left";
const ATTR_RIGHT: &str = "right";
const ATTR_OP: &str = "op";
const ATTR_FIELD: &str = "field";
const ATTR_WHEN: &str = "when";
const ATTR_EQUALS: &str = "equals";
const ATTR_CONDITION: &str = "condition";
const GENERATED_KEYS: &[&str] = &["increment", "uuid"];
const MUTABILITY_READ_ONLY: &str = "readOnly";
const MUTABILITY_WRITE_ONCE: &str = "writeOnce";
const CARDINALITY_MANY: &str = "many";
const FORMAT_HOSTNAME: &str = "hostname";
const FORMAT_EMAIL: &str = "email";

// ---- types -----------------------------------------------------------------------------

/// A generated type and the crate that declares it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TypeRef {
    pub crate_name: String,
    pub type_name: String,
}

/// The Rust type of one value of a field (before `Vec`, `Box` and `Option`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ty {
    Str,
    Prim(&'static str),
    /// `std::net::IpAddr`.
    Ip,
    /// The support crate's exact decimal.
    Decimal,
    /// The support crate's ISO-8601 duration.
    Duration,
    Ref(TypeRef),
    Map(Box<Ty>),
}

impl Ty {
    /// The generated type this is, or a map of.
    pub fn type_ref(&self) -> Option<&TypeRef> {
        match self {
            Ty::Ref(r) => Some(r),
            Ty::Map(inner) => inner.type_ref(),
            _ => None,
        }
    }

    /// Whether a value is `Copy`, so a member can be read without borrowing.
    pub fn is_copy(&self) -> bool {
        matches!(self, Ty::Prim(_) | Ty::Ip | Ty::Duration)
    }
}

/// What a field holds, by its metamodel subtype.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    String,
    Int,
    Long,
    Currency,
    Double,
    Float,
    Boolean,
    Decimal,
    Date,
    Time,
    Timestamp,
    Uuid,
    Uri,
    Inet,
    Duration,
    Enum,
    Object,
    Map,
}

impl Kind {
    fn of(sub_type: &str) -> Option<Kind> {
        Some(match sub_type {
            "string" => Kind::String,
            "int" => Kind::Int,
            "long" => Kind::Long,
            "currency" => Kind::Currency,
            "double" => Kind::Double,
            "float" => Kind::Float,
            "boolean" => Kind::Boolean,
            "decimal" => Kind::Decimal,
            "date" => Kind::Date,
            "time" => Kind::Time,
            "timestamp" => Kind::Timestamp,
            "uuid" => Kind::Uuid,
            "uri" => Kind::Uri,
            "inet" => Kind::Inet,
            "duration" => Kind::Duration,
            "enum" => Kind::Enum,
            "object" => Kind::Object,
            "map" => Kind::Map,
            _ => return None,
        })
    }

    pub fn is_integer(self) -> bool {
        matches!(self, Kind::Int | Kind::Long | Kind::Currency)
    }

    pub fn is_float(self) -> bool {
        matches!(self, Kind::Double | Kind::Float)
    }

    pub fn is_numeric(self) -> bool {
        self.is_integer() || self.is_float() || self == Kind::Decimal
    }

    /// Kinds with an order of their own (numbers aside).
    fn is_ordered(self) -> bool {
        matches!(
            self,
            Kind::String | Kind::Date | Kind::Time | Kind::Timestamp | Kind::Duration
        )
    }

    /// Kinds two values of which can only be equal or not.
    fn is_equality_only(self) -> bool {
        matches!(
            self,
            Kind::Boolean | Kind::Enum | Kind::Uuid | Kind::Uri | Kind::Inet
        )
    }
}

/// The form a string must be in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Hostname,
    Email,
    AbsoluteUri,
    Uuid,
    Date,
    Time,
    Timestamp,
}

/// The rules one field's value must pass. A bound is the number as the model wrote it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rules {
    pub min_len: Option<u64>,
    pub max_len: Option<u64>,
    pub min: Option<serde_json::Number>,
    pub max: Option<serde_json::Number>,
    pub min_items: Option<u64>,
    pub max_items: Option<u64>,
    /// The `validator.regex` pattern, which the value must match in full.
    pub pattern: Option<String>,
    pub format: Option<Format>,
}

impl Rules {
    pub fn is_empty(&self) -> bool {
        *self == Rules::default()
    }
}

/// Whether a body carries a member, and whether it must.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    /// The member is not part of the body.
    Absent,
    Required,
    Optional,
}

#[derive(Debug, Clone)]
pub struct Member {
    pub variant: String,
    pub wire: String,
}

#[derive(Debug, Clone)]
pub struct EnumPlan {
    pub type_name: String,
    pub doc: Option<String>,
    pub members: Vec<Member>,
}

#[derive(Debug, Clone)]
pub struct FieldPlan {
    pub node: NodeId,
    /// The member's name on the wire, which is its name in the model.
    pub wire: String,
    pub ident: String,
    pub ty: Ty,
    pub kind: Kind,
    pub array: bool,
    /// Whether the member of the READ type is an `Option`.
    pub optional: bool,
    pub boxed: bool,
    pub doc: Option<String>,
    pub required: bool,
    /// A member of the primary identity.
    pub primary: bool,
    /// A credential (the field has a `view.password`): an API never returns it, so a row
    /// read back has no such member.
    pub credential: bool,
    pub local_time: bool,
    /// Whether the create body carries the member.
    pub create: Presence,
    /// Whether the patch body carries the member (always optionally).
    pub patch: bool,
    /// The rules of a value. For an array these hold only the item-count bounds.
    pub rules: Rules,
    /// The filter operators a list request may use on the member; empty unless the model
    /// marks it `@filterable`.
    pub filter_ops: Vec<&'static str>,
    pub sortable: bool,
}

/// One of the six comparisons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CmpOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

impl CmpOp {
    fn of(name: &str) -> Option<CmpOp> {
        Some(match name {
            "eq" => CmpOp::Eq,
            "ne" => CmpOp::Ne,
            "gt" => CmpOp::Gt,
            "gte" => CmpOp::Gte,
            "lt" => CmpOp::Lt,
            "lte" => CmpOp::Lte,
            _ => return None,
        })
    }

    /// The variant of the support crate's `Op`.
    pub fn variant(self) -> &'static str {
        match self {
            CmpOp::Eq => "Eq",
            CmpOp::Ne => "Ne",
            CmpOp::Gt => "Gt",
            CmpOp::Gte => "Gte",
            CmpOp::Lt => "Lt",
            CmpOp::Lte => "Lte",
        }
    }

    pub fn is_equality(self) -> bool {
        matches!(self, CmpOp::Eq | CmpOp::Ne)
    }
}

/// How the two sides of a comparison are brought to one comparable type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    /// `i64`.
    Int,
    /// `f64`.
    Float,
    /// The support crate's `Decimal`.
    Decimal,
    /// `&str`, compared as text. An ISO date orders as its text does.
    Text,
    /// A time of day, by the support crate's `time_key`.
    Time,
    /// A timestamp, by the support crate's `instant_key`.
    Instant,
    /// The support crate's `Duration`.
    Duration,
    Bool,
    /// An enum member, by its wire spelling.
    Symbol,
    /// A UUID, compared without regard to case.
    Uuid,
    /// An address, compared as text.
    Address,
}

impl Class {
    /// Whether values of the class have an order, so all six operators apply.
    pub fn is_ordered(self) -> bool {
        !matches!(
            self,
            Class::Bool | Class::Symbol | Class::Uuid | Class::Address
        )
    }
}

/// A constant in a rule, already checked against the class it is compared in.
#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    Bool(bool),
    Int(i64),
    Float(f64),
    /// A decimal's canonical text.
    Decimal(String),
    Str(String),
    /// A duration in nanoseconds.
    Duration(i128),
}

/// A value a condition reads.
#[derive(Debug, Clone, PartialEq)]
pub enum Operand {
    /// The member at this index of the struct's fields.
    Field(usize),
    Value(Literal),
    /// The first operand that is present.
    Coalesce(Vec<Operand>),
}

/// A rule's `@condition`, three-valued: an absent member makes a comparison unknown.
#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Compare {
        op: CmpOp,
        class: Class,
        left: Operand,
        right: Operand,
    },
    IsNull(Operand),
    IsNotNull(Operand),
    Not(Box<Cond>),
    All(Vec<Cond>),
    Any(Vec<Cond>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum CrossKind {
    /// Violated only when both members are present and the comparison is false.
    Comparison {
        left: usize,
        op: CmpOp,
        right: usize,
        class: Class,
    },
    /// `field` must be present when `when` equals the literal.
    RequiredWhen {
        field: usize,
        when: usize,
        class: Class,
        equals: Literal,
    },
    /// `field` is present exactly when `when` equals the literal.
    PresentIff {
        field: usize,
        when: usize,
        class: Class,
        equals: Literal,
    },
    AtLeastOne {
        fields: Vec<usize>,
    },
    ExactlyOne {
        fields: Vec<usize>,
    },
}

/// A rule across the members of one create body.
#[derive(Debug, Clone, PartialEq)]
pub struct CrossRule {
    pub name: String,
    pub kind: CrossKind,
    /// The rule applies only when this holds.
    pub condition: Option<Cond>,
}

/// A many-to-many navigation: `GET /<segment>/{id}/<name>`.
#[derive(Debug, Clone)]
pub struct Traversal {
    pub name: String,
    /// The index of the target struct.
    pub target: usize,
}

/// Where an entity is served.
#[derive(Debug, Clone)]
pub struct Route {
    /// The path under the API root, without a leading slash: `orders`, `vehicles/bridge`.
    pub path: String,
    /// A view-backed entity answers reads only.
    pub read_only: bool,
    /// The index of the single primary-key field the `/{id}` routes take, when there is one
    /// and it is text or a whole number. An entity with any other key is listed and created,
    /// and not read, changed or deleted by key.
    pub key: Option<usize>,
    pub traversals: Vec<Traversal>,
}

#[derive(Debug, Clone)]
pub struct StructPlan {
    pub node: NodeId,
    pub key: String,
    pub crate_name: String,
    pub type_name: String,
    /// The object's name in the model.
    pub name: String,
    pub doc: Option<String>,
    pub is_entity: bool,
    pub fields: Vec<FieldPlan>,
    pub enums: Vec<EnumPlan>,
    /// Rules across the members of the create body, each already lowered.
    pub cross: Vec<CrossRule>,
    /// Set for an entity a generated API serves.
    pub route: Option<Route>,
}

impl StructPlan {
    pub fn module(&self) -> String {
        module_name(&self.type_name)
    }

    pub fn create_name(&self) -> String {
        format!("{}Create", self.type_name)
    }

    pub fn patch_name(&self) -> String {
        format!("{}Patch", self.type_name)
    }

    /// Whether the object has a create body and a patch body: every entity does.
    pub fn has_inputs(&self) -> bool {
        self.is_entity
    }

    /// The name of the entity's client type, in its package's client crate.
    pub fn client_name(&self) -> String {
        format!("{}Client", self.type_name)
    }

    /// The name of the entity's list query type, in its package's client crate.
    pub fn query_name(&self) -> String {
        format!("{}Query", self.type_name)
    }

    /// The name of the enum of the entity's sortable fields, in its package's client crate.
    pub fn sort_name(&self) -> String {
        format!("{}Sort", self.type_name)
    }

    /// The fields a list request may sort on.
    pub fn sortable(&self) -> impl Iterator<Item = &FieldPlan> {
        self.fields
            .iter()
            .filter(|f| f.sortable && !f.array && !matches!(f.kind, Kind::Object | Kind::Map))
    }

    /// The fields a list request may filter on.
    pub fn filterable(&self) -> impl Iterator<Item = &FieldPlan> {
        self.fields
            .iter()
            .filter(|f| !f.filter_ops.is_empty() && !f.array)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CratePlan {
    pub package: String,
    pub structs: Vec<usize>,
    pub shared_enums: Vec<(NodeId, EnumPlan)>,
    /// The model crates this one refers to.
    pub deps: BTreeSet<String>,
}

/// How the project wants members that hold nothing written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NullMembers {
    /// `"member": null`, which is what serde writes for a `None`.
    Emit,
    /// The member is left out.
    Omit,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub structs: Vec<StructPlan>,
    /// Model crates by name.
    pub crates: BTreeMap<String, CratePlan>,
    pub null_members: NullMembers,
}

fn unsupported(msg: String) -> GenError {
    GenError::new(ERR_UNSUPPORTED, msg)
}

fn str_attr<'t>(tree: &'t Tree, id: NodeId, name: &str) -> Option<&'t str> {
    tree.attr(id, name).and_then(Value::as_str)
}

fn bool_attr(tree: &Tree, id: NodeId, name: &str) -> bool {
    tree.attr(id, name).and_then(Value::as_bool) == Some(true)
}

fn u64_attr(tree: &Tree, id: NodeId, name: &str) -> Option<u64> {
    tree.attr(id, name).and_then(Value::as_u64)
}

/// A names attribute, which the model may write as one name or as a list.
fn names_attr(tree: &Tree, id: NodeId, name: &str) -> Vec<String> {
    match tree.attr(id, name) {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn is_a(tree: &Tree, id: NodeId, type_name: &str, sub_type: &str) -> bool {
    let n = tree.node(id);
    n.type_name == type_name && n.sub_type == sub_type
}

fn enum_members(tree: &Tree, field: NodeId, what: &str) -> Result<Vec<String>, GenError> {
    let values = tree
        .attr(field, ATTR_VALUES)
        .and_then(Value::as_array)
        .ok_or_else(|| unsupported(format!("{what} is a field.enum with no @values")))?;
    Ok(values
        .iter()
        .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
        .collect())
}

fn plan_enum(
    type_name: &str,
    symbols: &[String],
    doc: Option<String>,
) -> Result<EnumPlan, GenError> {
    let mut seen: HashMap<String, &str> = HashMap::new();
    let mut members = Vec::with_capacity(symbols.len());
    for s in symbols {
        let variant = type_ident(s);
        if let Some(other) = seen.insert(variant.clone(), s) {
            return Err(GenError::new(
                ERR_NAME_COLLISION,
                format!(
                    "enum {type_name}: the members '{other}' and '{s}' both become the Rust variant {variant}"
                ),
            ));
        }
        members.push(Member {
            variant,
            wire: s.clone(),
        });
    }
    Ok(EnumPlan {
        type_name: type_name.to_string(),
        doc,
        members,
    })
}

/// The root-level abstract `field.enum` a field resolves to through `extends`, if any
/// (ADR-0026 Amendment 1; the walk the TypeScript `resolveSharedEnumDeclaration` makes).
fn shared_enum_declaration(tree: &Tree, root: NodeId, field: NodeId) -> Option<NodeId> {
    let mut seen = HashSet::new();
    let mut cur = Some(field);
    while let Some(n) = cur {
        let node = tree.node(n);
        if node.type_name != TYPE_FIELD || node.sub_type != "enum" || !seen.insert(n) {
            return None;
        }
        if node.is_abstract && node.parent == Some(root) {
            return Some(n);
        }
        // ADR-0039 sanctioned own: the question is whether THIS node redeclares the
        // vocabulary; a resolving read would see the inherited @values on every hop.
        if tree.own_attr(n, ATTR_VALUES).is_some() || tree.own_attr(n, ATTR_INT_VALUE_MAP).is_some()
        {
            return None;
        }
        cur = node.super_node;
    }
    None
}

fn scalar(kind: Kind, lenient: bool) -> Option<Ty> {
    Some(match kind {
        Kind::String | Kind::Date | Kind::Time | Kind::Timestamp | Kind::Uuid | Kind::Uri => {
            Ty::Str
        }
        Kind::Int => Ty::Prim("i32"),
        Kind::Long | Kind::Currency => Ty::Prim("i64"),
        Kind::Double => Ty::Prim("f64"),
        Kind::Float => Ty::Prim("f32"),
        Kind::Boolean => Ty::Prim("bool"),
        Kind::Decimal => Ty::Decimal,
        Kind::Duration => Ty::Duration,
        // A lenient address is whatever text was reported, so it has no parsed form.
        Kind::Inet if lenient => Ty::Str,
        Kind::Inet => Ty::Ip,
        Kind::Enum | Kind::Object | Kind::Map => return None,
    })
}

/// The struct an `@objectRef` binds to, resolved by the loader's own resolver: the package
/// that declared the attribute (up the `extends` chain) decides, and the first top-level
/// object it names wins, emitted or not.
fn bound_struct(
    index: &ObjectIndex,
    by_node: &HashMap<NodeId, usize>,
    tree: &Tree,
    node: NodeId,
) -> Option<usize> {
    index
        .ref_target(tree, node, ATTR_OBJECT_REF)
        .and_then(|t| by_node.get(&t).copied())
}

/// Two fields of one struct must not become one Rust field.
fn check_fields(owner: &str, fields: &[FieldPlan]) -> Result<(), GenError> {
    let mut seen: HashMap<&str, &str> = HashMap::new();
    for f in fields {
        let bare = f.ident.strip_prefix("r#").unwrap_or(&f.ident);
        if let Some(prev) = seen.insert(bare, &f.wire) {
            return Err(GenError::new(
                ERR_NAME_COLLISION,
                format!(
                    "{owner}: the fields '{prev}' and '{}' both become the Rust field {bare}",
                    f.wire
                ),
            ));
        }
    }
    Ok(())
}

/// The field a TPH subtype's rows are told apart by: the `@discriminator` its base names.
fn pinned_discriminator(tree: &Tree, obj: NodeId) -> Option<String> {
    if !is_tph_subtype(tree, obj) {
        return None;
    }
    let mut seen = vec![obj];
    let mut cur = tree.node(obj).super_node;
    while let Some(n) = cur {
        if seen.contains(&n) {
            return None;
        }
        seen.push(n);
        // ADR-0039 sanctioned own: an explicit walk up the `extends` chain, reading at each
        // level what THAT level declares, to find the level that is the hierarchy's base.
        if let Some(name) = tree
            .own_attr(n, ATTR_DISCRIMINATOR)
            .and_then(|a| a.value.as_str())
            && !name.is_empty()
        {
            return Some(name.to_string());
        }
        cur = tree.node(n).super_node;
    }
    None
}

/// The rules of one field, from its attributes and its `validator.*` children.
fn field_rules(
    tree: &Tree,
    f: NodeId,
    kind: Kind,
    array: bool,
    required: bool,
    lenient: bool,
) -> Rules {
    let mut rules = Rules::default();
    let mut authored_min_len = false;
    let mut length_max: Option<u64> = None;
    for &v in tree.children(f).iter() {
        let n = tree.node(v);
        if n.type_name != TYPE_VALIDATOR {
            continue;
        }
        match n.sub_type.as_str() {
            "length" if !array => {
                if let Some(min) = u64_attr(tree, v, ATTR_MIN) {
                    authored_min_len = true;
                    rules.min_len = (min > 0).then_some(min);
                }
                length_max = length_max.or(u64_attr(tree, v, ATTR_MAX));
            }
            "numeric" if !array && kind.is_numeric() => {
                let bound = |name| tree.attr(v, name).and_then(Value::as_number).cloned();
                rules.min = rules.min.or(bound(ATTR_MIN));
                rules.max = rules.max.or(bound(ATTR_MAX));
            }
            "array" if array => {
                rules.min_items = rules.min_items.or(u64_attr(tree, v, ATTR_MIN));
                rules.max_items = rules.max_items.or(u64_attr(tree, v, ATTR_MAX));
            }
            // The first pattern is the rule, as in every port.
            "regex" if !array && rules.pattern.is_none() => {
                rules.pattern = str_attr(tree, v, ATTR_PATTERN).map(str::to_string);
            }
            _ => {}
        }
    }
    if array {
        return rules;
    }
    let is_text = matches!(kind, Kind::String | Kind::Uri) || (kind == Kind::Inet && lenient);
    if !is_text {
        // A length or a pattern is a rule of text; a number or a date has neither.
        rules.min_len = None;
        rules.pattern = None;
    } else {
        // `@maxLength` sizes an enum's column and is no rule of its value; on text the
        // tighter of it and the validator's bound wins.
        let attr_max = u64_attr(tree, f, ATTR_MAX_LENGTH);
        rules.max_len = match (attr_max, length_max) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        // A required string is not satisfied by the empty string, unless the model set a
        // minimum of its own (`@min: 0` says the empty string is fine).
        if kind == Kind::String && required && !authored_min_len {
            rules.min_len = Some(1);
        }
    }
    rules.format = match kind {
        Kind::String => match str_attr(tree, f, ATTR_STRING_FORMAT) {
            Some(FORMAT_HOSTNAME) => Some(Format::Hostname),
            Some(FORMAT_EMAIL) => Some(Format::Email),
            _ => None,
        },
        Kind::Uri if !lenient => Some(Format::AbsoluteUri),
        Kind::Uuid => Some(Format::Uuid),
        Kind::Date => Some(Format::Date),
        Kind::Time => Some(Format::Time),
        Kind::Timestamp => Some(Format::Timestamp),
        _ => None,
    };
    rules
}

impl Plan {
    /// The plan of the model a generator was handed.
    pub fn of(ctx: &GenContext<'_>) -> Result<Plan, GenError> {
        Plan::build(ctx.tree, ctx.root, ctx.collection)
    }

    pub fn build(tree: &Tree, root: NodeId, collection: &Collection) -> Result<Plan, GenError> {
        // Every concrete entity and value object, in model order.
        let mut structs: Vec<StructPlan> = Vec::new();
        let mut by_node: HashMap<NodeId, usize> = HashMap::new();
        let index = ObjectIndex::build(tree, root);
        for &id in tree.own_children(root) {
            let n = tree.node(id);
            if n.type_name != TYPE_OBJECT
                || !matches!(n.sub_type.as_str(), OBJECT_ENTITY | OBJECT_VALUE)
                || n.is_abstract
            {
                continue;
            }
            let pkg = tree.effective_package(id);
            by_node.insert(id, structs.len());
            structs.push(StructPlan {
                node: id,
                key: tree.resolution_key(id),
                crate_name: crate_name(&pkg),
                type_name: type_ident(&n.name),
                name: n.name.clone(),
                doc: str_attr(tree, id, ATTR_DESCRIPTION).map(str::to_string),
                is_entity: n.sub_type == OBJECT_ENTITY,
                fields: Vec::new(),
                enums: Vec::new(),
                cross: Vec::new(),
                route: None,
            });
        }

        let mut crates: BTreeMap<String, CratePlan> = BTreeMap::new();
        for (i, s) in structs.iter().enumerate() {
            let pkg = tree.effective_package(s.node);
            let c = crates.entry(s.crate_name.clone()).or_default();
            if c.structs.is_empty() {
                c.package = pkg.clone();
            } else if c.package != pkg {
                return Err(GenError::new(
                    ERR_NAME_COLLISION,
                    format!(
                        "the packages '{}' and '{}' both become the crate {}",
                        c.package, pkg, s.crate_name
                    ),
                ));
            }
            c.structs.push(i);
        }

        // Fields.
        let mut shared: BTreeMap<NodeId, TypeRef> = BTreeMap::new();
        for i in 0..structs.len() {
            let (node, owner_crate, owner_type, owner_key, is_entity) = {
                let s = &structs[i];
                (
                    s.node,
                    s.crate_name.clone(),
                    s.type_name.clone(),
                    s.key.clone(),
                    s.is_entity,
                )
            };
            let mut primary: HashSet<String> = HashSet::new();
            let mut generated_key: HashSet<String> = HashSet::new();
            for &c in tree.children(node).iter() {
                if !is_a(tree, c, TYPE_IDENTITY, IDENTITY_PRIMARY) {
                    continue;
                }
                let members = names_attr(tree, c, ATTR_FIELDS);
                if str_attr(tree, c, ATTR_GENERATION).is_some_and(|g| GENERATED_KEYS.contains(&g)) {
                    generated_key.extend(members.iter().cloned());
                }
                primary.extend(members);
            }
            let pinned = pinned_discriminator(tree, node);
            let mut fields: Vec<FieldPlan> = Vec::new();
            let mut enums: Vec<EnumPlan> = Vec::new();
            for &f in tree.children(node).iter() {
                let fnode = tree.node(f);
                if fnode.type_name != TYPE_FIELD {
                    continue;
                }
                let what = format!("{owner_key}.{}", fnode.name);
                let kind = Kind::of(&fnode.sub_type).ok_or_else(|| {
                    unsupported(format!(
                        "{what} has the field subtype {}, which has no Rust mapping",
                        fnode.sub_type
                    ))
                })?;
                let lenient = bool_attr(tree, f, ATTR_LENIENT);
                let array = tree.resolved_is_array(f);
                let mut boxed = false;
                let ty = match kind {
                    Kind::Enum => {
                        if let Some(decl) = shared_enum_declaration(tree, root, f) {
                            // ADR-0039 sanctioned own: `@provided` marks THIS declaration as
                            // supplied by hand-written code, like `abstract`; it does not
                            // flow down an extends chain.
                            if tree
                                .own_attr(decl, ATTR_PROVIDED)
                                .and_then(|a| a.value.as_bool())
                                == Some(true)
                            {
                                return Err(unsupported(format!(
                                    "{what} uses the @provided enum {}: the Rust generator has no setting for where a hand-written enum lives yet",
                                    tree.node(decl).name
                                )));
                            }
                            let target = shared.entry(decl).or_insert_with(|| TypeRef {
                                crate_name: crate_name(&tree.effective_package(decl)),
                                type_name: type_ident(&tree.node(decl).name),
                            });
                            Ty::Ref(target.clone())
                        } else {
                            let symbols = enum_members(tree, f, &what)?;
                            let name = format!("{owner_type}{}", pascal(&fnode.name));
                            let doc = str_attr(tree, f, ATTR_DESCRIPTION).map(str::to_string);
                            enums.push(plan_enum(&name, &symbols, doc)?);
                            Ty::Ref(TypeRef {
                                crate_name: owner_crate.clone(),
                                type_name: name,
                            })
                        }
                    }
                    Kind::Object => match str_attr(tree, f, ATTR_OBJECT_REF) {
                        // The loader refuses a field.object without an @objectRef
                        // (ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF), so none reaches here.
                        None => {
                            return Err(unsupported(format!(
                                "{what} is a field.object with no @objectRef"
                            )));
                        }
                        Some(r) => {
                            let target =
                                bound_struct(&index, &by_node, tree, f).ok_or_else(|| {
                                    unsupported(format!(
                                        "{what} refers to {r}, which is not a concrete entity or value object the entity generator emits"
                                    ))
                                })?;
                            boxed = !array;
                            Ty::Ref(TypeRef {
                                crate_name: structs[target].crate_name.clone(),
                                type_name: structs[target].type_name.clone(),
                            })
                        }
                    },
                    Kind::Map => {
                        let value = if let Some(r) = str_attr(tree, f, ATTR_OBJECT_REF) {
                            let target =
                                bound_struct(&index, &by_node, tree, f).ok_or_else(|| {
                                    unsupported(format!(
                                        "{what} is a map of {r}, which is not a concrete entity or value object the entity generator emits"
                                    ))
                                })?;
                            Ty::Ref(TypeRef {
                                crate_name: structs[target].crate_name.clone(),
                                type_name: structs[target].type_name.clone(),
                            })
                        } else {
                            let vt = str_attr(tree, f, ATTR_VALUE_TYPE).unwrap_or("string");
                            Kind::of(vt).and_then(|k| scalar(k, false)).ok_or_else(|| {
                                unsupported(format!(
                                    "{what} is a map with the unsupported @valueType {vt}"
                                ))
                            })?
                        };
                        Ty::Map(Box::new(value))
                    }
                    other => scalar(other, lenient).expect("every scalar kind has a type"),
                };
                // A map is one value, never wrapped in a Vec.
                let array = array && kind != Kind::Map;
                let required = bool_attr(tree, f, ATTR_REQUIRED);
                let is_primary = primary.contains(&fnode.name);
                let derived = tree
                    .children(f)
                    .iter()
                    .any(|&c| tree.node(c).type_name == TYPE_ORIGIN);
                let mutability = str_attr(tree, f, ATTR_MUTABILITY).unwrap_or("");
                let is_pinned = pinned.as_deref() == Some(fnode.name.as_str());
                let server_filled =
                    tree.attr(f, ATTR_DEFAULT).is_some() || tree.attr(f, ATTR_AUTO_SET).is_some();
                let create = if !is_entity
                    || generated_key.contains(&fnode.name)
                    || mutability == MUTABILITY_READ_ONLY
                    || derived
                    || is_pinned
                {
                    Presence::Absent
                } else if (required || is_primary) && !server_filled {
                    Presence::Required
                } else {
                    Presence::Optional
                };
                let patch = is_entity
                    && !is_primary
                    && !derived
                    && !is_pinned
                    && !matches!(mutability, MUTABILITY_READ_ONLY | MUTABILITY_WRITE_ONCE);
                let filterable = bool_attr(tree, f, ATTR_FILTERABLE)
                    && !matches!(kind, Kind::Object | Kind::Map);
                fields.push(FieldPlan {
                    node: f,
                    wire: fnode.name.clone(),
                    ident: field_ident(&fnode.name),
                    ty,
                    kind,
                    array,
                    optional: !(required || is_primary),
                    boxed,
                    doc: str_attr(tree, f, ATTR_DESCRIPTION).map(str::to_string),
                    required,
                    primary: is_primary,
                    credential: tree
                        .children(f)
                        .iter()
                        .any(|&c| is_a(tree, c, TYPE_VIEW, VIEW_PASSWORD)),
                    local_time: bool_attr(tree, f, ATTR_LOCAL_TIME),
                    create,
                    patch,
                    rules: field_rules(tree, f, kind, array, required, lenient),
                    filter_ops: if filterable {
                        ops_for_field(tree, f).to_vec()
                    } else {
                        Vec::new()
                    },
                    sortable: bool_attr(tree, f, ATTR_SORTABLE),
                });
            }
            check_fields(&owner_key, &fields)?;
            for f in &fields {
                if let Some(source) = &f.rules.pattern
                    && let Err(e) = Pattern::parse(source)
                {
                    return Err(unsupported(format!(
                        "{owner_key}.{}: the validator.regex pattern {source:?} uses a construct the generated matcher does not support ({e})",
                        f.wire
                    )));
                }
            }
            structs[i].cross = cross_rules(tree, node, &fields);
            structs[i].fields = fields;
            structs[i].enums = enums;
        }

        // Shared enums are materialized once, in their declaration's package, and only when a
        // field consumes them.
        for (&decl, target) in &shared {
            let symbols = enum_members(tree, decl, &tree.resolution_key(decl))?;
            let plan = plan_enum(
                &target.type_name,
                &symbols,
                str_attr(tree, decl, ATTR_DESCRIPTION).map(str::to_string),
            )?;
            let pkg = tree.effective_package(decl);
            let c = crates.entry(target.crate_name.clone()).or_default();
            if c.structs.is_empty() && c.shared_enums.is_empty() {
                c.package = pkg;
            } else if c.package != pkg {
                return Err(GenError::new(
                    ERR_NAME_COLLISION,
                    format!(
                        "the packages '{}' and '{}' both become the crate {}",
                        c.package, pkg, target.crate_name
                    ),
                ));
            }
            c.shared_enums.push((decl, plan));
        }

        let null_members = match collection.wire_format.null_members {
            metaobjects::config::WireNullMembers::Omit => NullMembers::Omit,
            _ => NullMembers::Emit,
        };
        let mut plan = Plan {
            structs,
            crates,
            null_members,
        };
        plan.routes(tree, &index, &by_node, collection)?;
        plan.link_dependencies();
        plan.check_names()?;
        plan.check_cycles()?;
        plan.box_cycles();
        Ok(plan)
    }

    /// Where each served entity lives. An entity is served when it is concrete and backed by
    /// a store (it declares or inherits a `source.rdb`), which is the rule every port's
    /// route generator follows.
    fn routes(
        &mut self,
        tree: &Tree,
        index: &ObjectIndex,
        by_node: &HashMap<NodeId, usize>,
        collection: &Collection,
    ) -> Result<(), GenError> {
        let registry = NamingRegistry::builtin();
        let ctx = NamingCtx::new(&registry, &collection.physical_naming);
        let fail = |e: metaobjects::errors::MetaError| unsupported(e.to_string());
        for i in 0..self.structs.len() {
            let s = &self.structs[i];
            if !s.is_entity || !emits_instance_artifacts(tree, s.node) {
                continue;
            }
            let mut path = None;
            if is_tph_subtype(tree, s.node) {
                // A subtype is served under its hierarchy's base, at its discriminator value
                // in lower case.
                // ADR-0039 sanctioned own: `@discriminatorValue` is THIS subtype's value, and
                // the base is found by reading each ancestor's own `@discriminator`.
                let value = tree
                    .own_attr(s.node, ATTR_DISCRIMINATOR_VALUE)
                    .and_then(|a| a.value.as_str())
                    .unwrap_or_default()
                    .to_lowercase();
                let mut cur = tree.node(s.node).super_node;
                let mut seen = vec![s.node];
                while let Some(n) = cur {
                    if seen.contains(&n) {
                        break;
                    }
                    seen.push(n);
                    if tree.own_attr(n, ATTR_DISCRIMINATOR).is_some() {
                        let base = collection_segment(tree, n, &ctx).map_err(fail)?;
                        path = Some(format!("{base}/{value}"));
                        break;
                    }
                    cur = tree.node(n).super_node;
                }
            }
            let path = match path {
                Some(p) => p,
                None => collection_segment(tree, s.node, &ctx).map_err(fail)?,
            };
            let read_only = primary_rdb_source(tree, s.node, &ctx)
                .map_err(fail)?
                .is_some_and(|source| source_is_read_only(tree, source));
            let keys: Vec<usize> = s
                .fields
                .iter()
                .enumerate()
                .filter(|(_, f)| f.primary)
                .map(|(k, _)| k)
                .collect();
            // The `/{id}` routes take one key written as text or as a whole number.
            let key = match keys.as_slice() {
                [only]
                    if !s.fields[*only].array
                        && matches!(s.fields[*only].ty, Ty::Str | Ty::Prim("i32" | "i64")) =>
                {
                    Some(*only)
                }
                _ => None,
            };
            let mut traversals = Vec::new();
            for &r in tree.children(s.node).iter() {
                if tree.node(r).type_name != TYPE_RELATIONSHIP
                    || str_attr(tree, r, ATTR_CARDINALITY) != Some(CARDINALITY_MANY)
                    || str_attr(tree, r, ATTR_THROUGH).is_none()
                {
                    continue;
                }
                if let Some(target) = bound_struct(index, by_node, tree, r) {
                    traversals.push(Traversal {
                        name: tree.node(r).name.clone(),
                        target,
                    });
                }
            }
            self.structs[i].route = Some(Route {
                path,
                read_only,
                key,
                traversals,
            });
        }
        Ok(())
    }

    /// Every reference into another crate is a path dependency on it.
    fn link_dependencies(&mut self) {
        let mut edges: Vec<(String, String)> = Vec::new();
        for s in &self.structs {
            for f in &s.fields {
                if let Some(t) = f.ty.type_ref()
                    && t.crate_name != s.crate_name
                {
                    edges.push((s.crate_name.clone(), t.crate_name.clone()));
                }
            }
        }
        for (from, to) in edges {
            self.crates.get_mut(&from).expect("crate").deps.insert(to);
        }
    }

    /// Two types of one crate must not share a Rust name or a module name, and a model crate
    /// must not take the name of a crate the generators write themselves.
    fn check_names(&self) -> Result<(), GenError> {
        let mut crate_names: BTreeMap<String, String> = BTreeMap::new();
        let mut claim_crate =
            |name: String, origin: String| match crate_names.insert(name.clone(), origin.clone()) {
                Some(prev) => Err(GenError::new(
                    ERR_NAME_COLLISION,
                    format!("{origin} and {prev} are both the crate {name}"),
                )),
                None => Ok(()),
            };
        for shared in [SUPPORT_CRATE, CLIENT_CRATE, CLI_CRATE] {
            claim_crate(
                shared.to_string(),
                format!("the generated support crate {shared}"),
            )?;
        }
        for (cname, c) in &self.crates {
            let origin = |layer: &str| format!("the {layer} of the package '{}'", c.package);
            claim_crate(cname.clone(), origin("model"))?;
            if c.structs.iter().any(|&i| self.structs[i].route.is_some()) {
                claim_crate(format!("{cname}{CLIENT_SUFFIX}"), origin("client"))?;
                claim_crate(format!("{cname}{CLI_SUFFIX}"), origin("commands"))?;
            }
        }
        for (cname, c) in &self.crates {
            let mut types: BTreeMap<String, String> = BTreeMap::new();
            let mut modules: BTreeMap<String, String> = BTreeMap::new();
            let mut claim = |ty: &str, origin: String, module: Option<String>| {
                if let Some(prev) = types.insert(ty.to_string(), origin.clone()) {
                    return Err(GenError::new(
                        ERR_NAME_COLLISION,
                        format!("crate {cname}: {origin} and {prev} are both named {ty}"),
                    ));
                }
                if let Some(m) = module
                    && let Some(prev) = modules.insert(m.clone(), origin.clone())
                {
                    return Err(GenError::new(
                        ERR_NAME_COLLISION,
                        format!("crate {cname}: {origin} and {prev} both become the module {m}"),
                    ));
                }
                Ok(())
            };
            for &i in &c.structs {
                let s = &self.structs[i];
                claim(&s.type_name, s.key.clone(), Some(s.module()))?;
                if s.has_inputs() {
                    claim(
                        &s.create_name(),
                        format!("the create body of {}", s.key),
                        None,
                    )?;
                    claim(
                        &s.patch_name(),
                        format!("the patch body of {}", s.key),
                        None,
                    )?;
                }
                for e in &s.enums {
                    claim(&e.type_name, format!("the enum {}", e.type_name), None)?;
                }
            }
            for (decl, e) in &c.shared_enums {
                claim(
                    &e.type_name,
                    format!("the shared enum declaration #{}", decl.index()),
                    Some(module_name(&e.type_name)),
                )?;
            }
        }
        Ok(())
    }

    /// Cargo refuses cyclic path dependencies, so two packages that refer to each other
    /// cannot become two crates.
    fn check_cycles(&self) -> Result<(), GenError> {
        #[derive(Clone, Copy, PartialEq)]
        enum Mark {
            Open,
            Done,
        }
        fn visit<'a>(
            name: &'a str,
            crates: &'a BTreeMap<String, CratePlan>,
            marks: &mut HashMap<&'a str, Mark>,
            path: &mut Vec<&'a str>,
        ) -> Option<Vec<String>> {
            match marks.get(name) {
                Some(Mark::Done) => return None,
                Some(Mark::Open) => {
                    let start = path.iter().position(|p| *p == name).unwrap_or(0);
                    let mut cycle: Vec<String> =
                        path[start..].iter().map(|s| s.to_string()).collect();
                    cycle.push(name.to_string());
                    return Some(cycle);
                }
                None => {}
            }
            marks.insert(name, Mark::Open);
            path.push(name);
            if let Some(c) = crates.get(name) {
                for dep in &c.deps {
                    if let Some(cycle) = visit(dep, crates, marks, path) {
                        return Some(cycle);
                    }
                }
            }
            path.pop();
            marks.insert(name, Mark::Done);
            None
        }
        let mut marks = HashMap::new();
        for name in self.crates.keys() {
            if let Some(cycle) = visit(name, &self.crates, &mut marks, &mut Vec::new()) {
                return Err(GenError::new(
                    ERR_CRATE_CYCLE,
                    format!(
                        "these packages refer to each other, so their crates would depend on each other, which Cargo refuses: {}",
                        cycle.join(" -> ")
                    ),
                ));
            }
        }
        Ok(())
    }

    /// The index of the struct a type reference names.
    pub fn struct_of(&self, t: &TypeRef) -> Option<usize> {
        self.structs
            .iter()
            .position(|s| s.crate_name == t.crate_name && s.type_name == t.type_name)
    }

    /// A struct that contains itself by value, directly or through others, has no size.
    /// Every by-value containment edge that lies inside a cycle goes through a `Box`.
    fn box_cycles(&mut self) {
        let index: HashMap<(&str, &str), usize> = self
            .structs
            .iter()
            .enumerate()
            .map(|(i, s)| ((s.crate_name.as_str(), s.type_name.as_str()), i))
            .collect();
        let edges: Vec<Vec<(usize, usize)>> = self
            .structs
            .iter()
            .map(|s| {
                s.fields
                    .iter()
                    .enumerate()
                    .filter(|(_, f)| f.boxed)
                    .filter_map(|(fi, f)| {
                        let t = f.ty.type_ref()?;
                        let target = *index.get(&(t.crate_name.as_str(), t.type_name.as_str()))?;
                        Some((fi, target))
                    })
                    .collect()
            })
            .collect();
        let adjacency: Vec<Vec<usize>> = edges
            .iter()
            .map(|e| e.iter().map(|&(_, t)| t).collect())
            .collect();
        let component = strongly_connected(&adjacency);
        let mut cyclic: Vec<(usize, usize)> = Vec::new();
        for (si, list) in edges.iter().enumerate() {
            for &(fi, target) in list {
                if component[si] == component[target] {
                    cyclic.push((si, fi));
                }
            }
        }
        for s in &mut self.structs {
            for f in &mut s.fields {
                f.boxed = false;
            }
        }
        for (si, fi) in cyclic {
            self.structs[si].fields[fi].boxed = true;
        }
    }

    /// The model crates a run limited to `entities` writes, or `None` for every crate.
    ///
    /// A named run emits every file of every crate that contains a named object, plus the
    /// crates those depend on: a crate's manifest declares a path dependency on every crate
    /// its fields reference, so a dependency left out would leave output `cargo check` cannot
    /// build. Unchanged bytes are never rewritten, so re-emitting a dependency costs nothing.
    pub fn selected_crates(
        &self,
        entities: &[String],
    ) -> Result<Option<HashSet<String>>, GenError> {
        if entities.is_empty() {
            return Ok(None);
        }
        let mut picked = HashSet::new();
        for name in entities {
            let exact = name.strip_prefix(PACKAGE_SEP);
            let hits: Vec<usize> = self
                .structs
                .iter()
                .enumerate()
                .filter(|(_, s)| match exact {
                    Some(key) => s.key == key,
                    None => {
                        s.key == *name || s.key.rsplit(PACKAGE_SEP).next() == Some(name.as_str())
                    }
                })
                .map(|(i, _)| i)
                .collect();
            match hits.as_slice() {
                [] => {
                    return Err(GenError::new(
                        ERR_UNSUPPORTED,
                        format!("no entity or value object named {name}"),
                    ));
                }
                [only] => {
                    picked.insert(*only);
                }
                many => {
                    let keys: Vec<&str> =
                        many.iter().map(|&i| self.structs[i].key.as_str()).collect();
                    return Err(GenError::new(
                        ERR_NAME_COLLISION,
                        format!(
                            "{name} names more than one entity or value object ({}); name one by its full key, `::Name` for a package-less object or `pkg::Name`",
                            keys.join(", ")
                        ),
                    ));
                }
            }
        }
        let mut chosen: HashSet<String> = self
            .crates
            .iter()
            .filter(|(_, c)| c.structs.iter().any(|i| picked.contains(i)))
            .map(|(name, _)| name.clone())
            .collect();
        let mut queue: Vec<String> = chosen.iter().cloned().collect();
        while let Some(name) = queue.pop() {
            if let Some(c) = self.crates.get(&name) {
                for dep in &c.deps {
                    if chosen.insert(dep.clone()) {
                        queue.push(dep.clone());
                    }
                }
            }
        }
        Ok(Some(chosen))
    }

    /// The served entities of a model crate, in model order.
    pub fn served<'a>(&'a self, c: &'a CratePlan) -> impl Iterator<Item = &'a StructPlan> {
        c.structs
            .iter()
            .map(|&i| &self.structs[i])
            .filter(|s| s.route.is_some())
    }
}

// ---- rules across members --------------------------------------------------------------

/// The comparison class of two fields, when a comparison between them has a sound meaning:
/// numbers compare with each other; text, temporals and durations only with their own kind
/// and the same `@localTime`; booleans, enums, UUIDs, URIs and addresses only test equality.
/// Anything else is skipped, never rejected, as in every port.
fn pair_class(a: &FieldPlan, b: &FieldPlan, op: CmpOp) -> Option<Class> {
    if a.array || b.array {
        return None;
    }
    if a.kind.is_numeric() && b.kind.is_numeric() {
        return Some(numeric_class(&[a.kind, b.kind], false));
    }
    if a.kind != b.kind || a.local_time != b.local_time {
        return None;
    }
    if a.kind.is_ordered() || (op.is_equality() && a.kind.is_equality_only()) {
        return own_class(a.kind);
    }
    None
}

fn numeric_class(kinds: &[Kind], fractional_literal: bool) -> Class {
    if kinds.contains(&Kind::Decimal) {
        Class::Decimal
    } else if fractional_literal || kinds.iter().any(|k| k.is_float()) {
        Class::Float
    } else {
        Class::Int
    }
}

/// The class a kind is compared in against its own kind.
fn own_class(kind: Kind) -> Option<Class> {
    Some(match kind {
        Kind::Int | Kind::Long | Kind::Currency => Class::Int,
        Kind::Double | Kind::Float => Class::Float,
        Kind::Decimal => Class::Decimal,
        Kind::String | Kind::Date | Kind::Uri => Class::Text,
        Kind::Time => Class::Time,
        Kind::Timestamp => Class::Instant,
        Kind::Duration => Class::Duration,
        Kind::Boolean => Class::Bool,
        Kind::Enum => Class::Symbol,
        Kind::Uuid => Class::Uuid,
        Kind::Inet => Class::Address,
        Kind::Object | Kind::Map => return None,
    })
}

fn is_numeric_text(text: &str) -> bool {
    let body = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match body.split_once('.') {
        Some((w, f)) => (w, Some(f)),
        None => (body, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(whole) && fraction.is_none_or(digits)
}

/// A constant as a value of `class`, or `None` when it is not one.
fn literal(value: &Value, class: Class) -> Option<Literal> {
    match (class, value) {
        (Class::Bool, Value::Bool(b)) => Some(Literal::Bool(*b)),
        (Class::Int, Value::Number(n)) => n.as_i64().map(Literal::Int),
        (Class::Float, Value::Number(n)) => n.as_f64().map(Literal::Float),
        (Class::Decimal, Value::Number(n)) => Some(Literal::Decimal(n.to_string())),
        (Class::Duration, Value::String(s)) => Duration::parse(s)
            .ok()
            .map(|d| Literal::Duration(d.nanos())),
        (Class::Uuid, Value::String(s)) => Some(Literal::Str(s.to_ascii_lowercase())),
        (
            Class::Text | Class::Time | Class::Instant | Class::Symbol | Class::Address,
            Value::String(s),
        ) => Some(Literal::Str(s.clone())),
        _ => None,
    }
}

/// An `@equals` literal, which the model writes as text and the gating field types.
fn equals_literal(raw: &Value, when: &FieldPlan) -> Option<(Class, Literal)> {
    let text = raw.as_str().map_or_else(|| raw.to_string(), str::to_string);
    let class = own_class(when.kind)?;
    let lit = match class {
        Class::Bool => Literal::Bool(matches!(text.as_str(), "true" | "1" | "TRUE")),
        Class::Int if is_numeric_text(&text) => match text.parse::<i64>() {
            Ok(n) => Literal::Int(n),
            // A fraction can never equal a whole number: the gate never opens.
            Err(_) => return None,
        },
        Class::Float if is_numeric_text(&text) => Literal::Float(text.parse().ok()?),
        Class::Decimal if is_numeric_text(&text) => Literal::Decimal(text),
        Class::Int | Class::Float | Class::Decimal => return None,
        Class::Duration => Literal::Duration(Duration::parse(&text).ok()?.nanos()),
        Class::Uuid => Literal::Str(text.to_ascii_lowercase()),
        _ => Literal::Str(text),
    };
    Some((class, lit))
}

struct Lowering<'a> {
    fields: &'a [FieldPlan],
    /// Whether a member of the create body may be read: the rule is about that body.
    in_body: &'a dyn Fn(usize) -> bool,
}

impl Lowering<'_> {
    fn field(&self, name: &str) -> Option<usize> {
        let at = self.fields.iter().position(|f| f.wire == name)?;
        (self.in_body)(at).then_some(at)
    }

    /// Every field a value node reads.
    fn fields_of(&self, node: &Value, out: &mut Vec<usize>) -> Option<()> {
        if let Some(name) = node.get(ATTR_FIELD).and_then(Value::as_str) {
            out.push(self.field(name)?);
        } else if let Some(args) = node.get("args").and_then(Value::as_array) {
            for a in args {
                self.fields_of(a, out)?;
            }
        }
        Some(())
    }

    fn operand(&self, node: &Value, class: Class) -> Option<Operand> {
        if let Some(name) = node.get(ATTR_FIELD).and_then(Value::as_str) {
            return self.field(name).map(Operand::Field);
        }
        if let Some(value) = node.get("value") {
            return literal(value, class).map(Operand::Value);
        }
        if node.get("fn").and_then(Value::as_str) == Some("coalesce") {
            let args = node.get("args")?.as_array()?;
            return args
                .iter()
                .map(|a| self.operand(a, class))
                .collect::<Option<Vec<_>>>()
                .map(Operand::Coalesce);
        }
        None
    }

    /// A condition, or `None` when it reads a member the body lacks or compares what has
    /// no sound comparison: the whole rule is then left to the database.
    fn condition(&self, node: &Value) -> Option<Cond> {
        let op = node.get(ATTR_OP)?.as_str()?;
        if let Some(cmp) = CmpOp::of(op) {
            let (left, right) = (node.get(ATTR_LEFT)?, node.get(ATTR_RIGHT)?);
            let mut read = Vec::new();
            self.fields_of(left, &mut read)?;
            self.fields_of(right, &mut read)?;
            let mut class = None;
            for (i, &a) in read.iter().enumerate() {
                for &b in &read[i + 1..] {
                    class = Some(pair_class(&self.fields[a], &self.fields[b], cmp)?);
                }
            }
            let kinds: Vec<Kind> = read.iter().map(|&i| self.fields[i].kind).collect();
            let class = match (class, kinds.first()) {
                // Several numbers: the widest of them all decides, and a constant with a
                // fraction makes whole numbers compare as floats.
                (Some(Class::Int | Class::Float | Class::Decimal), _) | (None, Some(_))
                    if kinds.iter().all(|k| k.is_numeric()) =>
                {
                    numeric_class(&kinds, has_fraction(left) || has_fraction(right))
                }
                (Some(c), _) => c,
                (None, Some(&k)) => {
                    let f = &self.fields[read[0]];
                    if f.array || !(k.is_ordered() || (cmp.is_equality() && k.is_equality_only())) {
                        return None;
                    }
                    own_class(k)?
                }
                // Two constants: a comparison of the model with itself. Left to the database.
                (None, None) => return None,
            };
            return Some(Cond::Compare {
                op: cmp,
                class,
                left: self.operand(left, class)?,
                right: self.operand(right, class)?,
            });
        }
        match op {
            "isNull" | "isNotNull" => {
                let arg = self.presence_operand(node.get("arg")?)?;
                Some(if op == "isNull" {
                    Cond::IsNull(arg)
                } else {
                    Cond::IsNotNull(arg)
                })
            }
            "not" => self
                .condition(node.get("arg")?)
                .map(|c| Cond::Not(Box::new(c))),
            "and" | "or" => {
                let parts = node
                    .get("args")?
                    .as_array()?
                    .iter()
                    .map(|a| self.condition(a))
                    .collect::<Option<Vec<_>>>()?;
                Some(if op == "and" {
                    Cond::All(parts)
                } else {
                    Cond::Any(parts)
                })
            }
            _ => None,
        }
    }

    /// An operand that is only tested for presence, so its class does not matter.
    fn presence_operand(&self, node: &Value) -> Option<Operand> {
        if let Some(name) = node.get(ATTR_FIELD).and_then(Value::as_str) {
            return self.field(name).map(Operand::Field);
        }
        if node.get("value").is_some() {
            return Some(Operand::Value(Literal::Bool(true)));
        }
        let args = node.get("args")?.as_array()?;
        args.iter()
            .map(|a| self.presence_operand(a))
            .collect::<Option<Vec<_>>>()
            .map(Operand::Coalesce)
    }
}

fn has_fraction(node: &Value) -> bool {
    match node.get("value") {
        Some(Value::Number(n)) => n.as_i64().is_none(),
        Some(_) => false,
        None => node
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(|args| args.iter().any(has_fraction)),
    }
}

/// The object-level `validator.*` rules of a create body. A rule that names a member the
/// body does not carry, an array, or a pair with no sound comparison is skipped whole.
fn cross_rules(tree: &Tree, obj: NodeId, fields: &[FieldPlan]) -> Vec<CrossRule> {
    let in_body = |at: usize| fields[at].create != Presence::Absent && !fields[at].array;
    let lower = Lowering {
        fields,
        in_body: &in_body,
    };
    let mut rules = Vec::new();
    for &v in tree.children(obj).iter() {
        let n = tree.node(v);
        if n.type_name != TYPE_VALIDATOR {
            continue;
        }
        let named = |attr: &str| str_attr(tree, v, attr).and_then(|name| lower.field(name));
        let gate = || {
            let field = named(ATTR_FIELD)?;
            let when = named(ATTR_WHEN)?;
            let (class, equals) = equals_literal(tree.attr(v, ATTR_EQUALS)?, &fields[when])?;
            Some((field, when, class, equals))
        };
        let set = || {
            let names = names_attr(tree, v, ATTR_FIELDS);
            let found: Vec<usize> = names.iter().filter_map(|name| lower.field(name)).collect();
            (found.len() == names.len() && !found.is_empty()).then_some(found)
        };
        let kind = match n.sub_type.as_str() {
            "comparison" => (|| {
                let (left, right) = (named(ATTR_LEFT)?, named(ATTR_RIGHT)?);
                let op = CmpOp::of(str_attr(tree, v, ATTR_OP)?)?;
                let class = pair_class(&fields[left], &fields[right], op)?;
                Some(CrossKind::Comparison {
                    left,
                    op,
                    right,
                    class,
                })
            })(),
            "requiredWhen" => gate().map(|(field, when, class, equals)| CrossKind::RequiredWhen {
                field,
                when,
                class,
                equals,
            }),
            "presentIff" => gate().map(|(field, when, class, equals)| CrossKind::PresentIff {
                field,
                when,
                class,
                equals,
            }),
            "atLeastOne" => set().map(|fields| CrossKind::AtLeastOne { fields }),
            "exactlyOne" => set().map(|fields| CrossKind::ExactlyOne { fields }),
            _ => None,
        };
        let Some(kind) = kind else { continue };
        let condition = match tree.attr(v, ATTR_CONDITION) {
            None => None,
            Some(node) => match lower.condition(node) {
                Some(c) => Some(c),
                None => continue,
            },
        };
        rules.push(CrossRule {
            name: n.name.clone(),
            kind,
            condition,
        });
    }
    rules
}

/// Tarjan's algorithm: the component number of every node.
fn strongly_connected(adjacency: &[Vec<usize>]) -> Vec<usize> {
    struct State<'a> {
        adjacency: &'a [Vec<usize>],
        index: Vec<Option<usize>>,
        low: Vec<usize>,
        on_stack: Vec<bool>,
        stack: Vec<usize>,
        next: usize,
        component: Vec<usize>,
        components: usize,
    }
    fn connect(s: &mut State<'_>, v: usize) {
        s.index[v] = Some(s.next);
        s.low[v] = s.next;
        s.next += 1;
        s.stack.push(v);
        s.on_stack[v] = true;
        for k in 0..s.adjacency[v].len() {
            let w = s.adjacency[v][k];
            match s.index[w] {
                None => {
                    connect(s, w);
                    s.low[v] = s.low[v].min(s.low[w]);
                }
                Some(wi) if s.on_stack[w] => s.low[v] = s.low[v].min(wi),
                Some(_) => {}
            }
        }
        if Some(s.low[v]) == s.index[v] {
            while let Some(w) = s.stack.pop() {
                s.on_stack[w] = false;
                s.component[w] = s.components;
                if w == v {
                    break;
                }
            }
            s.components += 1;
        }
    }
    let n = adjacency.len();
    let mut s = State {
        adjacency,
        index: vec![None; n],
        low: vec![0; n],
        on_stack: vec![false; n],
        stack: Vec::new(),
        next: 0,
        component: vec![0; n],
        components: 0,
    };
    for v in 0..n {
        if s.index[v].is_none() {
            connect(&mut s, v);
        }
    }
    s.component
}
