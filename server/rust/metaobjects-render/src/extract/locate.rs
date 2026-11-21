//! Stages 2 and 3: isolate the payload span. Mirrors `locate.py`.

use super::json_reader::comment_end;
use super::xml_reader::mask_non_markup;

/// The first balanced `{...}`; when none closes, the first `{` to the end; `None` when
/// there is no `{`.
#[must_use]
pub fn json(text: &str) -> Option<String> {
    let s: Vec<char> = text.chars().collect();
    let mut first_open = None;
    for i in 0..s.len() {
        if s[i] == '{' {
            first_open.get_or_insert(i);
            if let Some(end) = scan_balanced(&s, i) {
                return Some(s[i..=end].iter().collect());
            }
        }
    }
    first_open.map(|i| s[i..].iter().collect())
}

/// Every top-level object span in `text`, in order: each balanced `{...}`, and, for a `{`
/// that never closes, the text from it to the end.
#[must_use]
pub fn json_candidates(text: &str) -> Vec<String> {
    let s: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut tail_added = false;
    let mut i = 0;
    while i < s.len() {
        if s[i] == '{' {
            match scan_balanced(&s, i) {
                Some(end) => {
                    out.push(s[i..=end].iter().collect());
                    i = end;
                }
                None if !tail_added => {
                    out.push(s[i..].iter().collect());
                    tail_added = true;
                }
                None => {}
            }
        }
        i += 1;
    }
    out
}

/// The index of the `}` matching the `{` at `open`. String-aware, and comment-aware: a
/// comment opening after whitespace or a separator is skipped (`http://x` is not one).
fn scan_balanced(s: &[char], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    let mut i = open;
    while i < s.len() {
        let c = s[i];
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if i > open
            && (s[i - 1].is_whitespace() || matches!(s[i - 1], ',' | '{' | '['))
            && let Some(end) = comment_end(s, i)
        {
            i = end;
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The span of `<root>...</root>`; when the close is absent, the opener to the end; `None`
/// when there is no opener. Comments and CDATA are not searched, and when another opener of
/// the same root sits between the first and its close, the span starts at the last one: a
/// root does not nest in itself.
#[must_use]
pub fn xml(text: &str, root: &str, ci: bool) -> Option<String> {
    let view = mask_non_markup(text);
    let (open_start, open_end) = find_root_open(&view, root, ci, 0)?;
    let Some(close_end) = find_root_close(&view, root, ci, open_end) else {
        return Some(text[open_start..].to_string());
    };
    let close_start = close_end.0;
    let mut start = open_start;
    let mut at = open_end;
    while let Some((s, e)) = find_root_open(&view, root, ci, at) {
        if s >= close_start {
            break;
        }
        start = s;
        at = e;
    }
    Some(text[start..close_end.1].to_string())
}

fn name_at(s: &str, at: usize, name: &str, ci: bool) -> bool {
    s.get(at..at + name.len()).is_some_and(|got| {
        if ci {
            got.eq_ignore_ascii_case(name)
        } else {
            got == name
        }
    })
}

/// `<root(\s[^>]*)?>` from `from`, as `(start, end)`.
fn find_root_open(s: &str, root: &str, ci: bool, from: usize) -> Option<(usize, usize)> {
    let mut at = from;
    while let Some(rel) = s.get(at..)?.find('<') {
        let i = at + rel;
        if name_at(s, i + 1, root, ci) {
            let after = i + 1 + root.len();
            let rest = &s[after..];
            if rest.starts_with('>') {
                return Some((i, after + 1));
            }
            if rest.chars().next().is_some_and(char::is_whitespace)
                && let Some(gt) = rest.find('>')
            {
                return Some((i, after + gt + 1));
            }
        }
        at = i + 1;
    }
    None
}

/// `</root\s*>` from `from`, as `(start, end)`.
fn find_root_close(s: &str, root: &str, ci: bool, from: usize) -> Option<(usize, usize)> {
    let mut at = from;
    while let Some(rel) = s.get(at..)?.find("</") {
        let i = at + rel;
        if name_at(s, i + 2, root, ci) {
            let after = i + 2 + root.len();
            let rest = &s[after..];
            let trimmed = rest.trim_start();
            if trimmed.starts_with('>') {
                return Some((i, after + (rest.len() - trimmed.len()) + 1));
            }
        }
        at = i + 2;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_spans() {
        assert_eq!(
            json("pre {\"a\":{\"b\":1}} post").unwrap(),
            "{\"a\":{\"b\":1}}"
        );
        assert_eq!(json("x {\"a\":1").unwrap(), "{\"a\":1");
        assert!(json("none").is_none());
        assert_eq!(
            json_candidates("{a} {b"),
            vec!["{a}".to_string(), "{b".to_string()]
        );
    }

    #[test]
    fn xml_span_takes_the_last_opener() {
        assert_eq!(
            xml("use <doc> then <doc a=\"1\"><x/></doc>", "doc", true).unwrap(),
            "<doc a=\"1\"><x/></doc>"
        );
    }
}
