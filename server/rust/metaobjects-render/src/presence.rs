//! A template variable missing from the payload fails the render (`ERR_VAR_NOT_ON_PAYLOAD`).
//!
//! The engine renders an absent name as empty text, so a typo (`{{nmae}}`) or a payload
//! field that was renamed would ship a prompt with a silent hole in it. Every port refuses
//! that instead, with one message. This walk runs ahead of the engine, over the template
//! with its partials already expanded, and follows the same rules as the reference (the
//! TypeScript renderer's check on mustache.js's context lookup):
//!
//! - Only interpolations are checked (`{{x}}`, `{{{x}}}`, `{{&x}}`). A section or inverted
//!   section over an absent name is legal and is simply falsy.
//! - A name resolves against the context stack from the innermost context outwards. A
//!   dotted name is tried whole against each context in turn, and is present when its last
//!   segment exists on the value its leading segments reach.
//! - A `null` value is present (it renders empty). `.` is always present.
//! - Only what would render is checked: the body of a falsy section and of a truthy
//!   inverted section is skipped, and a list section checks its body once per element.

use serde_json::Value;

use crate::tags::{Tag, TagKind};

/// The error code every port raises for a variable that is not on the payload.
pub const ERR_VAR_NOT_ON_PAYLOAD: &str = "ERR_VAR_NOT_ON_PAYLOAD";

/// The current-context name.
const IMPLICIT_ITERATOR: &str = ".";

/// The first interpolated name in `tags` that the payload does not carry, if any.
#[must_use]
pub fn first_missing(tags: &[Tag], payload: &Value) -> Option<String> {
    let mut stack = vec![payload];
    walk(tags, &mut stack)
}

fn walk<'a>(tags: &[Tag], stack: &mut Vec<&'a Value>) -> Option<String> {
    let mut i = 0;
    while i < tags.len() {
        let tag = &tags[i];
        match tag.kind {
            TagKind::Name | TagKind::Triple | TagKind::Amp => {
                if lookup(&tag.value, stack).is_none() {
                    return Some(tag.value.clone());
                }
            }
            TagKind::Section | TagKind::Inverted => {
                let close = matching_close(tags, i);
                let body = &tags[i + 1..close];
                let value = lookup(&tag.value, stack);
                let truthy = value.is_some_and(is_truthy);
                if tag.kind == TagKind::Inverted {
                    let missing = if truthy { None } else { walk(body, stack) };
                    if missing.is_some() {
                        return missing;
                    }
                } else if let Some(value) = value.filter(|v| is_truthy(v)) {
                    let contexts: Vec<&'a Value> = match value {
                        Value::Array(items) => items.iter().collect(),
                        other => vec![other],
                    };
                    for context in contexts {
                        stack.push(context);
                        let missing = walk(body, stack);
                        stack.pop();
                        if missing.is_some() {
                            return missing;
                        }
                    }
                }
                i = close;
            }
            TagKind::Close | TagKind::Partial | TagKind::Comment | TagKind::Delimiters => {}
        }
        i += 1;
    }
    None
}

/// The index of the close tag that ends the section opened at `open`. The scanner has
/// already refused unbalanced sections, so a close always exists; the end of the list is
/// the fallback.
fn matching_close(tags: &[Tag], open: usize) -> usize {
    let mut depth = 0usize;
    for (offset, tag) in tags[open + 1..].iter().enumerate() {
        match tag.kind {
            TagKind::Section | TagKind::Inverted => depth += 1,
            TagKind::Close if depth == 0 => return open + 1 + offset,
            TagKind::Close => depth -= 1,
            _ => {}
        }
    }
    tags.len()
}

/// `name` resolved against the context stack, innermost first. `None` means absent.
fn lookup<'a>(name: &str, stack: &[&'a Value]) -> Option<&'a Value> {
    if name == IMPLICIT_ITERATOR {
        return stack.last().copied();
    }
    let segments: Vec<&str> = name.split('.').collect();
    stack
        .iter()
        .rev()
        .find_map(|context| resolve(context, &segments))
}

fn resolve<'a>(context: &'a Value, segments: &[&str]) -> Option<&'a Value> {
    segments
        .iter()
        .try_fold(context, |value, segment| property(value, segment))
}

/// One property of a JSON value, as a JavaScript property read would find it: an object's
/// key, or a list's index.
fn property<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(key),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    }
}

/// Mustache truthiness as the reference engine reads it: `false`, `null`, `0`, `""` and an
/// empty list are falsy.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::first_missing;
    use crate::tags::scan;

    fn missing(template: &str, payload: &serde_json::Value) -> Option<String> {
        first_missing(&scan(template).expect("scan"), payload)
    }

    #[test]
    fn absent_names_are_reported_and_present_ones_are_not() {
        let payload =
            json!({ "name": "Ada", "note": null, "user": { "profile": { "name": "Ada" } } });
        assert_eq!(missing("Hi {{nmae}}", &payload), Some("nmae".to_string()));
        assert_eq!(missing("{{{name}}} {{&note}} {{.}}", &payload), None);
        assert_eq!(missing("{{user.profile.name}}", &payload), None);
        assert_eq!(
            missing("{{user.profile.email}}", &payload),
            Some("user.profile.email".to_string())
        );
    }

    #[test]
    fn sections_over_absent_names_are_legal_and_skip_their_body() {
        let payload = json!({ "flag": false, "items": [] });
        assert_eq!(missing("{{#nope}}{{gone}}{{/nope}}", &payload), None);
        assert_eq!(missing("{{#flag}}{{gone}}{{/flag}}", &payload), None);
        assert_eq!(missing("{{#items}}{{gone}}{{/items}}", &payload), None);
        assert_eq!(
            missing("{{^nope}}{{gone}}{{/nope}}", &payload),
            Some("gone".to_string())
        );
    }

    #[test]
    fn list_elements_and_outer_contexts_both_resolve() {
        let payload = json!({ "title": "T", "items": [{ "name": "a" }, { "other": 1 }] });
        assert_eq!(missing("{{#items}}{{title}}{{/items}}", &payload), None);
        assert_eq!(
            missing("{{#items}}{{name}}{{/items}}", &payload),
            Some("name".to_string())
        );
    }
}
