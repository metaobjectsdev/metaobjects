//! The output-format prompt fragment (FR-010): "produce your answer like this".
//!
//! Renders an [`OutputFormatSpec`] into the text that teaches a model how to shape its
//! answer, in one of three styles ([`PromptStyle`]) and two formats. Guidance lives in
//! prose, inline placeholders or a filled skeleton, never in comments, which models ignore.
//! The text is byte-identical to the reference (`OutputFormatRenderer` in every port),
//! held by `fixtures/output-prompt-conformance/`.

use std::collections::{HashMap, HashSet};

use crate::escapers::{self, FORMAT_JSON, FORMAT_XML};
use crate::extract::coerce::is_ascii_numeric;
use crate::extract::{FieldKind, Format};

const INDENT: &str = "  ";
const MAX_NEST_DEPTH: usize = 8;

/// How the fragment teaches the model. The `@promptStyle` values are `guide` (the
/// default), `inline` and `exampleOnly`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PromptStyle {
    /// A prose field list, then an example skeleton.
    #[default]
    Guide,
    /// One skeleton whose values are placeholders or enum choices.
    Inline,
    /// A filled example skeleton and nothing else.
    ExampleOnly,
}

impl PromptStyle {
    /// The style a `@promptStyle` value names; absent or unknown is `Guide`.
    #[must_use]
    pub fn from_attr(value: Option<&str>) -> Self {
        match value {
            Some("inline") => Self::Inline,
            Some("exampleOnly") => Self::ExampleOnly,
            _ => Self::Guide,
        }
    }
}

/// One field of the fragment. `name` must be identifier-safe: it is not escaped.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptField {
    pub name: String,
    pub kind: FieldKind,
    pub required: bool,
    pub array: bool,
    pub enum_values: Option<Vec<String>>,
    /// Member to its documentation, shown under the member list in `guide`.
    pub enum_doc: Option<HashMap<String, String>>,
    pub example: Option<String>,
    pub instruction: Option<String>,
    pub nested: Option<Box<OutputFormatSpec>>,
}

impl PromptField {
    /// A field with no example, instruction, members or nested shape.
    #[must_use]
    pub fn new(name: &str, kind: FieldKind, required: bool) -> Self {
        Self {
            name: name.to_string(),
            kind,
            required,
            array: false,
            enum_values: None,
            enum_doc: None,
            example: None,
            instruction: None,
            nested: None,
        }
    }
}

/// A complete output-format descriptor. `root_name` must be identifier-safe.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputFormatSpec {
    pub format: Format,
    pub root_name: String,
    pub style: PromptStyle,
    pub fields: Vec<PromptField>,
}

/// Render-time overrides of the metadata defaults: a style, and per-field examples and
/// instructions.
#[derive(Debug, Clone, Default)]
pub struct PromptOverrides {
    pub style: Option<PromptStyle>,
    pub examples: HashMap<String, String>,
    pub instructions: HashMap<String, String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Example,
    Inline,
}

/// The specs on the current nesting path, by address: two equal sibling specs must both
/// expand, so the guard is identity, not equality.
type Path = HashSet<usize>;

fn key(spec: &OutputFormatSpec) -> usize {
    std::ptr::from_ref(spec) as usize
}

/// Render `spec` as an output-format fragment. The style is the override's, else the spec's.
#[must_use]
pub fn render_output_format(spec: &OutputFormatSpec, overrides: &PromptOverrides) -> String {
    let r = Renderer { o: overrides };
    match overrides.style.unwrap_or(spec.style) {
        PromptStyle::ExampleOnly => r.skeleton(spec, Mode::Example),
        PromptStyle::Inline => r.skeleton(spec, Mode::Inline),
        PromptStyle::Guide => {
            let mut path = Path::from([key(spec)]);
            format!(
                "Fill in each field as described below:\n{}\nRespond exactly like this:\n{}",
                r.guide_fields(spec, "", &mut path, 0),
                r.skeleton(spec, Mode::Example)
            )
        }
    }
}

fn esc(format: &str, s: &str) -> String {
    escapers::escape(format, s).unwrap_or_else(|| s.to_string())
}

struct Renderer<'a> {
    o: &'a PromptOverrides,
}

impl Renderer<'_> {
    fn skeleton(&self, spec: &OutputFormatSpec, mode: Mode) -> String {
        let mut path = Path::from([key(spec)]);
        match spec.format {
            Format::Xml => format!(
                "<{root}>\n{}</{root}>",
                self.xml_body(spec, INDENT, mode, &mut path, 0),
                root = spec.root_name
            ),
            Format::Json => self.json_object(spec, "", mode, &mut path, 0),
        }
    }

    fn instruction<'f>(&'f self, f: &'f PromptField) -> Option<&'f str> {
        self.o
            .instructions
            .get(&f.name)
            .map(String::as_str)
            .or(f.instruction.as_deref())
    }

    fn declared_example<'f>(&'f self, f: &'f PromptField) -> Option<&'f str> {
        self.o
            .examples
            .get(&f.name)
            .map(String::as_str)
            .or(f.example.as_deref())
    }

    /// An enum with no declared example shows its members, never one pre-filled member:
    /// a model shown a filled-in value copies it.
    fn example(&self, f: &PromptField) -> String {
        if let Some(e) = self.declared_example(f) {
            return e.to_string();
        }
        match &f.enum_values {
            Some(values) if f.kind == FieldKind::Enum && !values.is_empty() => values.join(" | "),
            _ => format!("{{{}}}", f.name),
        }
    }

    fn inline_content(&self, f: &PromptField) -> String {
        if f.kind == FieldKind::Enum
            && let Some(values) = f.enum_values.as_ref().filter(|v| !v.is_empty())
        {
            return values.join(" | ");
        }
        if f.kind == FieldKind::Boolean {
            return "true | false".to_string();
        }
        format!("{{{}}}", self.instruction(f).unwrap_or(&f.name))
    }

    fn guide_fields(
        &self,
        spec: &OutputFormatSpec,
        prefix: &str,
        path: &mut Path,
        depth: usize,
    ) -> String {
        let mut sb = String::new();
        for f in &spec.fields {
            let display = format!("{prefix}{}", f.name);
            sb.push_str(&self.guide_entry(f, &display));
            if let Some(nested) = expandable(f, path, depth) {
                let child = if f.array {
                    format!("{display}[].")
                } else {
                    format!("{display}.")
                };
                path.insert(key(nested));
                sb.push_str(&self.guide_fields(nested, &child, path, depth + 1));
                path.remove(&key(nested));
            }
        }
        sb
    }

    fn guide_entry(&self, f: &PromptField, display: &str) -> String {
        let req = if f.required { "required" } else { "optional" };
        let mut sb = format!("- {display} ({req})");
        if let Some(i) = self.instruction(f) {
            sb.push_str(&format!(": {i}"));
        }
        sb.push('\n');
        if f.kind == FieldKind::Enum
            && let Some(values) = f.enum_values.as_ref().filter(|v| !v.is_empty())
        {
            sb.push_str(&format!("    one of {}\n", values.join(", ")));
            if let Some(doc) = &f.enum_doc {
                for v in values {
                    if let Some(d) = doc.get(v) {
                        sb.push_str(&format!("      {v} = {d}\n"));
                    }
                }
            }
        }
        if let Some(eg) = self.declared_example(f) {
            sb.push_str(&format!("    e.g. {eg}\n"));
        }
        sb
    }

    fn json_object(
        &self,
        spec: &OutputFormatSpec,
        brace_indent: &str,
        mode: Mode,
        path: &mut Path,
        depth: usize,
    ) -> String {
        if spec.fields.is_empty() {
            return format!("{{\n{brace_indent}}}");
        }
        let field_indent = format!("{brace_indent}{INDENT}");
        let lines: Vec<String> = spec
            .fields
            .iter()
            .map(|f| {
                format!(
                    "{field_indent}\"{}\": {}",
                    f.name,
                    self.json_value(f, &field_indent, mode, path, depth)
                )
            })
            .collect();
        format!("{{\n{}\n{brace_indent}}}", lines.join(",\n"))
    }

    fn json_value(
        &self,
        f: &PromptField,
        indent: &str,
        mode: Mode,
        path: &mut Path,
        depth: usize,
    ) -> String {
        if f.array {
            let elem_indent = format!("{indent}{INDENT}");
            let elem = match expandable(f, path, depth) {
                Some(nested) => {
                    path.insert(key(nested));
                    let e = self.json_object(nested, &elem_indent, mode, path, depth + 1);
                    path.remove(&key(nested));
                    e
                }
                None => self.json_leaf(f, mode),
            };
            return format!("[\n{elem_indent}{elem}\n{indent}]");
        }
        if f.kind == FieldKind::Object
            && let Some(nested) = expandable(f, path, depth)
        {
            path.insert(key(nested));
            let out = self.json_object(nested, indent, mode, path, depth + 1);
            path.remove(&key(nested));
            return out;
        }
        self.json_leaf(f, mode)
    }

    /// A number or boolean is unquoted wherever the skeleton holds its placeholder: a
    /// quoted one taught the model to answer a number as a JSON string.
    fn json_leaf(&self, f: &PromptField, mode: Mode) -> String {
        let unquoted = is_numeric_kind(f.kind);
        if mode == Mode::Inline {
            let content = self.inline_content(f);
            return if unquoted {
                content
            } else {
                format!("\"{}\"", esc(FORMAT_JSON, &content))
            };
        }
        if unquoted && self.declared_example(f).is_none() {
            return format!("{{{}}}", f.name);
        }
        let value = self.example(f);
        if unquoted && (value == "true" || value == "false" || is_ascii_numeric(value.trim())) {
            return value;
        }
        format!("\"{}\"", esc(FORMAT_JSON, &value))
    }

    fn xml_body(
        &self,
        spec: &OutputFormatSpec,
        indent: &str,
        mode: Mode,
        path: &mut Path,
        depth: usize,
    ) -> String {
        spec.fields
            .iter()
            .map(|f| self.xml_field(f, indent, mode, path, depth))
            .collect()
    }

    fn xml_field(
        &self,
        f: &PromptField,
        indent: &str,
        mode: Mode,
        path: &mut Path,
        depth: usize,
    ) -> String {
        if let Some(nested) = expandable(f, path, depth) {
            path.insert(key(nested));
            let body = self.xml_body(nested, &format!("{indent}{INDENT}"), mode, path, depth + 1);
            path.remove(&key(nested));
            return format!("{indent}<{n}>\n{body}{indent}</{n}>\n", n = f.name);
        }
        let content = match mode {
            Mode::Inline => self.inline_content(f),
            Mode::Example => self.example(f),
        };
        format!(
            "{indent}<{n}>{}</{n}>\n",
            esc(FORMAT_XML, &content),
            n = f.name
        )
    }
}

fn is_numeric_kind(kind: FieldKind) -> bool {
    matches!(
        kind,
        FieldKind::Int | FieldKind::Long | FieldKind::Double | FieldKind::Boolean
    )
}

/// The nested spec of an OBJECT field that may expand here: within the depth bound and not
/// already on the path.
fn expandable<'f>(f: &'f PromptField, path: &Path, depth: usize) -> Option<&'f OutputFormatSpec> {
    if f.kind != FieldKind::Object || depth >= MAX_NEST_DEPTH {
        return None;
    }
    f.nested.as_deref().filter(|n| !path.contains(&key(n)))
}
