//! The inbound half of a prompt, read from the model once for every generator that needs it
//! (ADR-0052, ADR-0053).
//!
//! A template subtype's axis is direction: a `template.output` renders outbound and parses
//! nothing; a `template.prompt` that declares `@responseRef` names the value object its reply
//! is read into. [`inbound_templates`] is that rule, in one place, so no generator re-derives
//! "which templates have a response". The reply's syntax is `@responseFormat` (`json`, the
//! default, or `xml`), never `@format`, which is the syntax of the prompt's own body.
//!
//! [`extract_schema`] and [`output_format_spec`] derive, from the response value object,
//! the descriptors the reply parser and the output-format fragment run on, as the
//! `metaobjects-render` crate's own types: the derivation the other ports' runtime extract
//! makes, so a generated parser reads a reply as every port reads it.

use std::collections::{HashMap, HashSet};

use metaobjects::node::{NodeId, Tree};
use metaobjects::validate::util::ObjectIndex;
use metaobjects_render::extract::{ExtractSchema, FieldKind, FieldSpec, Format, normalize};
use metaobjects_render::prompt::{OutputFormatSpec, PromptField, PromptStyle};
use serde_json::Value;

const TYPE_TEMPLATE: &str = "template";
const TYPE_OBJECT: &str = "object";
const TYPE_FIELD: &str = "field";
const TYPE_VALIDATOR: &str = "validator";
const TEMPLATE_PROMPT: &str = "prompt";
const VALIDATOR_NUMERIC: &str = "numeric";
const VALIDATOR_ARRAY: &str = "array";
const ATTR_RESPONSE_REF: &str = "responseRef";
const ATTR_RESPONSE_FORMAT: &str = "responseFormat";
const ATTR_PROMPT_STYLE: &str = "promptStyle";
const ATTR_OBJECT_REF: &str = "objectRef";
const ATTR_REQUIRED: &str = "required";
const ATTR_VALUES: &str = "values";
const ATTR_ENUM_ALIAS: &str = "enumAlias";
const ATTR_ENUM_DOC: &str = "enumDoc";
const ATTR_COERCE_DEFAULT: &str = "coerceDefault";
const ATTR_DEFAULT: &str = "default";
const ATTR_NORMALIZE: &str = "normalize";
const ATTR_XML_TEXT: &str = "xmlText";
const ATTR_EXAMPLE: &str = "example";
const ATTR_INSTRUCTION: &str = "instruction";
const ATTR_MIN: &str = "min";
const ATTR_MAX: &str = "max";
const FORMAT_XML: &str = "xml";

/// How deep a reply's nested objects are read; past it a member is opaque text. Every port
/// stops at the same depth.
pub const MAX_NEST_DEPTH: usize = 8;

/// Every concrete `template.prompt` at the root that declares a response shape, by name.
/// The gate is `@responseRef` being there (resolved through `extends`), never a format.
#[must_use]
pub fn inbound_templates(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    // ADR-0039 own: the root's top-level nodes are its declared children; a root extends
    // nothing, so own and effective agree.
    let mut out: Vec<NodeId> = tree
        .own_children(root)
        .iter()
        .copied()
        .filter(|&c| {
            let n = tree.node(c);
            n.type_name == TYPE_TEMPLATE
                && n.sub_type == TEMPLATE_PROMPT
                && !n.is_abstract
                && str_attr(tree, c, ATTR_RESPONSE_REF).is_some()
        })
        .collect();
    out.sort_by(|a, b| tree.node(*a).name.cmp(&tree.node(*b).name));
    out
}

/// The object a prompt's reply is read into: its `@responseRef`, resolved on its exact
/// package-qualified name (ADR-0041). `None` when it names no object.
#[must_use]
pub fn response_object(tree: &Tree, index: &ObjectIndex, template: NodeId) -> Option<NodeId> {
    index
        .ref_target(tree, template, ATTR_RESPONSE_REF)
        .filter(|&o| tree.node(o).type_name == TYPE_OBJECT)
}

/// The reply's syntax (ADR-0053): `@responseFormat`, `json` unless it says `xml`.
#[must_use]
pub fn reply_format(tree: &Tree, template: NodeId) -> Format {
    match str_attr(tree, template, ATTR_RESPONSE_FORMAT) {
        Some(f) if f.eq_ignore_ascii_case(FORMAT_XML) => Format::Xml,
        _ => Format::Json,
    }
}

/// The fragment's style: `@promptStyle`, `guide` unless it says otherwise.
#[must_use]
pub fn prompt_style(tree: &Tree, template: NodeId) -> PromptStyle {
    PromptStyle::from_attr(str_attr(tree, template, ATTR_PROMPT_STYLE))
}

/// The extract descriptor of `object`: every effective field, nested value objects read
/// through their `@objectRef` to [`MAX_NEST_DEPTH`], a cycle or an unresolved reference
/// read as opaque text.
#[must_use]
pub fn extract_schema(
    tree: &Tree,
    index: &ObjectIndex,
    object: NodeId,
    format: Format,
) -> ExtractSchema {
    schema_at(tree, index, object, format, &mut HashSet::new(), 0)
}

fn schema_at(
    tree: &Tree,
    index: &ObjectIndex,
    object: NodeId,
    format: Format,
    visited: &mut HashSet<NodeId>,
    depth: usize,
) -> ExtractSchema {
    visited.insert(object);
    let fields = fields_of(tree, object)
        .into_iter()
        .map(|f| field_spec(tree, index, f, object, format, visited, depth))
        .collect();
    visited.remove(&object);
    ExtractSchema {
        format,
        root_name: tree.node(object).name.clone(),
        fields,
    }
}

fn field_spec(
    tree: &Tree,
    index: &ObjectIndex,
    field: NodeId,
    owner: NodeId,
    format: Format,
    visited: &mut HashSet<NodeId>,
    depth: usize,
) -> FieldSpec {
    let spec = field_shape(tree, index, field, owner, format, visited, depth);
    if !spec.array {
        return spec;
    }
    // Element-count bounds: the field's array validator is the one source of them.
    match validator(tree, field, VALIDATOR_ARRAY) {
        Some(v) => FieldSpec {
            min_items: own_u64(tree, v, ATTR_MIN).and_then(|n| usize::try_from(n).ok()),
            max_items: own_u64(tree, v, ATTR_MAX).and_then(|n| usize::try_from(n).ok()),
            ..spec
        },
        None => spec,
    }
}

fn field_shape(
    tree: &Tree,
    index: &ObjectIndex,
    field: NodeId,
    owner: NodeId,
    format: Format,
    visited: &mut HashSet<NodeId>,
    depth: usize,
) -> FieldSpec {
    let n = tree.node(field);
    let name = n.name.as_str();
    let required = is_true(tree, field, ATTR_REQUIRED);
    let array = tree.resolved_is_array(field);
    let listed = |spec: FieldSpec| FieldSpec { array, ..spec };
    if n.sub_type == "enum" {
        let mode = str_attr(tree, field, ATTR_NORMALIZE)
            .or_else(|| str_attr(tree, owner, ATTR_NORMALIZE))
            .unwrap_or(normalize::DEFAULT);
        return listed(FieldSpec {
            enum_alias: string_map(tree, field, ATTR_ENUM_ALIAS),
            coerce_default: str_attr(tree, field, ATTR_COERCE_DEFAULT).map(str::to_string),
            default_value: str_attr(tree, field, ATTR_DEFAULT).map(str::to_string),
            normalize: mode.to_string(),
            ..FieldSpec::enumeration(name, required, strings(tree, field, ATTR_VALUES))
        });
    }
    if n.sub_type == "object" || tree.attr(field, ATTR_OBJECT_REF).is_some() {
        return match index.ref_target(tree, field, ATTR_OBJECT_REF) {
            Some(target)
                if tree.node(target).type_name == TYPE_OBJECT
                    && !visited.contains(&target)
                    && depth + 1 < MAX_NEST_DEPTH =>
            {
                let nested = schema_at(tree, index, target, format, visited, depth + 1);
                listed(FieldSpec::object(name, required, nested))
            }
            // An unresolved reference, a cycle or the depth bound: an opaque leaf.
            _ => FieldSpec::scalar(name, FieldKind::String, required),
        };
    }
    let kind = scalar_kind(&n.sub_type);
    if array {
        return FieldSpec::scalar(name, kind, required).array();
    }
    if is_true(tree, field, ATTR_XML_TEXT) {
        return FieldSpec::scalar(name, kind, required).text_content();
    }
    let spec = FieldSpec::scalar(name, kind, required);
    if matches!(kind, FieldKind::Int | FieldKind::Long | FieldKind::Double)
        && let Some(v) = validator(tree, field, VALIDATOR_NUMERIC)
    {
        let (min, max) = (own_f64(tree, v, ATTR_MIN), own_f64(tree, v, ATTR_MAX));
        if min.is_some() || max.is_some() {
            return spec.range(min, max);
        }
    }
    spec.default_value(str_attr(tree, field, ATTR_DEFAULT).map(str::to_string))
}

/// The output-format fragment's descriptor for `object`, the reply's root. A nested object
/// is named with its kind and taught no deeper, as in every port.
#[must_use]
pub fn output_format_spec(
    tree: &Tree,
    object: NodeId,
    format: Format,
    style: PromptStyle,
) -> OutputFormatSpec {
    let fields = fields_of(tree, object)
        .into_iter()
        .map(|f| prompt_field(tree, f))
        .collect();
    OutputFormatSpec {
        format,
        root_name: tree.node(object).name.clone(),
        style,
        fields,
    }
}

fn prompt_field(tree: &Tree, field: NodeId) -> PromptField {
    let n = tree.node(field);
    let required = is_true(tree, field, ATTR_REQUIRED);
    let array = tree.resolved_is_array(field);
    if n.sub_type == "object" {
        return PromptField {
            array,
            ..PromptField::new(&n.name, FieldKind::Object, required)
        };
    }
    let example = str_attr(tree, field, ATTR_EXAMPLE).map(str::to_string);
    let instruction = str_attr(tree, field, ATTR_INSTRUCTION).map(str::to_string);
    if n.sub_type == "enum" {
        let doc = string_map(tree, field, ATTR_ENUM_DOC);
        return PromptField {
            array,
            enum_values: Some(strings(tree, field, ATTR_VALUES)),
            enum_doc: (!doc.is_empty()).then(|| doc.into_iter().collect::<HashMap<_, _>>()),
            example,
            instruction,
            ..PromptField::new(&n.name, FieldKind::Enum, required)
        };
    }
    PromptField {
        array,
        example,
        instruction,
        ..PromptField::new(&n.name, scalar_kind(&n.sub_type), required)
    }
}

/// The extract kind of a scalar field subtype; anything not numeric or boolean is text.
#[must_use]
pub fn scalar_kind(sub_type: &str) -> FieldKind {
    match sub_type {
        "int" => FieldKind::Int,
        "long" | "currency" => FieldKind::Long,
        "double" | "float" | "decimal" => FieldKind::Double,
        "boolean" => FieldKind::Boolean,
        _ => FieldKind::String,
    }
}

// ---- model reads -----------------------------------------------------------------------

/// The effective fields of `object`, inherited ones included, in declaration order.
fn fields_of(tree: &Tree, object: NodeId) -> Vec<NodeId> {
    tree.children(object)
        .iter()
        .copied()
        .filter(|&c| tree.node(c).type_name == TYPE_FIELD)
        .collect()
}

fn validator(tree: &Tree, field: NodeId, sub_type: &str) -> Option<NodeId> {
    tree.children(field).iter().copied().find(|&c| {
        let n = tree.node(c);
        n.type_name == TYPE_VALIDATOR && n.sub_type == sub_type
    })
}

fn str_attr<'t>(tree: &'t Tree, id: NodeId, name: &str) -> Option<&'t str> {
    tree.attr(id, name)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

fn is_true(tree: &Tree, id: NodeId, name: &str) -> bool {
    match tree.attr(id, name) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn strings(tree: &Tree, id: NodeId, name: &str) -> Vec<String> {
    tree.attr(id, name)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A string-to-string map attribute, in declaration order; a null value is dropped.
fn string_map(tree: &Tree, id: NodeId, name: &str) -> Vec<(String, String)> {
    tree.attr(id, name)
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| {
                    let v = v.as_str().map_or_else(|| v.to_string(), str::to_string);
                    (k.clone(), v)
                })
                .collect()
        })
        .unwrap_or_default()
}

// ADR-0039 own: a validator's `@min`/`@max` are its own declared bounds.
fn own_f64(tree: &Tree, id: NodeId, name: &str) -> Option<f64> {
    tree.own_attr(id, name)
        .filter(|a| !a.value.is_boolean())
        .and_then(|a| a.value.as_f64())
}

// ADR-0039 own: a validator's `@min`/`@max` are its own declared bounds.
fn own_u64(tree: &Tree, id: NodeId, name: &str) -> Option<u64> {
    tree.own_attr(id, name).and_then(|a| a.value.as_u64())
}
