//! The FR-010 extract model and report.
//!
//! [`FieldExtraction`], [`FieldKind`], [`Tolerance`] and [`Format`] are frozen cross-port
//! vocabularies: the extract-conformance corpus serializes them as upper-case tokens, and
//! `scripts/check-extract-field-kinds.mjs` reads [`FieldKind`] from this file.

use std::collections::HashMap;
use std::fmt;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::normalize;

/// The document format a reply is parsed as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Json,
    Xml,
}

impl Format {
    /// The corpus token (`JSON`, `XML`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Json => "JSON",
            Self::Xml => "XML",
        }
    }

    /// The format a corpus token names.
    #[must_use]
    pub fn parse(token: &str) -> Option<Self> {
        match token {
            "JSON" => Some(Self::Json),
            "XML" => Some(Self::Xml),
            _ => None,
        }
    }
}

/// The coercion targets the engine understands; `Object` is a nested schema. The corpus
/// tokens are the upper-cased names (`STRING`, `INT`, ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldKind {
    String,
    Int,
    Long,
    Double,
    Boolean,
    Enum,
    Object,
}

impl FieldKind {
    /// The corpus token.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::String => "STRING",
            Self::Int => "INT",
            Self::Long => "LONG",
            Self::Double => "DOUBLE",
            Self::Boolean => "BOOLEAN",
            Self::Enum => "ENUM",
            Self::Object => "OBJECT",
        }
    }

    /// The kind a corpus token names.
    #[must_use]
    pub fn parse(token: &str) -> Option<Self> {
        Some(match token {
            "STRING" => Self::String,
            "INT" => Self::Int,
            "LONG" => Self::Long,
            "DOUBLE" => Self::Double,
            "BOOLEAN" => Self::Boolean,
            "ENUM" => Self::Enum,
            "OBJECT" => Self::Object,
            _ => return None,
        })
    }
}

/// The frozen cross-port classification of one field. Do not reorder or add without an ADR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldExtraction {
    /// Read from the reply and coerced cleanly.
    Extracted,
    /// Reached through `@coerceDefault` (present but uncoercible) or `@default` (absent).
    Defaulted,
    /// Absent, and not required.
    LostOptional,
    /// Absent, and required.
    LostRequired,
    /// Present, but unusable.
    Malformed,
}

impl FieldExtraction {
    /// The corpus token (`EXTRACTED`, `LOST_REQUIRED`, ...).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extracted => "EXTRACTED",
            Self::Defaulted => "DEFAULTED",
            Self::LostOptional => "LOST_OPTIONAL",
            Self::LostRequired => "LOST_REQUIRED",
            Self::Malformed => "MALFORMED",
        }
    }
}

impl fmt::Display for FieldExtraction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How much repair the engine attempts. `Strict` is case-sensitive and rejects what it
/// would otherwise clamp or truncate; `Normal` (the default) is case-insensitive; `Loose`
/// behaves as `Normal` today and is reserved for more repair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tolerance {
    Strict,
    #[default]
    Normal,
    Loose,
}

impl Tolerance {
    /// The tolerance a corpus token names.
    #[must_use]
    pub fn parse(token: &str) -> Option<Self> {
        match token {
            "STRICT" => Some(Self::Strict),
            "NORMAL" => Some(Self::Normal),
            "LOOSE" => Some(Self::Loose),
            _ => None,
        }
    }
}

/// One recorded normalization or coercion. `kind` is e.g. `normalize`, `alias`,
/// `runtime-alias-override`, `clamp`, `truncate`, `coerceDefault`, `default`, `onField`,
/// `normalizer` or `onLocate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Coercion {
    pub field_path: String,
    pub from: String,
    pub to: String,
    pub kind: String,
}

impl Coercion {
    pub(crate) fn new(path: &str, from: &str, to: &str, kind: &str) -> Self {
        Self {
            field_path: path.to_string(),
            from: from.to_string(),
            to: to.to_string(),
            kind: kind.to_string(),
        }
    }
}

/// One field's extract descriptor.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldSpec {
    pub name: String,
    pub kind: FieldKind,
    pub required: bool,
    pub array: bool,
    /// Member symbols (`Enum` only).
    pub enum_values: Option<Vec<String>>,
    /// `@enumAlias`: synonym to member, in declaration order (`Enum` only).
    pub enum_alias: Vec<(String, String)>,
    /// The numeric range, from the field's numeric validator.
    pub min: Option<f64>,
    pub max: Option<f64>,
    /// The nested schema (`Object` only).
    pub nested: Option<Box<ExtractSchema>>,
    /// `@coerceDefault`: the member a present but uncoercible value falls back to.
    pub coerce_default: Option<String>,
    /// `@default`: the value an absent field is filled with.
    pub default_value: Option<String>,
    /// `@normalize`: `none`, `collapse` or `strip`.
    pub normalize: String,
    /// `@xmlText`: the field receives its element's text body.
    pub text_content: bool,
    /// `validator.array` element-count bounds.
    pub min_items: Option<usize>,
    pub max_items: Option<usize>,
}

impl FieldSpec {
    /// A scalar field of `kind`.
    #[must_use]
    pub fn scalar(name: &str, kind: FieldKind, required: bool) -> Self {
        Self {
            name: name.to_string(),
            kind,
            required,
            array: false,
            enum_values: None,
            enum_alias: Vec::new(),
            min: None,
            max: None,
            nested: None,
            coerce_default: None,
            default_value: None,
            normalize: normalize::DEFAULT.to_string(),
            text_content: false,
            min_items: None,
            max_items: None,
        }
    }

    /// An enum field over `values`.
    #[must_use]
    pub fn enumeration(name: &str, required: bool, values: Vec<String>) -> Self {
        Self {
            enum_values: Some(values),
            ..Self::scalar(name, FieldKind::Enum, required)
        }
    }

    /// An object field over `nested`.
    #[must_use]
    pub fn object(name: &str, required: bool, nested: ExtractSchema) -> Self {
        Self {
            nested: Some(Box::new(nested)),
            ..Self::scalar(name, FieldKind::Object, required)
        }
    }

    /// The same field as a list.
    #[must_use]
    pub fn array(mut self) -> Self {
        self.array = true;
        self
    }

    /// The same field with an `@enumAlias` map.
    #[must_use]
    pub fn aliases(mut self, aliases: Vec<(String, String)>) -> Self {
        self.enum_alias = aliases;
        self
    }

    /// The same field with a numeric range.
    #[must_use]
    pub fn range(mut self, min: Option<f64>, max: Option<f64>) -> Self {
        self.min = min;
        self.max = max;
        self
    }

    /// The same field with a `@default`.
    #[must_use]
    pub fn default_value(mut self, value: Option<String>) -> Self {
        self.default_value = value;
        self
    }

    /// The same field with a `@coerceDefault`.
    #[must_use]
    pub fn coerce_default(mut self, value: Option<String>) -> Self {
        self.coerce_default = value;
        self
    }

    /// The same field with a `@normalize` mode.
    #[must_use]
    pub fn normalize(mut self, mode: &str) -> Self {
        self.normalize = mode.to_string();
        self
    }

    /// The same field reading its element's text body (`@xmlText`).
    #[must_use]
    pub fn text_content(mut self) -> Self {
        self.text_content = true;
        self
    }

    /// The same field with `validator.array` element-count bounds.
    #[must_use]
    pub fn item_bounds(mut self, min: Option<usize>, max: Option<usize>) -> Self {
        self.min_items = min;
        self.max_items = max;
        self
    }
}

/// The top-level extract descriptor. `root_name` is the XML root tag, or the logical JSON
/// root name.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtractSchema {
    pub format: Format,
    pub root_name: String,
    pub fields: Vec<FieldSpec>,
}

/// A per-field coercion hook: `(field_path, raw, spec)` to a value, or `None` to fall
/// through to the default coercion.
pub type OnField = Box<dyn Fn(&str, &str, &FieldSpec) -> Option<Value>>;
/// A per-field normalizer, keyed by path or simple name: `raw` to a value, or `None`.
pub type Normalizer = Box<dyn Fn(&str) -> Option<Value>>;
/// The document-level locate hook: `(text, format)` to the payload text, or `None` for the
/// default locator. It only decides WHICH text is parsed, never how.
pub type OnLocate = Box<dyn Fn(&str, Format) -> Option<String>>;

/// The bounded runtime override surface.
#[derive(Default)]
pub struct ExtractOptions {
    pub tolerance: Tolerance,
    /// Runtime enum aliases; they win over the schema's on a key conflict.
    pub aliases: Vec<(String, String)>,
    pub normalizers: HashMap<String, Normalizer>,
    pub on_field: Option<OnField>,
    pub on_locate: Option<OnLocate>,
    /// XML only: the reply has no enclosing root; its top-level elements are the fields.
    pub rootless: bool,
}

impl ExtractOptions {
    /// The same options at `tolerance`.
    #[must_use]
    pub fn tolerance(mut self, tolerance: Tolerance) -> Self {
        self.tolerance = tolerance;
        self
    }

    /// The same options with `rootless` set.
    #[must_use]
    pub fn rootless(mut self, rootless: bool) -> Self {
        self.rootless = rootless;
        self
    }
}

/// What the engine returns: the forgiving data map and its report.
#[derive(Debug, Clone)]
pub struct ExtractionOutcome {
    pub data: Map<String, Value>,
    pub report: ExtractionReport,
}

/// Per-field classification, the empty flag and the coercion notes.
#[derive(Debug, Clone, Default)]
pub struct ExtractionReport {
    states: IndexMap<String, FieldExtraction>,
    coercions: Vec<Coercion>,
    defaulted_required: Vec<String>,
    malformed_required: Vec<String>,
    empty: bool,
}

impl ExtractionReport {
    pub(crate) fn set(&mut self, path: &str, state: FieldExtraction) {
        self.states.insert(path.to_string(), state);
    }

    pub(crate) fn add_coercion(&mut self, c: Coercion) {
        self.coercions.push(c);
    }

    pub(crate) fn mark_empty(&mut self) {
        self.empty = true;
    }

    pub(crate) fn mark_malformed_required(&mut self, path: &str) {
        if !self.malformed_required.iter().any(|p| p == path) {
            self.malformed_required.push(path.to_string());
        }
    }

    pub(crate) fn mark_defaulted_required(&mut self, path: &str) {
        if !self.defaulted_required.iter().any(|p| p == path) {
            self.defaulted_required.push(path.to_string());
        }
    }

    /// Was there nothing to parse?
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.empty
    }

    /// Every classified path, in classification order.
    #[must_use]
    pub fn states(&self) -> &IndexMap<String, FieldExtraction> {
        &self.states
    }

    /// Every recorded coercion, in order.
    #[must_use]
    pub fn coercions(&self) -> &[Coercion] {
        &self.coercions
    }

    fn by_state(&self, s: FieldExtraction) -> Vec<String> {
        self.states
            .iter()
            .filter(|(_, v)| **v == s)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// The required fields the reply did not answer.
    #[must_use]
    pub fn lost_required(&self) -> Vec<String> {
        self.by_state(FieldExtraction::LostRequired)
    }

    /// Every field classified `MALFORMED`.
    #[must_use]
    pub fn malformed(&self) -> Vec<String> {
        self.by_state(FieldExtraction::Malformed)
    }

    /// The required fields the reply answered with a value that could not be used. Their
    /// value is absent from the data, as a lost field's is, so the strict gate fails on
    /// these too.
    #[must_use]
    pub fn malformed_required(&self) -> &[String] {
        &self.malformed_required
    }

    /// Every field whose value came from its `@default`.
    #[must_use]
    pub fn defaulted(&self) -> Vec<String> {
        self.by_state(FieldExtraction::Defaulted)
    }

    /// The required fields the reply did not answer whose value was supplied by their
    /// `@default`. A default IS an answer, so these are not in [`Self::lost_required`]:
    /// a `@default` switches off loss detection for its field, and this is how to see it.
    #[must_use]
    pub fn defaulted_required(&self) -> &[String] {
        &self.defaulted_required
    }

    /// Is a required field lost or malformed? This is the strict gate.
    #[must_use]
    pub fn fails_strict(&self) -> bool {
        !self.lost_required().is_empty() || !self.malformed_required.is_empty()
    }
}
