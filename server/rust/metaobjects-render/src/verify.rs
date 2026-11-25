//! The template drift check: a template body against the payload it is rendered over.
//!
//! [`render`](crate::render) refuses a variable the payload lacks at render time; `verify` is
//! the build-time half. It walks the template's tags against a PLAIN field tree (the declared
//! shape of the payload, not data), so a field renamed on the payload is caught before a
//! prompt ships with a hole in it. The rules and finding codes are the TypeScript engine's
//! (`render/src/verify.ts`), held to `fixtures/verify-conformance/`:
//!
//! - A variable resolves through the context stack, innermost first; a section over a
//!   container field pushes that field's element fields, a section over anything else keeps
//!   the current context.
//! - `{{#hasX}}` is a derived boolean accessor when a field `x` is in reach, and `-last` is
//!   the positional accessor inside a section over a list of objects.
//! - Partials resolve through the provider and are walked in the section's context; a cycle
//!   or a chain past [`MAX_DEPTH`] stops quietly.
//! - After the walk, each `requiredSlots` name must have been used at the payload root
//!   (a warning when not), and each `requiredTags` tag must appear as an opening and a
//!   closing form in the body and its partials.

use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::Value;

use crate::accessors::{HAS_PREFIX, LAST_ACCESSOR, has_accessor_name};
pub use crate::presence::ERR_VAR_NOT_ON_PAYLOAD;
use crate::presence::matching_close;
use crate::render::{MAX_DEPTH, Provider};
use crate::tags::{self, Tag, TagKind};

/// A partial reference the provider does not resolve.
pub const ERR_PARTIAL_UNRESOLVED: &str = "ERR_PARTIAL_UNRESOLVED";
/// A declared `@requiredSlots` slot the template never references (a warning).
pub const ERR_REQUIRED_SLOT_UNUSED: &str = "ERR_REQUIRED_SLOT_UNUSED";
/// A declared `@requiredTags` output tag absent from the template text.
pub const ERR_OUTPUT_TAG_MISSING: &str = "ERR_OUTPUT_TAG_MISSING";
/// The template text does not parse, or changes delimiters where that cannot render.
pub const ERR_TEMPLATE_SYNTAX: &str = "ERR_TEMPLATE_SYNTAX";
/// A responding prompt's `@responseRef` names no loaded value shape with fields.
pub const ERR_RESPONSE_UNRESOLVED: &str = "ERR_RESPONSE_UNRESOLVED";
/// An xml prompt's `@requiredTags` tag names neither the reply type nor a reply field.
pub const ERR_RESPONSE_TAG_UNDECLARED: &str = "ERR_RESPONSE_TAG_UNDECLARED";
/// A body written for an engine this port does not run (Jinja).
pub const ERR_TEMPLATE_ENGINE_UNSUPPORTED: &str = "ERR_TEMPLATE_ENGINE_UNSUPPORTED";

/// One node of the payload's declared field tree.
///
/// `fields` present: a context-pushing field (an object, or a list of objects). Absent: a
/// scalar, or a list of scalars. `is_array` is the field's effective array-ness.
///
/// The `const` constructors build a tree a generated render helper keeps as a `static`;
/// [`PayloadField::owned`] and [`PayloadField::from_json`] build one at run time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadField {
    pub name: Cow<'static, str>,
    pub fields: Option<Cow<'static, [PayloadField]>>,
    pub is_array: bool,
}

impl PayloadField {
    /// A scalar field.
    #[must_use]
    pub const fn scalar(name: &'static str) -> Self {
        Self {
            name: Cow::Borrowed(name),
            fields: None,
            is_array: false,
        }
    }

    /// An array of scalars.
    #[must_use]
    pub const fn scalar_array(name: &'static str) -> Self {
        Self {
            name: Cow::Borrowed(name),
            fields: None,
            is_array: true,
        }
    }

    /// A nested object: a section over it pushes `fields`.
    #[must_use]
    pub const fn object(name: &'static str, fields: &'static [PayloadField]) -> Self {
        Self {
            name: Cow::Borrowed(name),
            fields: Some(Cow::Borrowed(fields)),
            is_array: false,
        }
    }

    /// An array of objects: a section over it pushes `fields` once per element.
    #[must_use]
    pub const fn object_array(name: &'static str, fields: &'static [PayloadField]) -> Self {
        Self {
            name: Cow::Borrowed(name),
            fields: Some(Cow::Borrowed(fields)),
            is_array: true,
        }
    }

    /// A field built at run time.
    #[must_use]
    pub fn owned(name: String, fields: Option<Vec<PayloadField>>, is_array: bool) -> Self {
        Self {
            name: Cow::Owned(name),
            fields: fields.map(Cow::Owned),
            is_array,
        }
    }

    /// A field tree from the corpus's `payload.json` shape: `[{ name, fields?, isArray? }]`.
    #[must_use]
    pub fn from_json(list: &Value) -> Vec<Self> {
        list.as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|f| {
                        Self::owned(
                            f["name"].as_str().unwrap_or_default().to_string(),
                            f.get("fields").map(Self::from_json),
                            f["isArray"].as_bool().unwrap_or(false),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// One drift finding. `path` is the offending variable path, partial reference, slot or tag.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Finding {
    pub code: &'static str,
    pub path: String,
}

impl Finding {
    fn new(code: &'static str, path: impl Into<String>) -> Self {
        Self {
            code,
            path: path.into(),
        }
    }
}

/// What a check may consult beyond the body and the field tree.
#[derive(Default)]
pub struct VerifyOptions<'a> {
    /// When given, partials are resolved and their bodies walked.
    pub provider: Option<&'a dyn Provider>,
    /// Slots that must be referenced at the payload root; an unused one is a warning.
    pub required_slots: Vec<String>,
    /// Tags the rendered text is contracted to contain, as an opening and a closing form.
    pub required_tags: Vec<String>,
}

/// The context stack: innermost last.
type Stack<'a> = Vec<&'a [PayloadField]>;

/// Check `template` against the payload field tree `fields`.
#[must_use]
pub fn verify(template: &str, fields: &[PayloadField], opts: &VerifyOptions<'_>) -> Vec<Finding> {
    let body = match tags::scan(template) {
        Ok(t) => t,
        Err(e) => return vec![Finding::new(ERR_TEMPLATE_SYNTAX, e.section)],
    };
    let mut walker = Walker {
        provider: opts.provider,
        findings: Vec::new(),
        referenced_at_root: HashSet::new(),
        static_texts: Vec::new(),
    };
    if let Some(at) = delimiter_conflict(&body, None) {
        walker.findings.push(Finding::new(ERR_TEMPLATE_SYNTAX, at));
    }
    walker.static_texts.push(without_comments(template, &body));
    let mut stack: Stack<'_> = vec![fields];
    walker.walk(&body, &mut stack, &[], false);

    let Walker {
        mut findings,
        referenced_at_root,
        static_texts,
        ..
    } = walker;
    findings.extend(slot_and_tag_findings(
        &referenced_at_root,
        &static_texts,
        opts,
    ));
    findings
}

struct Walker<'p> {
    provider: Option<&'p dyn Provider>,
    findings: Vec<Finding>,
    referenced_at_root: HashSet<String>,
    /// The text the output-tag check scans: the body plus every resolved partial body.
    static_texts: Vec<String>,
}

impl Walker<'_> {
    fn note_root(&mut self, stack: &Stack<'_>, name: &str) {
        if stack.len() == 1 {
            let head = name.split('.').next().unwrap_or(name);
            self.referenced_at_root.insert(head.to_string());
        }
    }

    fn walk<'a>(&mut self, tags: &[Tag], stack: &mut Stack<'a>, seen: &[String], positional: bool) {
        let mut i = 0;
        while i < tags.len() {
            let tag = &tags[i];
            match tag.kind {
                TagKind::Name | TagKind::Triple | TagKind::Amp => {
                    if tag.value != "." {
                        self.note_root(stack, &tag.value);
                        if resolve(stack, &tag.value).is_none()
                            && !is_boolean_accessor(stack, &tag.value)
                            && !is_positional_accessor(positional, &tag.value)
                        {
                            self.findings
                                .push(Finding::new(ERR_VAR_NOT_ON_PAYLOAD, tag.value.clone()));
                        }
                    }
                }
                TagKind::Section | TagKind::Inverted => {
                    let close = matching_close(tags, i);
                    let sub = &tags[i + 1..close];
                    self.section(tag, sub, stack, seen, positional);
                    i = close;
                }
                TagKind::Partial => self.partial(&tag.value, stack, seen, positional),
                TagKind::Close | TagKind::Comment | TagKind::Delimiters => {}
            }
            i += 1;
        }
    }

    fn section<'a>(
        &mut self,
        tag: &Tag,
        sub: &[Tag],
        stack: &mut Stack<'a>,
        seen: &[String],
        positional: bool,
    ) {
        let name = tag.value.as_str();
        if name == "." {
            self.walk(sub, stack, seen, positional);
            return;
        }
        self.note_root(stack, name);
        let Some(field) = resolve(stack, name) else {
            // A positional or derived `has<Field>` gate is a boolean on the current scope: it
            // pushes nothing, so the body walks in the same scope. Anything else is drift,
            // and its body is skipped (its context is unknowable).
            if is_positional_accessor(positional, name) || is_boolean_accessor(stack, name) {
                self.walk(sub, stack, seen, positional);
            } else {
                self.findings
                    .push(Finding::new(ERR_VAR_NOT_ON_PAYLOAD, name.to_string()));
            }
            return;
        };
        // `#` over a container pushes its element fields; `^` and a `#` over a scalar keep
        // the current context. Only a `#` over an array moves the positional scope.
        let pushes = tag.kind == TagKind::Section && field.fields.is_some();
        let iterates = tag.kind == TagKind::Section && field.is_array;
        let inner = if iterates {
            field.fields.is_some()
        } else {
            positional
        };
        if let (true, Some(nested)) = (pushes, field.fields.as_deref()) {
            stack.push(nested);
            self.walk(sub, stack, seen, inner);
            stack.pop();
        } else {
            self.walk(sub, stack, seen, inner);
        }
    }

    fn partial<'a>(
        &mut self,
        reference: &str,
        stack: &mut Stack<'a>,
        seen: &[String],
        positional: bool,
    ) {
        let Some(provider) = self.provider else {
            return;
        };
        if seen.iter().any(|s| s == reference) || seen.len() >= MAX_DEPTH {
            return;
        }
        let Some(text) = provider.resolve(reference) else {
            self.findings
                .push(Finding::new(ERR_PARTIAL_UNRESOLVED, reference));
            return;
        };
        if provider.is_jinja(reference) == Some(true) {
            self.findings
                .push(Finding::new(ERR_TEMPLATE_ENGINE_UNSUPPORTED, reference));
            return;
        }
        let parsed = match tags::scan(&text) {
            Ok(t) => t,
            Err(e) => {
                self.findings
                    .push(Finding::new(ERR_TEMPLATE_SYNTAX, e.section));
                return;
            }
        };
        if let Some(at) = delimiter_conflict(&parsed, Some(reference)) {
            self.findings.push(Finding::new(ERR_TEMPLATE_SYNTAX, at));
        }
        self.static_texts.push(without_comments(&text, &parsed));
        let mut chain = seen.to_vec();
        chain.push(reference.to_string());
        self.walk(&parsed, stack, &chain, positional);
    }
}

/// Where a text that changes delimiters cannot render, if it is one. Inlined text is parsed
/// under the surrounding delimiters, so a partial body (`inlined_as` is its reference) that
/// changes them is reported at that reference, and a body that changes them and inlines a
/// partial at its first partial.
fn delimiter_conflict(tags: &[Tag], inlined_as: Option<&str>) -> Option<String> {
    if !tags.iter().any(|t| t.kind == TagKind::Delimiters) {
        return None;
    }
    inlined_as.map(str::to_string).or_else(|| {
        tags.iter()
            .find(|t| t.kind == TagKind::Partial)
            .map(|t| t.value.clone())
    })
}

/// `text` with its comments cut out: what a tag-presence check may scan.
fn without_comments(text: &str, tags: &[Tag]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    for tag in tags.iter().filter(|t| t.kind == TagKind::Comment) {
        out.push_str(&text[pos..tag.start]);
        pos = tag.end;
    }
    out.push_str(&text[pos..]);
    out
}

fn find_field<'a>(fields: &'a [PayloadField], name: &str) -> Option<&'a PayloadField> {
    fields.iter().find(|f| f.name == name)
}

/// Resolve a (possibly dotted) path the way Mustache does: the first segment through the
/// stack, innermost first, each later one a direct descent into the resolved field.
fn resolve<'a>(stack: &Stack<'a>, path: &str) -> Option<&'a PayloadField> {
    let mut segments = path.split('.');
    let head = segments.next()?;
    let mut current = stack
        .iter()
        .rev()
        .find_map(|frame| find_field(frame, head))?;
    for segment in segments {
        current = find_field(current.fields.as_deref()?, segment)?;
    }
    Some(current)
}

/// `has<Field>` over a field reachable on the stack. Acceptance keys off the field existing,
/// not its type, as in every port.
fn is_boolean_accessor(stack: &Stack<'_>, name: &str) -> bool {
    !name.contains('.')
        && name.starts_with(HAS_PREFIX)
        && stack
            .iter()
            .any(|frame| frame.iter().any(|f| has_accessor_name(&f.name) == name))
}

/// `-last`, available when the innermost enclosing array section iterates objects.
fn is_positional_accessor(positional: bool, name: &str) -> bool {
    positional && name == LAST_ACCESSOR
}

/// An opening tag is `<tag` followed by `>` or XML whitespace (attributes allowed); a longer
/// name (`<answers>` for `answer`) does not count.
fn has_open_tag(text: &str, tag: &str) -> bool {
    let needle = format!("<{tag}");
    text.match_indices(&needle).any(|(i, _)| {
        text[i + needle.len()..]
            .chars()
            .next()
            .is_some_and(|c| matches!(c, '>' | ' ' | '\t' | '\n' | '\r'))
    })
}

/// A closing tag is the exact literal `</tag>`; a self-closing form never satisfies one.
fn has_close_tag(text: &str, tag: &str) -> bool {
    text.contains(&format!("</{tag}>"))
}

fn slot_and_tag_findings(
    referenced_at_root: &HashSet<String>,
    static_texts: &[String],
    opts: &VerifyOptions<'_>,
) -> Vec<Finding> {
    let mut out: Vec<Finding> = opts
        .required_slots
        .iter()
        .filter(|slot| !referenced_at_root.contains(*slot))
        .map(|slot| Finding::new(ERR_REQUIRED_SLOT_UNUSED, slot.clone()))
        .collect();
    // Body and partials scan as one string: a tag may straddle the boundary, and the newline
    // only stops a tag being spliced together from two fragments.
    let haystack = static_texts.join("\n");
    out.extend(
        opts.required_tags
            .iter()
            .filter(|tag| !has_open_tag(&haystack, tag) || !has_close_tag(&haystack, tag))
            .map(|tag| Finding::new(ERR_OUTPUT_TAG_MISSING, tag.clone())),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(template: &str, fields: &[PayloadField]) -> Vec<(&'static str, String)> {
        verify(template, fields, &VerifyOptions::default())
            .into_iter()
            .map(|f| (f.code, f.path))
            .collect()
    }

    #[test]
    fn a_renamed_field_is_drift_and_a_present_one_is_not() {
        let fields = [PayloadField::scalar("name")];
        assert!(codes("Hi {{name}}", &fields).is_empty());
        assert_eq!(
            codes("Hi {{nmae}}", &fields),
            vec![(ERR_VAR_NOT_ON_PAYLOAD, "nmae".to_string())]
        );
    }

    #[test]
    fn an_unbalanced_section_is_a_syntax_finding_alone() {
        let fields = [PayloadField::scalar("a")];
        assert_eq!(
            codes("{{#a}}{{missing}}", &fields),
            vec![(ERR_TEMPLATE_SYNTAX, "a".to_string())]
        );
    }

    #[test]
    fn required_tags_need_both_forms_and_an_exact_name() {
        assert!(has_open_tag("<answer foo=\"1\">x</answer>", "answer"));
        assert!(!has_open_tag("<answers>", "answer"));
        assert!(!has_close_tag("<answer/>", "answer"));
    }
}
