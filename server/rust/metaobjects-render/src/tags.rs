//! One Mustache tag scanner, shared by partial expansion and the escaping rewrite.
//!
//! It follows the Mustache spec where finding a tag needs it: a comment ends at the first
//! closing delimiter, `{{=<% %>=}}` changes the delimiters, and a section close must name
//! the section it closes. Mirrors `mustache_tags.py` in the Python port and `MustacheTags`
//! in the C# and Java ports.

use std::fmt;

const DEFAULT_OPEN: &str = "{{";
const DEFAULT_CLOSE: &str = "}}";

/// What a tag is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagKind {
    /// `{{x}}`: an escaped interpolation.
    Name,
    /// `{{{x}}}`: a raw interpolation.
    Triple,
    /// `{{&x}}`: a raw interpolation.
    Amp,
    /// `{{#x}}`
    Section,
    /// `{{^x}}`
    Inverted,
    /// `{{/x}}`
    Close,
    /// `{{>x}}`
    Partial,
    /// `{{!x}}`
    Comment,
    /// `{{=<% %>=}}`
    Delimiters,
}

/// One tag: its kind, its trimmed name, and its `[start, end)` byte span in the text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub kind: TagKind,
    pub value: String,
    pub start: usize,
    pub end: usize,
}

/// An unbalanced section. `section` is the section the finding is about: the unopened
/// close's name, or the section left open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    pub message: String,
    pub section: String,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SyntaxError {}

/// Every tag in `text`, in order, honouring comments and delimiter changes.
///
/// # Errors
/// A close with no open, a close naming a different section than the one open, or a
/// section never closed. An unterminated tag ends the scan (the rest is text).
pub fn scan(text: &str) -> Result<Vec<Tag>, SyntaxError> {
    let mut tags = Vec::new();
    let mut open_delim = DEFAULT_OPEN.to_string();
    let mut close_delim = DEFAULT_CLOSE.to_string();
    let mut open_sections: Vec<String> = Vec::new();
    let mut pos = 0;
    while pos < text.len() {
        let Some(found) = text[pos..].find(open_delim.as_str()) else {
            break;
        };
        let start = pos + found;
        let mut content_start = start + open_delim.len();
        let triple = text[content_start..].starts_with('{');
        let end_delim = if triple {
            format!("}}{close_delim}")
        } else {
            close_delim.clone()
        };
        if triple {
            content_start += 1;
        }
        let Some(close_rel) = text[content_start..].find(end_delim.as_str()) else {
            break;
        };
        let close = content_start + close_rel;
        let content = text[content_start..close].trim();
        let end = close + end_delim.len();
        pos = end;

        let push = |tags: &mut Vec<Tag>, kind: TagKind, value: &str| {
            tags.push(Tag {
                kind,
                value: value.to_string(),
                start,
                end,
            });
        };
        if triple {
            push(&mut tags, TagKind::Triple, content);
            continue;
        }
        let Some(sigil) = content.chars().next() else {
            continue;
        };
        let name = content[sigil.len_utf8()..].trim();
        match sigil {
            '!' => push(&mut tags, TagKind::Comment, name),
            '=' => {
                if let Some(inner) = content[1..].strip_suffix('=') {
                    let parts: Vec<&str> = inner.split_whitespace().collect();
                    if let [o, c] = parts.as_slice() {
                        open_delim = (*o).to_string();
                        close_delim = (*c).to_string();
                    }
                }
                push(&mut tags, TagKind::Delimiters, name);
            }
            '#' | '^' => {
                open_sections.push(name.to_string());
                let kind = if sigil == '#' {
                    TagKind::Section
                } else {
                    TagKind::Inverted
                };
                push(&mut tags, kind, name);
            }
            '/' => {
                let Some(opened) = open_sections.pop() else {
                    return Err(SyntaxError {
                        message: format!("Unopened section \"{name}\""),
                        section: name.to_string(),
                    });
                };
                if opened != name {
                    return Err(SyntaxError {
                        message: format!("Unclosed section \"{opened}\""),
                        section: opened,
                    });
                }
                push(&mut tags, TagKind::Close, name);
            }
            '>' => push(&mut tags, TagKind::Partial, name),
            '&' => push(&mut tags, TagKind::Amp, name),
            _ => push(&mut tags, TagKind::Name, content),
        }
    }
    if let Some(opened) = open_sections.pop() {
        return Err(SyntaxError {
            message: format!("Unclosed section \"{opened}\""),
            section: opened,
        });
    }
    Ok(tags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(text: &str) -> Vec<(TagKind, String)> {
        scan(text)
            .unwrap()
            .into_iter()
            .map(|t| (t.kind, t.value))
            .collect()
    }

    #[test]
    fn finds_every_kind() {
        let k = kinds("{{a}}{{{b}}}{{&c}}{{#d}}{{/d}}{{^e}}{{/e}}{{> p }}{{! note }}");
        assert_eq!(
            k,
            vec![
                (TagKind::Name, "a".into()),
                (TagKind::Triple, "b".into()),
                (TagKind::Amp, "c".into()),
                (TagKind::Section, "d".into()),
                (TagKind::Close, "d".into()),
                (TagKind::Inverted, "e".into()),
                (TagKind::Close, "e".into()),
                (TagKind::Partial, "p".into()),
                (TagKind::Comment, "note".into()),
            ]
        );
    }

    #[test]
    fn a_comment_hides_the_partial_inside_it() {
        assert_eq!(
            kinds("{{! see {{> p}} }}"),
            vec![(TagKind::Comment, "see {{> p".into())]
        );
    }

    #[test]
    fn mismatched_close_is_an_error() {
        let err = scan("{{#a}}{{/b}}").unwrap_err();
        assert_eq!(err.section, "a");
        assert!(scan("{{/a}}").is_err());
        assert!(scan("{{#a}}").is_err());
    }

    #[test]
    fn delimiter_change_is_followed() {
        let k = kinds("{{=<% %>=}}<% a %>");
        assert_eq!(k[1], (TagKind::Name, "a".into()));
    }
}
