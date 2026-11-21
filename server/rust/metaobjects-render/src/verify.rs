//! The template drift check (FR-004): every variable, section and partial of a Mustache
//! body checked against the declared field tree of its payload, so a renamed field fails
//! the build instead of silently degrading a prompt.
//!
//! It reads tag structure only, through the same scanner the renderer uses ([`crate::tags`]),
//! so the check and the render cannot disagree about where a tag is. The shared
//! `fixtures/verify-conformance/` corpus holds it to the other ports.

use std::borrow::Cow;
use std::collections::HashSet;

use crate::accessors::{HAS_PREFIX, LAST_ACCESSOR, has_accessor_name};
use crate::render::{MAX_DEPTH, Provider};
use crate::tags::{Tag, TagKind, scan};

/// A `{{var}}` names a field the payload (in that context) does not declare.
pub const ERR_VAR_NOT_ON_PAYLOAD: &str = "ERR_VAR_NOT_ON_PAYLOAD";
/// A `{{> ref}}` partial does not resolve in the provider.
pub const ERR_PARTIAL_UNRESOLVED: &str = "ERR_PARTIAL_UNRESOLVED";
/// A declared `@requiredSlots` slot is never referenced (a warning).
pub const ERR_REQUIRED_SLOT_UNUSED: &str = "ERR_REQUIRED_SLOT_UNUSED";
/// A declared `@requiredTags` output tag is missing from the body.
pub const ERR_OUTPUT_TAG_MISSING: &str = "ERR_OUTPUT_TAG_MISSING";
/// The body does not parse, or uses a construct the Rust renderer refuses.
pub const ERR_TEMPLATE_SYNTAX: &str = "ERR_TEMPLATE_SYNTAX";
/// A partial is written for an engine the Rust port does not run (Jinja).
pub const ERR_TEMPLATE_ENGINE_UNSUPPORTED: &str = "ERR_TEMPLATE_ENGINE_UNSUPPORTED";

/// One node of a payload's field tree. `fields` is `Some` for a field that pushes a
/// context (an object, or an array of objects) and `None` for a scalar or scalar array;
/// `is_array` is the field's effective array-ness. Together they decide whether `-last`
/// is available inside a section over the field.
///
/// The `const` constructors build a tree a generated render helper keeps as a `static`;
/// [`PayloadField::owned`] builds one at run time.
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
}

/// One finding: a code and the variable path, partial ref, slot or tag it is about.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct VerifyError {
    pub code: String,
    pub path: String,
}

impl VerifyError {
    fn new(code: &str, path: &str) -> Self {
        Self {
            code: code.to_string(),
            path: path.to_string(),
        }
    }
}

/// What to check besides the references: the partial provider (without one, partials are
/// not followed), the slots that must be referenced at the payload root, and the output
/// tags that must appear open and closed.
#[derive(Default)]
pub struct VerifyOptions<'a> {
    pub provider: Option<&'a dyn Provider>,
    pub required_slots: &'a [String],
    pub required_tags: &'a [String],
}

enum Token {
    Var(String),
    Section {
        name: String,
        inverted: bool,
        children: Vec<Token>,
    },
    Partial(String),
}

fn tree(tags: &[Tag]) -> Vec<Token> {
    fn build(tags: &[Tag], at: &mut usize) -> Vec<Token> {
        let mut out = Vec::new();
        while *at < tags.len() {
            let t = &tags[*at];
            *at += 1;
            match t.kind {
                TagKind::Section | TagKind::Inverted => {
                    let children = build(tags, at);
                    out.push(Token::Section {
                        name: t.value.clone(),
                        inverted: t.kind == TagKind::Inverted,
                        children,
                    });
                }
                // The scanner already matched every close to its open.
                TagKind::Close => return out,
                TagKind::Partial => out.push(Token::Partial(t.value.clone())),
                TagKind::Name | TagKind::Triple | TagKind::Amp => {
                    out.push(Token::Var(t.value.clone()));
                }
                TagKind::Comment | TagKind::Delimiters => {}
            }
        }
        out
    }
    build(tags, &mut 0)
}

/// The text of the first delimiter change (`<% %>`), if any.
fn delimiter_change(tags: &[Tag]) -> Option<String> {
    tags.iter()
        .find(|t| t.kind == TagKind::Delimiters)
        .map(|t| {
            t.value
                .strip_suffix('=')
                .unwrap_or(&t.value)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        })
}

/// The Rust renderer refuses every delimiter change, so the check reports each: at the
/// partial ref for a partial's body, at the first partial of a body that inlines one, and
/// otherwise at the delimiters themselves.
fn delimiter_errors(tags: &[Tag], inlined_as: Option<&str>) -> Option<VerifyError> {
    let change = delimiter_change(tags)?;
    let first_partial = tags.iter().find(|t| t.kind == TagKind::Partial);
    let path = inlined_as
        .map(str::to_string)
        .or_else(|| first_partial.map(|t| t.value.clone()))
        .unwrap_or(change);
    Some(VerifyError::new(ERR_TEMPLATE_SYNTAX, &path))
}

fn without_comments(text: &str, tags: &[Tag]) -> String {
    let mut out = String::new();
    let mut pos = 0;
    for t in tags.iter().filter(|t| t.kind == TagKind::Comment) {
        out.push_str(&text[pos..t.start]);
        pos = t.end;
    }
    out.push_str(&text[pos..]);
    out
}

/// Resolve a dotted path as Mustache does: the first segment through the context stack,
/// innermost first; each later segment inside the field found.
fn resolve<'a>(stack: &[&'a [PayloadField]], path: &str) -> Option<&'a PayloadField> {
    let mut segs = path.split('.');
    let head = segs.next()?;
    let mut current = stack
        .iter()
        .rev()
        .find_map(|level| level.iter().find(|f| f.name == head))?;
    for seg in segs {
        current = current.fields.as_deref()?.iter().find(|f| f.name == seg)?;
    }
    Some(current)
}

/// A derived `has<Field>` over a field reachable on the stack. It keys off the field
/// existing, not its type, as in every port.
fn is_boolean_accessor(stack: &[&[PayloadField]], name: &str) -> bool {
    !name.contains('.')
        && name.starts_with(HAS_PREFIX)
        && stack
            .iter()
            .rev()
            .any(|level| level.iter().any(|f| has_accessor_name(&f.name) == name))
}

fn is_positional_accessor(in_element: bool, name: &str) -> bool {
    in_element && name == LAST_ACCESSOR
}

struct Walk<'a> {
    provider: Option<&'a dyn Provider>,
    errors: Vec<VerifyError>,
    referenced_at_root: HashSet<String>,
    static_texts: Vec<String>,
}

impl Walk<'_> {
    fn walk(
        &mut self,
        tokens: &[Token],
        stack: &[&[PayloadField]],
        seen: &[String],
        in_element: bool,
    ) {
        let at_root = stack.len() == 1;
        for tok in tokens {
            match tok {
                Token::Var(v) => {
                    if v == "." {
                        continue;
                    }
                    if at_root {
                        self.note_root(v);
                    }
                    if resolve(stack, v).is_none()
                        && !is_boolean_accessor(stack, v)
                        && !is_positional_accessor(in_element, v)
                    {
                        self.errors
                            .push(VerifyError::new(ERR_VAR_NOT_ON_PAYLOAD, v));
                    }
                }
                Token::Section {
                    name,
                    inverted,
                    children,
                } => {
                    if name == "." {
                        self.walk(children, stack, seen, in_element);
                        continue;
                    }
                    if at_root {
                        self.note_root(name);
                    }
                    let Some(field) = resolve(stack, name) else {
                        // A -last or has<Field> gate is a boolean: it pushes nothing, so
                        // its body walks in the same scope. Any other unresolved head is
                        // drift, and its body is skipped: its context is unknowable.
                        if is_positional_accessor(in_element, name)
                            || is_boolean_accessor(stack, name)
                        {
                            self.walk(children, stack, seen, in_element);
                        } else {
                            self.errors
                                .push(VerifyError::new(ERR_VAR_NOT_ON_PAYLOAD, name));
                        }
                        continue;
                    };
                    if *inverted {
                        self.walk(children, stack, seen, in_element);
                        continue;
                    }
                    // An array section decides -last itself (only object elements carry
                    // it); any other section inherits the enclosing answer.
                    let next = if field.is_array {
                        field.fields.is_some()
                    } else {
                        in_element
                    };
                    match field.fields.as_deref() {
                        Some(inner) => {
                            let mut pushed = stack.to_vec();
                            pushed.push(inner);
                            self.walk(children, &pushed, seen, next);
                        }
                        None => self.walk(children, stack, seen, next),
                    }
                }
                Token::Partial(r) => self.partial(r, stack, seen, in_element),
            }
        }
    }

    fn note_root(&mut self, path: &str) {
        let head = path.split('.').next().unwrap_or(path);
        self.referenced_at_root.insert(head.to_string());
    }

    fn partial(&mut self, r: &str, stack: &[&[PayloadField]], seen: &[String], in_element: bool) {
        let Some(provider) = self.provider else {
            return;
        };
        if seen.iter().any(|s| s == r) || seen.len() >= MAX_DEPTH {
            return;
        }
        if r.ends_with(".jinja") || r.ends_with(".j2") {
            self.errors
                .push(VerifyError::new(ERR_TEMPLATE_ENGINE_UNSUPPORTED, r));
            return;
        }
        let Some(body) = provider.resolve(r) else {
            self.errors
                .push(VerifyError::new(ERR_PARTIAL_UNRESOLVED, r));
            return;
        };
        let tags = match scan(&body) {
            Ok(t) => t,
            Err(e) => {
                self.errors
                    .push(VerifyError::new(ERR_TEMPLATE_SYNTAX, &e.section));
                return;
            }
        };
        self.errors.extend(delimiter_errors(&tags, Some(r)));
        self.static_texts.push(without_comments(&body, &tags));
        let mut next_seen = seen.to_vec();
        next_seen.push(r.to_string());
        self.walk(&tree(&tags), stack, &next_seen, in_element);
    }
}

/// Check `template` against the payload field tree. Findings come back in walk order.
#[must_use]
pub fn verify(
    template: &str,
    fields: &[PayloadField],
    opts: &VerifyOptions<'_>,
) -> Vec<VerifyError> {
    let tags = match scan(template) {
        Ok(t) => t,
        Err(e) => return vec![VerifyError::new(ERR_TEMPLATE_SYNTAX, &e.section)],
    };
    let mut w = Walk {
        provider: opts.provider,
        errors: delimiter_errors(&tags, None).into_iter().collect(),
        referenced_at_root: HashSet::new(),
        static_texts: vec![without_comments(template, &tags)],
    };
    w.walk(&tree(&tags), &[fields], &[], false);

    for slot in opts.required_slots {
        if !w.referenced_at_root.contains(slot) {
            w.errors
                .push(VerifyError::new(ERR_REQUIRED_SLOT_UNUSED, slot));
        }
    }
    if !opts.required_tags.is_empty() {
        // One joined haystack: a tag may open in the body and close in a partial. The
        // newline keeps two fragments from splicing into a tag neither holds.
        let haystack = w.static_texts.join("\n");
        for tag in opts.required_tags {
            if !has_open_tag(&haystack, tag) || !haystack.contains(&format!("</{tag}>")) {
                w.errors.push(VerifyError::new(ERR_OUTPUT_TAG_MISSING, tag));
            }
        }
    }
    w.errors
}

/// `<tag` followed by `>` or XML whitespace: attributes allowed, a longer name not matched.
/// A self-closing `<tag/>` never satisfies a required tag, since it wraps nothing.
fn has_open_tag(text: &str, tag: &str) -> bool {
    let needle = format!("<{tag}");
    text.match_indices(&needle).any(|(i, _)| {
        matches!(
            text[i + needle.len()..].chars().next(),
            Some('>' | ' ' | '\t' | '\n' | '\r')
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_renamed_field_is_drift() {
        let fields = [PayloadField::scalar("displayName")];
        let opts = VerifyOptions::default();
        assert!(verify("{{displayName}}", &fields, &opts).is_empty());
        assert_eq!(
            verify("{{name}}", &fields, &opts),
            vec![VerifyError::new(ERR_VAR_NOT_ON_PAYLOAD, "name")]
        );
    }
}
