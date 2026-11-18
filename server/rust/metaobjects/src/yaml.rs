//! Authoring YAML to the canonical document the JSON parser reads.
//!
//! A front-end, as in every port (the TypeScript `core/parser-yaml.ts` and
//! `core/yaml-desugar.ts` are the reference): parse the text with a YAML 1.2 core
//! schema parser, apply the authoring sugar of ADR-0006, and hand the resulting
//! canonical `{ "<type>.<subType>": { ... } }` document to the same parser that
//! reads JSON. The sugar:
//!
//! 1. a bare `type` key takes the type's default subtype;
//! 2. a scalar body becomes `{ name: <scalar> }`;
//! 3. a trailing `[]` on the key is `isArray: true`;
//! 4. every body key that is not a reserved structural key is an inline attribute
//!    and gets its `@` back (a key already written with `@` is left as it is).
//!
//! It also runs the YAML type-coercion guard: an unquoted `TRUE`, `0x1F` or `~`
//! given to an attribute declared `string` is reported as `ERR_YAML_COERCION`,
//! telling the author to quote it.
//!
//! The parse keeps the line and column of every node's key, so an error raised
//! while building a node can say where in the file it came from. Positions live
//! in a side table keyed by the node's canonical JSON path, so the canonical
//! document stays a plain `serde_json::Value`.

use std::borrow::Cow;
use std::collections::HashMap;

use saphyr::{LoadableYamlNode, MarkedYaml, Scalar, YamlData};
use serde_json::{Map, Number, Value};

use crate::errors::{ERR_MALFORMED_YAML, ERR_YAML_COERCION, MetaError};
use crate::json::js_display;
use crate::parser::{
    ATTR_PREFIX, ATTR_SUBTYPE_INT, ATTR_SUBTYPE_LONG, ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY, FUSED_KEY_SEP, KEY_CHILDREN, KEY_IS_ARRAY, KEY_NAME,
    RESERVED_STRUCTURAL_KEYS,
};
use crate::registry::TypeRegistry;
use crate::source::{ErrorSource, JsonPath, YamlPosition};

const ARRAY_SUFFIX: &str = "[]";
const ATTR_SUBTYPE_CLASS: &str = "class";
const ATTR_SUBTYPE_DOUBLE: &str = "double";
const ATTR_SUBTYPE_BOOLEAN: &str = "boolean";

/// The position of each node's wrapper key, by the node's canonical JSON path.
pub type Positions = HashMap<String, YamlPosition>;

/// One YAML document, desugared.
#[derive(Debug)]
pub struct Desugared {
    /// The canonical document, ready for [`crate::parser::parse_document_with`].
    pub canonical: Value,
    pub positions: Positions,
    /// Problems the desugar collected without stopping: coercions, malformed
    /// nodes. They precede the parser's own errors, as in every port.
    pub errors: Vec<MetaError>,
}

fn yaml_envelope(file: &str) -> ErrorSource {
    ErrorSource::yaml(file, "$", None)
}

/// Parse and desugar one YAML document. An `Err` is a document that could not be
/// read at all: a syntax error, more than one document, or nothing usable.
pub fn parse_yaml(text: &str, registry: &TypeRegistry, file: &str) -> Result<Desugared, MetaError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let malformed = |message: String| {
        MetaError::at(
            ERR_MALFORMED_YAML,
            format!("Invalid YAML: {message}"),
            yaml_envelope(file),
        )
    };
    let docs = MarkedYaml::load_from_str(text).map_err(|e| malformed(e.to_string()))?;
    if docs.len() > 1 {
        return Err(malformed(
            "Source contains multiple documents. Please use YAML.parseAllDocuments()".into(),
        ));
    }
    let mut d = Desugar {
        registry,
        file,
        errors: Vec::new(),
        positions: Positions::new(),
    };
    let node = d.node(docs.first(), &JsonPath::root(), "<root>");
    let Some(canonical) = node else {
        // Nothing usable: the first problem is the error, as the other ports throw it.
        let first = d.errors.into_iter().next().unwrap_or_else(|| {
            MetaError::at(ERR_MALFORMED_YAML, "empty document", yaml_envelope(file))
        });
        return Err(first);
    };
    Ok(Desugared {
        canonical,
        positions: d.positions,
        errors: d.errors,
    })
}

struct Desugar<'a> {
    registry: &'a TypeRegistry,
    file: &'a str,
    errors: Vec<MetaError>,
    positions: Positions,
}

/// The text a mapping key reads as: a scalar's JavaScript `String(...)` form.
fn key_text(key: &MarkedYaml<'_>) -> Option<String> {
    match &unwrap_tag(key).data {
        YamlData::Value(s) => Some(js_display(&scalar_value(s))),
        YamlData::Representation(text, ..) => Some(text.to_string()),
        _ => None,
    }
}

fn unwrap_tag<'a, 'i>(node: &'a MarkedYaml<'i>) -> &'a MarkedYaml<'i> {
    let mut n = node;
    while let YamlData::Tagged(_, inner) = &n.data {
        n = inner;
    }
    n
}

fn scalar_value(s: &Scalar<'_>) -> Value {
    match s {
        Scalar::Null => Value::Null,
        Scalar::Boolean(b) => Value::Bool(*b),
        Scalar::Integer(i) => Value::Number((*i).into()),
        // JavaScript has one number type, and JSON has no NaN or Infinity.
        Scalar::FloatingPoint(f) => Number::from_f64(f.0).map_or(Value::Null, Value::Number),
        Scalar::String(s) => Value::String(s.to_string()),
    }
}

fn position(node: &MarkedYaml<'_>) -> YamlPosition {
    let start = node.span.start;
    YamlPosition {
        line: u32::try_from(start.line()).unwrap_or(u32::MAX),
        // The parser counts columns from 0; the envelope from 1.
        col: u32::try_from(start.col() + 1).unwrap_or(u32::MAX),
    }
}

/// A YAML node as plain data. A mapping key that is not a scalar is dropped, as
/// the other ports drop it: the authoring grammar has only string keys.
fn to_value(node: &MarkedYaml<'_>) -> Value {
    match &unwrap_tag(node).data {
        YamlData::Value(s) => scalar_value(s),
        YamlData::Representation(text, ..) => Value::String(text.to_string()),
        YamlData::Sequence(items) => Value::Array(items.iter().map(to_value).collect()),
        YamlData::Mapping(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                if let Some(key) = key_text(k) {
                    out.insert(key, to_value(v));
                }
            }
            Value::Object(out)
        }
        _ => Value::Null,
    }
}

/// A mapping's entries with a usable key, in document order.
fn entries<'a, 'i>(
    node: &'a MarkedYaml<'i>,
) -> Option<Vec<(String, &'a MarkedYaml<'i>, &'a MarkedYaml<'i>)>> {
    match &unwrap_tag(node).data {
        YamlData::Mapping(map) => Some(
            map.iter()
                .filter_map(|(k, v)| key_text(k).map(|text| (text, k, v)))
                .collect(),
        ),
        _ => None,
    }
}

impl Desugar<'_> {
    fn error(&mut self, code: &'static str, message: String) {
        self.errors
            .push(MetaError::at(code, message, yaml_envelope(self.file)));
    }

    fn malformed(&mut self, message: String) {
        self.error(ERR_MALFORMED_YAML, message);
    }

    /// One node: a single-key mapping `{ "type.subType": body }`. `parent_path` is
    /// the canonical JSON path the wrapper sits under; `at` names the node in
    /// messages.
    fn node(
        &mut self,
        input: Option<&MarkedYaml<'_>>,
        parent_path: &JsonPath,
        at: &str,
    ) -> Option<Value> {
        let Some(map) = input.and_then(entries) else {
            self.malformed(format!("Node at {at} must be a mapping with one type key"));
            return None;
        };
        if map.len() != 1 {
            let found = if map.is_empty() {
                "none".to_string()
            } else {
                map.iter()
                    .map(|(k, ..)| k.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            self.malformed(format!(
                "Node at {at} must have exactly one type key (found: {found})"
            ));
            return None;
        }
        let (raw_key, key_node, raw_body) = &map[0];

        // Sugar 3: a trailing `[]` on the key is `isArray`.
        let (key, is_array) = match raw_key.strip_suffix(ARRAY_SUFFIX) {
            Some(stripped) => (stripped, true),
            None => (raw_key.as_str(), false),
        };
        // Sugar 1: a bare `type` key takes the type's default subtype.
        let canonical_key = self.resolve_key(key, at);
        let path = parent_path.key(&canonical_key);
        self.positions
            .insert(path.as_str().to_string(), position(key_node));

        let mut body = self.body(raw_body, &canonical_key, &path, at);
        if is_array {
            body.insert(KEY_IS_ARRAY.to_string(), Value::Bool(true));
        }
        let mut wrapper = Map::new();
        wrapper.insert(canonical_key, Value::Object(body));
        Some(Value::Object(wrapper))
    }

    fn resolve_key(&mut self, key: &str, at: &str) -> String {
        if key.contains(FUSED_KEY_SEP) {
            return key.to_string();
        }
        match self.registry.default_sub_type_of(key) {
            Some(sub) => format!("{key}{FUSED_KEY_SEP}{sub}"),
            None => {
                self.malformed(format!(
                    "Cannot resolve subType for bare type key '{key}' at {at} — type '{key}' has no default subType; write the full 'type.subType'"
                ));
                key.to_string()
            }
        }
    }

    /// Sugars 2 and 4 plus the coercion guard: a node body as a canonical mapping.
    fn body(
        &mut self,
        raw: &MarkedYaml<'_>,
        canonical_key: &str,
        path: &JsonPath,
        at: &str,
    ) -> Map<String, Value> {
        let raw = unwrap_tag(raw);
        match &raw.data {
            YamlData::Value(Scalar::Null) => return Map::new(),
            YamlData::Value(s) if !matches!(s, Scalar::Null) => {
                // A scalar body is the node's name.
                let mut out = Map::new();
                out.insert(KEY_NAME.to_string(), scalar_value(s));
                return out;
            }
            YamlData::Representation(text, ..) => {
                let mut out = Map::new();
                out.insert(KEY_NAME.to_string(), Value::String(text.to_string()));
                return out;
            }
            YamlData::Sequence(_) => {
                self.malformed(format!(
                    "Node body at {at} must be a scalar or mapping, not a list"
                ));
                return Map::new();
            }
            _ => {}
        }
        let Some(map) = entries(raw) else {
            return Map::new();
        };
        let schema = canonical_key
            .split_once(FUSED_KEY_SEP)
            .and_then(|(t, s)| self.registry.find(t, s));
        let mut out = Map::new();
        let mut children: Option<usize> = None;
        for (key, _, value) in &map {
            let (out_key, attr_name): (Cow<'_, str>, Option<&str>) =
                if RESERVED_STRUCTURAL_KEYS.contains(&key.as_str()) {
                    (Cow::Borrowed(key), None)
                } else if let Some(name) = key.strip_prefix(ATTR_PREFIX) {
                    (Cow::Borrowed(key), Some(name))
                } else {
                    (Cow::Owned(format!("{ATTR_PREFIX}{key}")), Some(key))
                };
            if key == KEY_CHILDREN {
                // Children are desugared in place, below, so their positions are known.
                children = Some(out.len());
                out.insert(KEY_CHILDREN.to_string(), Value::Null);
                continue;
            }
            let value = to_value(value);
            if let Some(name) = attr_name
                && !name.is_empty()
                && !RESERVED_STRUCTURAL_KEYS.contains(&name)
                && let Some(def) = schema
                && let Some(spec) = def.attr(name)
            {
                let value_type = if spec.is_array == Some(true) {
                    Some(ATTR_SUBTYPE_STRINGARRAY)
                } else {
                    spec.value_type.as_deref()
                };
                if let Some(value_type) = value_type {
                    self.check_coercion(name, &value, value_type, at);
                }
            }
            out.insert(out_key.into_owned(), value);
        }
        if children.is_some()
            && let Some((_, _, seq)) = map.iter().find(|(k, ..)| k == KEY_CHILDREN)
        {
            let seq = unwrap_tag(seq);
            if let YamlData::Sequence(items) = &seq.data {
                let children_path = path.key(KEY_CHILDREN);
                let mut built = Vec::with_capacity(items.len());
                for (i, item) in items.iter().enumerate() {
                    let child_at = format!("{at}.{KEY_CHILDREN}[{i}]");
                    // A child that could not be read is dropped, as in every port;
                    // the problem is already collected.
                    if let Some(child) =
                        self.node(Some(item), &children_path.index(built.len()), &child_at)
                    {
                        built.push(child);
                    }
                }
                out.insert(KEY_CHILDREN.to_string(), Value::Array(built));
            } else {
                // A non-list `children` is left as written; the parser reports it.
                out.insert(KEY_CHILDREN.to_string(), to_value(seq));
            }
        }
        out
    }

    /// The coercion guard for one inline attribute: YAML read an unquoted value as
    /// a boolean, number or null where the schema declares something else.
    fn check_coercion(&mut self, name: &str, raw: &Value, value_type: &str, at: &str) {
        let mismatch = |expected: &str| Some((name.to_string(), raw.clone(), expected.to_string()));
        let found = match value_type {
            ATTR_SUBTYPE_STRING | ATTR_SUBTYPE_CLASS => {
                (!raw.is_string()).then(|| mismatch("string")).flatten()
            }
            ATTR_SUBTYPE_BOOLEAN => (!raw.is_boolean()).then(|| mismatch("boolean")).flatten(),
            ATTR_SUBTYPE_INT | ATTR_SUBTYPE_LONG | ATTR_SUBTYPE_DOUBLE => {
                (!raw.is_number()).then(|| mismatch("number")).flatten()
            }
            ATTR_SUBTYPE_STRINGARRAY => match raw {
                // A bare string is the one-element shorthand, not a coercion.
                Value::String(_) => None,
                Value::Array(items) => {
                    let bad = items.iter().position(|v| !v.is_string());
                    bad.map(|i| {
                        (
                            format!("{name}[{i}]"),
                            items[i].clone(),
                            "string (in string-array)".to_string(),
                        )
                    })
                }
                _ => mismatch("string-array (or single string)"),
            },
            // Object-shaped attributes accept any object or array.
            _ => None,
        };
        let Some((label, value, expected)) = found else {
            return;
        };
        let literal = match &value {
            Value::Null => "null".to_string(),
            Value::Object(_) | Value::Array(_) => value.to_string(),
            other => js_display(other),
        };
        self.error(
            ERR_YAML_COERCION,
            format!(
                "Attribute '@{label}' at {at}: expected {expected} but got {} ({literal}). YAML 1.2 silently coerced an unquoted value — quote it in YAML: '@{label}: \"{literal}\"' not '@{label}: {literal}'.",
                coerced_type_name(&value)
            ),
        );
    }
}

fn coerced_type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}
