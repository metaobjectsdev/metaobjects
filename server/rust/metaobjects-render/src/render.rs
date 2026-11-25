//! The render pipeline for `template.*` (FR-004).
//!
//! Resolve the body (inline, or by reference through a [`Provider`]), expand partials ahead
//! of time (cycle-guarded, at most [`MAX_DEPTH`] deep), render the result with the
//! `mustache-ng` engine over the payload and its derived accessors, escaping every
//! `{{value}}` for the template's format, then apply the `maxChars` budget, which fails
//! rather than truncates.
//!
//! Expanding partials first gives the same whitespace in every port and keeps cycle
//! detection here. The engine's own HTML escaping is never used: each escaped tag is
//! rewritten to a raw one between two marker characters, and the text between the markers
//! is escaped for the format once the engine has finished. Set-delimiter tags are refused,
//! as the Python and C# renderers refuse them.

use std::collections::HashMap;
use std::fmt;

use mustache::Data;
use serde::Serialize;
use serde_json::Value;

use crate::accessors::with_derived_accessors;
use crate::escapers::{self, FORMAT_TEXT};
use crate::presence::{ERR_VAR_NOT_ON_PAYLOAD, first_missing};
use crate::tags::{self, TagKind};

/// How deep partials may nest before the render fails.
pub const MAX_DEPTH: usize = 32;

/// Opens an escaped value in the engine's output. U+FDD0 and U+FDD1 are Unicode
/// noncharacters, reserved for exactly this kind of internal use.
const OPEN_MARK: char = '\u{FDD0}';
/// Closes an escaped value in the engine's output.
const CLOSE_MARK: char = '\u{FDD1}';

/// File extensions of Jinja templates (ADR-0061), which this renderer does not run.
const JINJA_EXTENSIONS: [&str; 2] = [".jinja", ".j2"];

/// Anything that goes wrong in a render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderError(pub String);

impl fmt::Display for RenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RenderError {}

fn err<T>(message: impl Into<String>) -> Result<T, RenderError> {
    Err(RenderError(message.into()))
}

/// Resolves a template or partial reference to its text.
pub trait Provider {
    /// The text `reference` names, or `None` when there is none.
    fn resolve(&self, reference: &str) -> Option<String>;
}

/// A provider over a fixed map of references to bodies.
#[derive(Debug, Clone, Default)]
pub struct InMemoryProvider {
    entries: HashMap<String, String>,
}

impl InMemoryProvider {
    /// A provider over `entries`.
    #[must_use]
    pub fn new(entries: HashMap<String, String>) -> Self {
        Self { entries }
    }
}

impl Provider for InMemoryProvider {
    fn resolve(&self, reference: &str) -> Option<String> {
        self.entries.get(reference).cloned()
    }
}

/// Where a render's body comes from.
#[derive(Debug, Clone, Copy)]
pub enum Body<'a> {
    /// Inline template text.
    Inline(&'a str),
    /// A reference the provider resolves.
    Ref(&'a str),
}

/// One render call.
pub struct RenderRequest<'a> {
    /// The template body.
    pub body: Body<'a>,
    /// The data the template walks.
    pub payload: &'a Value,
    /// Resolves partials, and the body when it is a reference.
    pub provider: &'a dyn Provider,
    /// One of [`escapers::FORMATS`]; `text` escapes nothing.
    pub format: &'a str,
    /// A fail-closed output budget in characters.
    pub max_chars: Option<usize>,
}

impl<'a> RenderRequest<'a> {
    /// A `text` render of `body` over `payload` with no budget.
    #[must_use]
    pub fn new(body: Body<'a>, payload: &'a Value, provider: &'a dyn Provider) -> Self {
        Self {
            body,
            payload,
            provider,
            format: FORMAT_TEXT,
            max_chars: None,
        }
    }

    /// The same request in `format`.
    #[must_use]
    pub fn format(mut self, format: &'a str) -> Self {
        self.format = format;
        self
    }

    /// The same request with a `maxChars` budget.
    #[must_use]
    pub fn max_chars(mut self, max_chars: Option<usize>) -> Self {
        self.max_chars = max_chars;
        self
    }
}

/// Render `request`.
///
/// # Errors
/// An unknown format, an unresolved body or partial, a partial cycle or one nested deeper
/// than [`MAX_DEPTH`], a Jinja partial, a template syntax error, a set-delimiter tag, a
/// marker character in the template or payload, an interpolated name the payload does
/// not carry (`ERR_VAR_NOT_ON_PAYLOAD`), or output over the `maxChars` budget.
pub fn render(request: &RenderRequest<'_>) -> Result<String, RenderError> {
    if !escapers::is_format(request.format) {
        return err(format!("unknown render format \"{}\"", request.format));
    }
    let body = match request.body {
        Body::Inline(text) => text.to_string(),
        Body::Ref(reference) => {
            refuse_jinja(reference)?;
            match request.provider.resolve(reference) {
                Some(text) => text,
                None => return err(format!("unresolved ref: {reference}")),
            }
        }
    };
    let expanded = pre_expand_partials(&body, request.provider, &mut Vec::new())?;
    let payload = with_derived_accessors(request.payload);
    let found = tags::scan(&expanded).map_err(|e| syntax(&e))?;
    if let Some(name) = first_missing(&found, &payload) {
        return err(format!(
            "render verify failed: {ERR_VAR_NOT_ON_PAYLOAD} ({name})"
        ));
    }
    let source = mark_escaped_tags(&expanded, request.format)?;
    let data = to_data(&payload)?;
    let template = mustache::compile_str(&source)
        .map_err(|e| RenderError(format!("template syntax error: {e}")))?;
    let raw = template
        .render_data_to_string(&data)
        .map_err(|e| RenderError(format!("render failed: {e}")))?;
    let out = escape_marked(&raw, request.format)?;
    check_budget(out, request.max_chars)
}

/// Render `template` over a serializable payload (a generated payload type, say).
///
/// # Errors
/// The payload does not serialize to JSON, or anything [`render`] refuses.
pub fn render_serialize<T: Serialize>(
    body: Body<'_>,
    payload: &T,
    provider: &dyn Provider,
    format: &str,
    max_chars: Option<usize>,
) -> Result<String, RenderError> {
    let value = serde_json::to_value(payload)
        .map_err(|e| RenderError(format!("payload does not serialize: {e}")))?;
    render(&RenderRequest {
        body,
        payload: &value,
        provider,
        format,
        max_chars,
    })
}

fn check_budget(out: String, max_chars: Option<usize>) -> Result<String, RenderError> {
    if let Some(cap) = max_chars {
        let len = out.chars().count();
        if len > cap {
            return err(format!("render exceeded maxChars budget: {len} > {cap}"));
        }
    }
    Ok(out)
}

fn refuse_jinja(reference: &str) -> Result<(), RenderError> {
    if JINJA_EXTENSIONS.iter().any(|ext| reference.ends_with(ext)) {
        return err(format!(
            "\"{reference}\" is a Jinja template (ADR-0061); the Rust renderer runs Mustache only"
        ));
    }
    Ok(())
}

fn syntax(e: &tags::SyntaxError) -> RenderError {
    RenderError(format!("template syntax error: {e}"))
}

fn pre_expand_partials(
    text: &str,
    provider: &dyn Provider,
    stack: &mut Vec<String>,
) -> Result<String, RenderError> {
    if stack.len() >= MAX_DEPTH {
        return err(format!(
            "partial depth exceeded {MAX_DEPTH} (chain: {})",
            stack.join(" -> ")
        ));
    }
    let found = tags::scan(text).map_err(|e| syntax(&e))?;
    if found.iter().any(|t| t.kind == TagKind::Delimiters) {
        return err("set-delimiter tags ({{=<% %>=}}) are not supported by the Rust renderer");
    }
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    for tag in found.iter().filter(|t| t.kind == TagKind::Partial) {
        let reference = &tag.value;
        if stack.contains(reference) {
            return err(format!(
                "partial cycle: {} -> {reference}",
                stack.join(" -> ")
            ));
        }
        refuse_jinja(reference)?;
        let Some(body) = provider.resolve(reference) else {
            return err(format!("unresolved partial: {reference}"));
        };
        stack.push(reference.clone());
        let expanded = pre_expand_partials(&body, provider, stack);
        stack.pop();
        out.push_str(&text[pos..tag.start]);
        out.push_str(&expanded?);
        pos = tag.end;
    }
    out.push_str(&text[pos..]);
    Ok(out)
}

/// Rewrite every escaped `{{name}}` as a raw `{{&name}}`, between the markers unless the
/// format escapes nothing. Raw tags stay as they are.
fn mark_escaped_tags(text: &str, format: &str) -> Result<String, RenderError> {
    if text.contains([OPEN_MARK, CLOSE_MARK]) {
        return err("template contains a reserved character (U+FDD0 or U+FDD1)");
    }
    let found = tags::scan(text).map_err(|e| syntax(&e))?;
    let identity = escapers::is_identity(format);
    let mut out = String::with_capacity(text.len() + 16);
    let mut pos = 0;
    for tag in found.iter().filter(|t| t.kind == TagKind::Name) {
        out.push_str(&text[pos..tag.start]);
        if identity {
            out.push_str(&format!("{{{{&{}}}}}", tag.value));
        } else {
            out.push(OPEN_MARK);
            out.push_str(&format!("{{{{&{}}}}}", tag.value));
            out.push(CLOSE_MARK);
        }
        pos = tag.end;
    }
    out.push_str(&text[pos..]);
    Ok(out)
}

fn escape_marked(raw: &str, format: &str) -> Result<String, RenderError> {
    if escapers::is_identity(format) {
        return Ok(raw.to_string());
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(open) = rest.find(OPEN_MARK) {
        out.push_str(&rest[..open]);
        let after = &rest[open + OPEN_MARK.len_utf8()..];
        let Some(close) = after.find(CLOSE_MARK) else {
            return err("internal: unterminated escape marker");
        };
        let escaped = escapers::escape(format, &after[..close])
            .ok_or_else(|| RenderError(format!("unknown render format \"{format}\"")))?;
        out.push_str(&escaped);
        rest = &after[close + CLOSE_MARK.len_utf8()..];
    }
    out.push_str(rest);
    Ok(out)
}

/// The payload as the engine's data. Numbers become their shortest text, with a whole
/// float written as an integer (`2.0` -> `2`), as the other ports write them.
fn to_data(value: &Value) -> Result<Data, RenderError> {
    Ok(match value {
        Value::Null => Data::Null,
        Value::Bool(b) => Data::Bool(*b),
        Value::Number(n) => Data::String(number_text(n)),
        Value::String(s) => {
            if s.contains([OPEN_MARK, CLOSE_MARK]) {
                return err("payload contains a reserved character (U+FDD0 or U+FDD1)");
            }
            // An empty string is falsy for a section AND for an inverted section. The
            // engine skips `{{#x}}` over "" but also skips `{{^x}}`, so "" goes in as
            // null, which renders the same in every other position.
            if s.is_empty() {
                Data::Null
            } else {
                Data::String(s.clone())
            }
        }
        Value::Array(items) => Data::Vec(items.iter().map(to_data).collect::<Result<_, _>>()?),
        Value::Object(map) => Data::Map(
            map.iter()
                .map(|(k, v)| Ok((k.clone(), to_data(v)?)))
                .collect::<Result<_, RenderError>>()?,
        ),
    })
}

fn number_text(n: &serde_json::Number) -> String {
    if n.is_i64() || n.is_u64() {
        return n.to_string();
    }
    match n.as_f64() {
        Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
        Some(f) => f.to_string(),
        None => n.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(template: &str, payload: &Value, format: &str) -> Result<String, RenderError> {
        let provider = InMemoryProvider::default();
        render(&RenderRequest::new(Body::Inline(template), payload, &provider).format(format))
    }

    #[test]
    fn escapes_per_format_and_raw_bypasses() {
        let p = json!({"v": "a<b"});
        assert_eq!(
            run("{{v}}|{{{v}}}|{{&v}}", &p, "xml").unwrap(),
            "a&lt;b|a<b|a<b"
        );
        assert_eq!(run("{{v}}", &p, "text").unwrap(), "a<b");
    }

    #[test]
    fn whole_floats_print_as_integers() {
        assert_eq!(
            run("{{a}} {{b}}", &json!({"a": 2.0, "b": 2.5}), "text").unwrap(),
            "2 2.5"
        );
    }

    #[test]
    fn budget_fails_closed() {
        let provider = InMemoryProvider::default();
        let p = json!({});
        let e =
            render(&RenderRequest::new(Body::Inline("abcdef"), &p, &provider).max_chars(Some(3)))
                .unwrap_err();
        assert_eq!(e.0, "render exceeded maxChars budget: 6 > 3");
    }

    #[test]
    fn partial_cycles_and_missing_partials_fail() {
        let provider = InMemoryProvider::new(HashMap::from([
            ("a".to_string(), "{{> b}}".to_string()),
            ("b".to_string(), "{{> a}}".to_string()),
        ]));
        let p = json!({});
        let e = render(&RenderRequest::new(Body::Ref("a"), &p, &provider)).unwrap_err();
        assert!(e.0.starts_with("partial cycle"), "{e}");
        let e = run("{{> nope}}", &p, "text").unwrap_err();
        assert_eq!(e.0, "unresolved partial: nope");
    }

    #[test]
    fn refuses_what_it_does_not_run() {
        let p = json!({});
        assert!(run("{{=<% %>=}}", &p, "text").is_err());
        assert!(run("x", &p, "yaml").is_err());
        assert!(run("\u{FDD0}", &p, "text").is_err());
        let provider = InMemoryProvider::default();
        assert!(render(&RenderRequest::new(Body::Ref("t.jinja"), &p, &provider)).is_err());
    }
}
