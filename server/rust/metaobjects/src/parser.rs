//! One JSON document to a subtree of the [`Tree`].
//!
//! Follows the shared parser contract every port implements (the TypeScript
//! `parser-core.ts` is the reference): a node is a one-key map
//! `{ "<type>.<subType>": <body> }`; the KEY is judged before the BODY; reserved
//! structural keys may not be written with `@`; inline `@attrs` are coerced by the
//! registered attr schema; `attr.<sub>` children are attributes, not children.

use serde_json::{Map, Value};

use crate::errors::{
    ERR_ABSTRACT_SUBTYPE_AUTHORED, ERR_BAD_ATTR_VALUE, ERR_CHILD_NOT_OBJECT,
    ERR_MISSING_REQUIRED_ATTR, ERR_MISSING_SUBTYPE, ERR_RESERVED_ATTR, ERR_TOP_LEVEL_NOT_OBJECT,
    ERR_UNKNOWN_SUBTYPE, ERR_UNKNOWN_TYPE, ERR_UNRESOLVED_SUPER, MetaError,
};
use crate::json::{js_number, safe_whole_i64};
use crate::node::{Attr, Node, NodeId, PACKAGE_SEP, Tree};
use crate::registry::{SUBTYPE_BASE, TypeRegistry};
use crate::source::{ErrorSource, JsonPath};

pub const TYPE_METADATA: &str = "metadata";
pub const SUBTYPE_ROOT: &str = "root";
pub const TYPE_ATTR: &str = "attr";
pub const TYPE_FIELD: &str = "field";
pub const TYPE_OBJECT: &str = "object";

pub const KEY_NAME: &str = "name";
pub const KEY_PACKAGE: &str = "package";
pub const KEY_EXTENDS: &str = "extends";
pub const KEY_ABSTRACT: &str = "abstract";
pub const KEY_OVERLAY: &str = "overlay";
pub const KEY_IS_ARRAY: &str = "isArray";
pub const KEY_CHILDREN: &str = "children";
pub const KEY_VALUE: &str = "value";
/// The editor-schema key a document may carry beside its wrapper key.
pub const KEY_SCHEMA: &str = "$schema";

pub const ATTR_PREFIX: &str = "@";
pub const FUSED_KEY_SEP: char = '.';

/// Attr subtypes the loader coerces or desugars.
pub const ATTR_SUBTYPE_STRING: &str = "string";
pub const ATTR_SUBTYPE_INT: &str = "int";
pub const ATTR_SUBTYPE_LONG: &str = "long";
pub const ATTR_SUBTYPE_FILTER: &str = "filter";
pub const ATTR_SUBTYPE_PROPERTIES: &str = "properties";
/// Not a registered subtype: the coercion an array-valued string attr gets
/// (a bare string becomes a one-element list).
pub const ATTR_SUBTYPE_STRINGARRAY: &str = "stringarray";

const RESERVED_STRUCTURAL_KEYS: &[&str] = &[
    KEY_NAME,
    KEY_PACKAGE,
    KEY_EXTENDS,
    KEY_ABSTRACT,
    KEY_OVERLAY,
    KEY_IS_ARRAY,
    KEY_CHILDREN,
    KEY_VALUE,
];

/// What one document produced.
pub struct Parsed {
    pub root: Option<NodeId>,
    pub errors: Vec<MetaError>,
}

struct Ctx<'a> {
    tree: &'a mut Tree,
    registry: &'a TypeRegistry,
    file: &'a str,
    errors: Vec<MetaError>,
}

impl Ctx<'_> {
    fn here(&self, path: &JsonPath) -> ErrorSource {
        if self.file.is_empty() {
            ErrorSource::Code
        } else {
            ErrorSource::json(self.file, path.as_str())
        }
    }

    fn error(&mut self, code: &'static str, message: String, path: &JsonPath) {
        let source = self.here(path);
        self.errors.push(MetaError::at(code, message, source));
    }
}

/// Parse one document into `tree`. `file` names it in error envelopes.
pub fn parse_document(doc: &Value, registry: &TypeRegistry, tree: &mut Tree, file: &str) -> Parsed {
    let mut ctx = Ctx {
        tree,
        registry,
        file,
        errors: Vec::new(),
    };
    let root_path = JsonPath::root();
    let Some(map) = doc.as_object() else {
        ctx.error(
            ERR_TOP_LEVEL_NOT_OBJECT,
            "top-level is not an object".into(),
            &root_path,
        );
        return Parsed {
            root: None,
            errors: ctx.errors,
        };
    };
    // `$schema` sits beside the wrapper key for editors; it is not a wrapper.
    let wrappers: Vec<(&String, &Value)> = map.iter().filter(|(k, _)| *k != KEY_SCHEMA).collect();
    if wrappers.len() != 1 {
        let message = if wrappers.is_empty() {
            "Top-level metadata object has no type wrapper key".to_string()
        } else {
            let keys: Vec<&str> = wrappers.iter().map(|(k, _)| k.as_str()).collect();
            format!(
                "Top-level metadata object must have exactly one wrapper key (found: {})",
                keys.join(", ")
            )
        };
        ctx.error(ERR_TOP_LEVEL_NOT_OBJECT, message, &root_path);
        return Parsed {
            root: None,
            errors: ctx.errors,
        };
    }
    let (wrapper, body) = wrappers[0];
    let path = root_path.key(wrapper);
    let root = build(&mut ctx, wrapper, body, &path, &Scope::root());
    Parsed {
        root,
        errors: ctx.errors,
    }
}

/// The JSON kind of a value, in the words a metadata author reads.
fn describe_json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "a boolean",
        Value::String(_) => "a string",
        Value::Number(_) => "a number",
        Value::Array(_) => "an array",
        Value::Object(_) => "an object",
    }
}

fn missing_subtype_message(type_name: &str) -> String {
    format!("type '{type_name}' has no default subType; write the full '{type_name}.<subType>'")
}

fn abstract_subtype_message(type_name: &str) -> String {
    format!(
        "'{type_name}.{SUBTYPE_BASE}' may not be authored — every '{SUBTYPE_BASE}' subtype is an abstract registry anchor that concrete subtypes inherit from, with no runtime semantics of its own. Declare a concrete {type_name} subtype instead."
    )
}

fn child_not_object_message(wrapper: &str, body: &Value) -> String {
    format!(
        "child wrapper '{wrapper}' must contain an object — a child is one {{ \"<type>.<subType>\": {{ …node body… }} }} pair, and this one holds {}. Give it a node body, or remove the entry.",
        describe_json_kind(body)
    )
}

/// Is `<type>.base` an abstract anchor here: does the type register another subtype?
fn is_abstract_anchor_for(registry: &TypeRegistry, type_name: &str) -> bool {
    registry
        .all_sub_types_of(type_name)
        .iter()
        .any(|s| s != SUBTYPE_BASE)
}

/// Expand a `::`-relative package against the declaring file's context package.
pub fn expand_package_for_path(base_pkg: &str, pkg_path: &str) -> String {
    if base_pkg.trim().is_empty() || !pkg_path.starts_with(PACKAGE_SEP) {
        pkg_path.to_string()
    } else {
        format!("{base_pkg}{pkg_path}")
    }
}

/// The package context a node is built in.
struct Scope {
    ctx_pkg: String,
    parent_type: String,
    is_root: bool,
}

impl Scope {
    fn root() -> Self {
        Self {
            ctx_pkg: String::new(),
            parent_type: String::new(),
            is_root: true,
        }
    }
}

fn split_wrapper(wrapper: &str) -> (&str, &str) {
    match wrapper.split_once(FUSED_KEY_SEP) {
        Some((t, s)) => (t, s),
        None => (wrapper, ""),
    }
}

fn build(
    ctx: &mut Ctx<'_>,
    wrapper: &str,
    body: &Value,
    path: &JsonPath,
    scope: &Scope,
) -> Option<NodeId> {
    let (type_name, authored_sub) = split_wrapper(wrapper);
    let registry = ctx.registry;
    let sub_type = if authored_sub.is_empty() {
        registry
            .default_sub_type_of(type_name)
            .unwrap_or("")
            .to_string()
    } else {
        authored_sub.to_string()
    };
    if sub_type.is_empty() && registry.has_type(type_name) {
        ctx.error(
            ERR_MISSING_SUBTYPE,
            missing_subtype_message(type_name),
            path,
        );
        return None;
    }
    if sub_type == SUBTYPE_BASE && is_abstract_anchor_for(registry, type_name) {
        ctx.error(
            ERR_ABSTRACT_SUBTYPE_AUTHORED,
            abstract_subtype_message(type_name),
            path,
        );
        return None;
    }
    if !registry.has_type(type_name) {
        ctx.error(
            ERR_UNKNOWN_TYPE,
            format!("unknown type '{type_name}'"),
            path,
        );
        return None;
    }
    let Some(def) = registry.find(type_name, &sub_type) else {
        ctx.error(
            ERR_UNKNOWN_SUBTYPE,
            format!("unknown subType '{type_name}.{sub_type}'"),
            path,
        );
        return None;
    };
    let Some(body) = body.as_object() else {
        if scope.is_root {
            ctx.error(
                ERR_TOP_LEVEL_NOT_OBJECT,
                format!(
                    "top-level wrapper '{wrapper}' must contain an object, and holds {}",
                    describe_json_kind(body)
                ),
                path,
            );
        } else {
            ctx.error(
                ERR_CHILD_NOT_OBJECT,
                child_not_object_message(wrapper, body),
                path,
            );
        }
        return None;
    };

    let mut name = match body.get(KEY_NAME) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => js_display(other),
    };
    if name.is_empty()
        && def.max_occurs == Some(1)
        && let Some(default_name) = &def.default_name
    {
        name = default_name.clone();
    }
    let mut node = Node::new(type_name, &sub_type, &name);
    node.source = ctx.here(path);

    let pkg = match body.get(KEY_PACKAGE) {
        Some(Value::String(p)) => Some(expand_package_for_path(&scope.ctx_pkg, p)),
        None => None,
        Some(_) => {
            ctx.error(
                ERR_BAD_ATTR_VALUE,
                format!("\"{KEY_PACKAGE}\" must be a string at {}", path.as_str()),
                path,
            );
            None
        }
    };
    let pkg = pkg.filter(|p| !p.is_empty());
    node.file_default_package = Some(pkg.clone().unwrap_or_else(|| scope.ctx_pkg.clone()));
    if let Some(p) = &pkg {
        node.package = Some(p.clone());
    } else if type_name == TYPE_FIELD
        && scope.parent_type != TYPE_OBJECT
        && !scope.ctx_pkg.is_empty()
    {
        // A field outside any object (an abstract field at the root, say) takes
        // the context package, as every port does.
        node.package = Some(scope.ctx_pkg.clone());
    }
    // The structural keys take exact JSON types, as in every port: a string
    // `extends` and `package`, a boolean `abstract` and `isArray`, and only a
    // literal `true` makes an overlay.
    match body.get(KEY_EXTENDS) {
        None => {}
        Some(Value::String(ext)) => {
            if !ext.is_empty() {
                node.super_ref = Some(ext.clone());
            }
        }
        Some(_) => ctx.error(
            ERR_UNRESOLVED_SUPER,
            format!("\"{KEY_EXTENDS}\" must be a string at {}", path.as_str()),
            path,
        ),
    }
    node.is_abstract = structural_bool(ctx, body, KEY_ABSTRACT, path);
    node.is_array = structural_bool(ctx, body, KEY_IS_ARRAY, path);
    node.is_overlay = body.get(KEY_OVERLAY) == Some(&Value::Bool(true));
    let is_overlay = node.is_overlay;
    let own_pkg = node.package.clone();
    let id = ctx.tree.add(node);

    for (key, value) in body {
        let Some(attr_name) = key.strip_prefix(ATTR_PREFIX) else {
            continue;
        };
        if RESERVED_STRUCTURAL_KEYS.contains(&attr_name) {
            ctx.error(
                ERR_RESERVED_ATTR,
                format!(
                    "node '{wrapper}' uses reserved structural key '{attr_name}' with @-prefix; bare '{attr_name}' is the canonical form"
                ),
                path,
            );
            continue;
        }
        let schema = def
            .attr(attr_name)
            .or_else(|| registry.common_attr(attr_name));
        let attr_sub = match schema {
            Some(s) if s.is_array == Some(true) => ATTR_SUBTYPE_STRINGARRAY.to_string(),
            Some(s) => s
                .value_type
                .clone()
                .unwrap_or_else(|| SUBTYPE_BASE.to_string()),
            None if value.is_object() => ATTR_SUBTYPE_PROPERTIES.to_string(),
            None => SUBTYPE_BASE.to_string(),
        };
        let source = ctx.here(&path.key(key));
        let attr = make_attr(&attr_sub, value, source);
        ctx.tree.set_attr(id, attr_name, attr);
    }

    let child_ctx_pkg = if is_overlay && !scope.is_root {
        scope.ctx_pkg.clone()
    } else {
        own_pkg.unwrap_or_else(|| scope.ctx_pkg.clone())
    };
    let entries = match body.get(KEY_CHILDREN) {
        None => &[][..],
        Some(Value::Array(entries)) => entries.as_slice(),
        Some(_) => {
            ctx.error(
                ERR_TOP_LEVEL_NOT_OBJECT,
                format!("\"{KEY_CHILDREN}\" must be an array at {}", path.as_str()),
                path,
            );
            &[][..]
        }
    };
    {
        let children_path = path.key(KEY_CHILDREN);
        for (i, entry) in entries.iter().enumerate() {
            let entry_path = children_path.index(i);
            let Some(entry) = entry.as_object() else {
                ctx.error(
                    ERR_TOP_LEVEL_NOT_OBJECT,
                    format!("Child at {} must be an object", entry_path.as_str()),
                    &entry_path,
                );
                continue;
            };
            if entry.len() != 1 {
                let message = if entry.is_empty() {
                    format!("Child at {} has no type wrapper key", entry_path.as_str())
                } else {
                    let keys: Vec<&str> = entry.keys().map(String::as_str).collect();
                    format!(
                        "Child at {} has multiple keys ({}) — each child must have exactly one wrapper key",
                        entry_path.as_str(),
                        keys.join(", ")
                    )
                };
                ctx.error(ERR_TOP_LEVEL_NOT_OBJECT, message, &entry_path);
                continue;
            }
            let (cw, cbody) = entry.iter().next().expect("one entry");
            let cpath = entry_path.key(cw);
            let (ctype, csub) = split_wrapper(cw);
            if ctype == TYPE_ATTR {
                parse_attr_child(ctx, id, cw, csub, cbody, &cpath);
            } else {
                let child_scope = Scope {
                    ctx_pkg: child_ctx_pkg.clone(),
                    parent_type: type_name.to_string(),
                    is_root: false,
                };
                if let Some(child) = build(ctx, cw, cbody, &cpath, &child_scope) {
                    add_or_merge_child(ctx.tree, id, child);
                }
            }
        }
    }
    Some(id)
}

fn parse_attr_child(
    ctx: &mut Ctx<'_>,
    parent: NodeId,
    wrapper: &str,
    sub: &str,
    body: &Value,
    path: &JsonPath,
) {
    let registry = ctx.registry;
    let sub_type = if sub.is_empty() {
        registry
            .default_sub_type_of(TYPE_ATTR)
            .unwrap_or("")
            .to_string()
    } else {
        sub.to_string()
    };
    if sub_type.is_empty() {
        ctx.error(
            ERR_MISSING_SUBTYPE,
            missing_subtype_message(TYPE_ATTR),
            path,
        );
        return;
    }
    if sub_type == SUBTYPE_BASE && is_abstract_anchor_for(registry, TYPE_ATTR) {
        ctx.error(
            ERR_ABSTRACT_SUBTYPE_AUTHORED,
            abstract_subtype_message(TYPE_ATTR),
            path,
        );
        return;
    }
    let Some(body) = body.as_object() else {
        ctx.error(
            ERR_CHILD_NOT_OBJECT,
            child_not_object_message(wrapper, body),
            path,
        );
        return;
    };
    let name = match body.get(KEY_NAME) {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => {
            ctx.error(
                ERR_MISSING_REQUIRED_ATTR,
                "attr child requires a non-empty 'name'".into(),
                path,
            );
            return;
        }
    };
    let raw = body.get(KEY_VALUE).cloned().unwrap_or(Value::Null);
    let resolved = if registry.has(TYPE_ATTR, &sub_type) {
        sub_type
    } else {
        SUBTYPE_BASE.to_string()
    };
    let source = ctx.here(path);
    let attr = make_attr(&resolved, &raw, source);
    ctx.tree.set_attr(parent, &name, attr);
}

/// A boolean structural key (`abstract`, `isArray`): absent is false, and any
/// other JSON type is `ERR_BAD_ATTR_VALUE`.
fn structural_bool(
    ctx: &mut Ctx<'_>,
    body: &Map<String, Value>,
    key: &str,
    path: &JsonPath,
) -> bool {
    match body.get(key) {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            ctx.error(
                ERR_BAD_ATTR_VALUE,
                format!("\"{key}\" must be a boolean at {}", path.as_str()),
                path,
            );
            false
        }
    }
}

/// Add `child` under `parent`, or fold it into a same-type, same-name sibling the
/// same document already declared (every port merges those during the parse).
/// Unnamed nodes are always distinct, and overlays stay as written for the
/// loader's deferred pass (ADR-0055).
fn add_or_merge_child(tree: &mut Tree, parent: NodeId, child: NodeId) {
    let c = tree.node(child);
    if c.name.is_empty() || c.is_overlay {
        tree.add_child(parent, child);
        return;
    }
    // ADR-0039: own — the merge works on the authored layer, before super resolution.
    let existing = tree.own_children(parent).iter().copied().find(|&s| {
        let n = tree.node(s);
        !n.is_overlay && n.type_name == c.type_name && n.name == c.name
    });
    let Some(existing) = existing else {
        tree.add_child(parent, child);
        return;
    };
    // ADR-0039: own — copying the declared layer, last writer wins.
    let attrs: Vec<_> = tree
        .own_attrs(child)
        .map(|(k, a)| (k.clone(), a.clone()))
        .collect();
    for (k, a) in attrs {
        tree.set_attr(existing, &k, a);
    }
    // ADR-0039: own — moving the declared children.
    for grandchild in tree.own_children(child).to_vec() {
        add_or_merge_child(tree, existing, grandchild);
    }
}

/// `String(v)` for a scalar; compact JSON for anything else.
fn js_display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number(n),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// Build an attribute of `sub_type` from an authored value: coerce, then desugar.
pub fn make_attr(sub_type: &str, raw: &Value, source: ErrorSource) -> Attr {
    Attr {
        sub_type: sub_type.to_string(),
        value: desugar(sub_type, coerce(sub_type, raw)),
        authored_value: None,
        source,
    }
}

fn coerce(sub_type: &str, raw: &Value) -> Value {
    match sub_type {
        ATTR_SUBTYPE_STRING => match raw {
            Value::Bool(_) | Value::Number(_) => Value::String(js_display(raw)),
            _ => raw.clone(),
        },
        ATTR_SUBTYPE_INT | ATTR_SUBTYPE_LONG => match raw {
            Value::Number(n) if n.as_i64().is_none() && n.as_u64().is_none() => {
                match n.as_f64().and_then(safe_whole_i64) {
                    Some(i) => Value::from(i),
                    None => raw.clone(),
                }
            }
            _ => raw.clone(),
        },
        ATTR_SUBTYPE_STRINGARRAY => match raw {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|el| Value::String(js_display(el)))
                    .collect(),
            ),
            Value::String(_) => Value::Array(vec![raw.clone()]),
            _ => raw.clone(),
        },
        _ => raw.clone(),
    }
}

fn desugar(sub_type: &str, value: Value) -> Value {
    if sub_type != ATTR_SUBTYPE_FILTER {
        return value;
    }
    match value {
        Value::Object(map) => Value::Object(desugar_filter_object(map)),
        other => other,
    }
}

const FILTER_OP_EQ: &str = "eq";
const FILTER_OP_IN: &str = "in";
const FILTER_OP_IS_NULL: &str = "isNull";
const FILTER_COMPOSE_AND: &str = "and";
const FILTER_COMPOSE_OR: &str = "or";
const FILTER_RELATIVE_NOW: &str = "now";

fn desugar_filter_object(map: Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, raw) in map {
        if key == FILTER_COMPOSE_AND || key == FILTER_COMPOSE_OR {
            let v = match raw {
                Value::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .map(|sub| match sub {
                            Value::Object(m) => Value::Object(desugar_filter_object(m)),
                            other => other,
                        })
                        .collect(),
                ),
                other => other,
            };
            out.insert(key, v);
            continue;
        }
        out.insert(key, desugar_filter_value(raw));
    }
    out
}

fn one(key: &str, v: Value) -> Value {
    let mut m = Map::new();
    m.insert(key.to_string(), v);
    Value::Object(m)
}

fn desugar_filter_value(value: Value) -> Value {
    match value {
        Value::Null => one(FILTER_OP_IS_NULL, Value::Bool(true)),
        Value::Array(_) => one(FILTER_OP_IN, value),
        Value::Object(ref m) if m.contains_key(FILTER_RELATIVE_NOW) => one(FILTER_OP_EQ, value),
        Value::Object(_) => value,
        other => one(FILTER_OP_EQ, other),
    }
}
