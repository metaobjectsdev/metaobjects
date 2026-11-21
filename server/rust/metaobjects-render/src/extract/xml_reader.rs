//! Stage 4: the tolerant XML reader for the bounded malformation set. Never fails.
//!
//! An element's child elements, text and attributes map into the field map:
//!
//! - a text-only element with no attributes is its trimmed text;
//! - a self-closing or attributes-only element is a map of its attributes;
//! - an element with child elements is a map of its attributes plus its children (a child
//!   wins a name collision), with its own text, if any, under [`TEXT_KEY`];
//! - an element with text and attributes is the attributes plus the text under [`TEXT_KEY`];
//! - repeated sibling tags are a list.
//!
//! Mirrors `xml_forgiving_reader.py` and the Java `XmlForgivingReader`. The tag patterns are
//! matched by hand; each function names the pattern it implements.

use indexmap::IndexMap;

use super::json_reader::Raw;

/// The key holding an element's own text when the element is a map. `#` is not a legal
/// XML name character, so it never collides with an attribute or a child.
pub const TEXT_KEY: &str = "#text";

const COMMENT_OPEN: &str = "<!--";
const COMMENT_CLOSE: &str = "-->";
const CDATA_OPEN: &str = "<![CDATA[";
const CDATA_CLOSE: &str = "]]>";

/// Deepest element nesting the reader follows; below it the content is text, as in the JSON
/// reader, so a runaway reply cannot overflow the stack.
const MAX_DEPTH: usize = 100;

fn is_name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// An open tag: `<([A-Za-z_][A-Za-z0-9_]*)([^>]*?)>`.
struct OpenTag {
    start: usize,
    end: usize,
    name: (usize, usize),
    attrs: (usize, usize),
}

fn find_open_tag(s: &str, from: usize) -> Option<OpenTag> {
    let b = s.as_bytes();
    let mut i = from;
    while i < b.len() {
        if b[i] == b'<' && i + 1 < b.len() && is_name_start(b[i + 1]) {
            let mut j = i + 2;
            while j < b.len() && is_name_char(b[j]) {
                j += 1;
            }
            let gt = s[j..].find('>')? + j;
            return Some(OpenTag {
                start: i,
                end: gt + 1,
                name: (i + 1, j),
                attrs: (j, gt),
            });
        }
        i += 1;
    }
    None
}

/// The length of `\s*>` at `at`, if there is one.
fn ws_then_gt(s: &str, at: usize) -> Option<usize> {
    let rest = &s[at..];
    let trimmed = rest.trim_start();
    trimmed
        .starts_with('>')
        .then(|| rest.len() - trimmed.len() + 1)
}

/// Any close tag in `s[from..to]`: `</([A-Za-z_][A-Za-z0-9_]*)\s*>`, as `(start, end, name)`.
fn find_any_close(s: &str, from: usize, to: usize) -> Option<(usize, usize, String)> {
    let s = &s[..to];
    let b = s.as_bytes();
    let mut i = from;
    while i + 2 < b.len() {
        if b[i] == b'<' && b[i + 1] == b'/' && is_name_start(b[i + 2]) {
            let mut j = i + 3;
            while j < b.len() && is_name_char(b[j]) {
                j += 1;
            }
            if let Some(n) = ws_then_gt(s, j) {
                return Some((i, j + n, s[i + 2..j].to_string()));
            }
        }
        i += 1;
    }
    None
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

/// The close tag of `name`, from `from`: `</name\s*>`.
fn find_named_close(s: &str, from: usize, name: &str, ci: bool) -> Option<(usize, usize)> {
    let mut at = from;
    while let Some(rel) = s[at..].find("</") {
        let i = at + rel;
        if name_at(s, i + 2, name, ci)
            && let Some(n) = ws_then_gt(s, i + 2 + name.len())
        {
            return Some((i, i + 2 + name.len() + n));
        }
        at = i + 2;
    }
    None
}

/// Is there an open tag of `name` in `s[from..to]`: `<name(?=[\s/>])`?
fn has_named_open(s: &str, from: usize, to: usize, name: &str, ci: bool) -> bool {
    let s = &s[..to];
    let mut at = from;
    while let Some(rel) = s[at..].find('<') {
        let i = at + rel;
        if name_at(s, i + 1, name, ci) {
            let next = s[i + 1 + name.len()..].chars().next();
            if next.is_some_and(|c| c.is_whitespace() || c == '/' || c == '>') {
                return true;
            }
        }
        at = i + 1;
    }
    false
}

/// Rewrite every comment and CDATA section through `replace(is_comment, region)`, scanning
/// left to right so a comment marker inside CDATA (or the reverse) is not markup. An
/// unclosed comment stays text; an unclosed CDATA section runs to the end.
fn rewrite_regions(text: &str, replace: impl Fn(bool, &str) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    let mut from = 0;
    loop {
        let c = text[from..].find(COMMENT_OPEN).map(|x| x + from);
        let d = text[from..].find(CDATA_OPEN).map(|x| x + from);
        let is_comment = match (c, d) {
            (Some(c), Some(d)) => c < d,
            (Some(_), None) => true,
            _ => false,
        };
        let Some(start) = (if is_comment { c } else { d }) else {
            break;
        };
        let end = if is_comment {
            match text[start + COMMENT_OPEN.len()..].find(COMMENT_CLOSE) {
                Some(e) => start + COMMENT_OPEN.len() + e + COMMENT_CLOSE.len(),
                None => {
                    from = start + COMMENT_OPEN.len();
                    continue;
                }
            }
        } else {
            match text[start + CDATA_OPEN.len()..].find(CDATA_CLOSE) {
                Some(e) => start + CDATA_OPEN.len() + e + CDATA_CLOSE.len(),
                None => text.len(),
            }
        };
        out.push_str(&text[pos..start]);
        out.push_str(&replace(is_comment, &text[start..end]));
        pos = end;
        from = end;
    }
    out.push_str(&text[pos..]);
    out
}

/// `text` with comments and CDATA blanked to spaces, byte for byte, so indices hold: the
/// view the locators search.
#[must_use]
pub fn mask_non_markup(text: &str) -> String {
    rewrite_regions(text, |_, region| " ".repeat(region.len()))
}

/// Drop comments; turn CDATA into its text with `& < >` escaped, so the tag scanner cannot
/// split it and the entity decode restores it exactly.
fn prepare(text: &str) -> String {
    rewrite_regions(text, |is_comment, region| {
        if is_comment {
            return String::new();
        }
        let body = region
            .strip_prefix(CDATA_OPEN)
            .map(|r| r.strip_suffix(CDATA_CLOSE).unwrap_or(r))
            .unwrap_or(region);
        body.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    })
}

/// Decode the predefined entities and numeric references in one pass. An unknown or
/// out-of-range reference stays as written.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        match decode_one(after) {
            Some((decoded, used)) => {
                out.push(decoded);
                rest = &after[used..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One entity body after `&` (`#x[0-9a-fA-F]+;`, `#[0-9]+;` or a named one), as the
/// character and the bytes it used.
fn decode_one(after: &str) -> Option<(char, usize)> {
    for (name, c) in [
        ("lt;", '<'),
        ("gt;", '>'),
        ("amp;", '&'),
        ("quot;", '"'),
        ("apos;", '\''),
    ] {
        if after.starts_with(name) {
            return Some((c, name.len()));
        }
    }
    let num = after.strip_prefix('#')?;
    let (digits, radix, skip) = match num.strip_prefix('x') {
        Some(hex) => (hex, 16, 2),
        None => (num, 10, 1),
    };
    let len = digits
        .bytes()
        .take_while(|b| {
            if radix == 16 {
                b.is_ascii_hexdigit()
            } else {
                b.is_ascii_digit()
            }
        })
        .count();
    if len == 0 || !digits[len..].starts_with(';') {
        return None;
    }
    let cp = u32::from_str_radix(&digits[..len], radix).ok()?;
    if cp == 0 {
        return None;
    }
    char::from_u32(cp).map(|c| (c, skip + len + 1))
}

/// Parse `raw_span` (a `<root>...</root>` span) into its fields.
#[must_use]
pub fn read(raw_span: &str, ci: bool) -> IndexMap<String, Raw> {
    let mut out = IndexMap::new();
    if raw_span.trim().is_empty() {
        return out;
    }
    let span = prepare(raw_span);
    let Some(gt) = span.find('>') else {
        return out;
    };
    let inner_end = match span.rfind("</") {
        Some(root_end) if root_end > gt => root_end,
        _ => span.len(),
    };
    parse_children(&span[gt + 1..inner_end], ci, &mut out, None, false, 0);
    out
}

/// Parse a rootless reply: its top-level elements are the fields.
#[must_use]
pub fn read_rootless(text: &str, ci: bool) -> IndexMap<String, Raw> {
    let mut out = IndexMap::new();
    if text.trim().is_empty() {
        return out;
    }
    parse_children(&prepare(text), ci, &mut out, None, false, 0);
    out
}

/// Parse `inner`'s elements into `out`. With `loose`, the text between the elements (an
/// element's own text in mixed content) is appended to it. `literal_unclosed` is set for
/// the body of an element that DID close: an open tag there that directly follows an
/// identifier character and has no close tag after it (`List<int> and ...`) is prose.
fn parse_children(
    inner: &str,
    ci: bool,
    out: &mut IndexMap<String, Raw>,
    mut loose: Option<&mut Vec<String>>,
    literal_unclosed: bool,
    depth: usize,
) {
    let b = inner.as_bytes();
    let mut pos = 0;
    let mut scan = 0;
    while let Some(m) = find_open_tag(inner, scan) {
        let attrs_text = &inner[m.attrs.0..m.attrs.1];
        if literal_unclosed
            && m.start > 0
            && is_name_char(b[m.start - 1])
            && !attrs_text.trim_end().ends_with('/')
            && find_any_close(inner, m.end, inner.len()).is_none()
        {
            scan = m.end;
            continue;
        }
        if let Some(l) = loose.as_deref_mut() {
            l.push(inner[pos..m.start].to_string());
        }
        let tag = &inner[m.name.0..m.name.1];
        let key = if ci {
            tag.to_lowercase()
        } else {
            tag.to_string()
        };

        let mut raw_attrs = attrs_text.trim();
        let self_closing = raw_attrs.ends_with('/');
        if self_closing {
            raw_attrs = raw_attrs[..raw_attrs.len() - 1].trim();
        }
        let attrs = parse_attrs(raw_attrs, ci);

        if self_closing {
            let v = if attrs.is_empty() {
                Raw::Str(String::new())
            } else {
                Raw::Map(attrs)
            };
            accumulate(out, key, v);
            pos = m.end;
            scan = pos;
            continue;
        }

        let content_start = m.end;
        let close = find_named_close(inner, content_start, tag, ci);
        let (mut content_end, mut next) = match close {
            Some((cs, ce)) => (cs, ce),
            None => {
                let (ce, nx) = match find_open_tag(inner, content_start) {
                    Some(sib) if inner[content_start..sib.start].trim().is_empty() => {
                        (inner.len(), inner.len())
                    }
                    Some(sib) => (sib.start, sib.start),
                    None => (inner.len(), inner.len()),
                };
                (ce, nx)
            }
        };
        if close.is_none()
            && let Some((s, e)) = find_stray_close(inner, content_start, content_end, ci)
        {
            content_end = s;
            next = e;
        }
        let content = &inner[content_start..content_end];
        accumulate(
            out,
            key,
            combine(attrs, content, ci, close.is_some(), depth),
        );
        pos = next;
        scan = next;
    }
    if let Some(l) = loose {
        l.push(inner[pos..].to_string());
    }
}

/// The first close tag in `inner[from..to]` whose element was never opened after `from`.
fn find_stray_close(inner: &str, from: usize, to: usize, ci: bool) -> Option<(usize, usize)> {
    let mut at = from;
    loop {
        let (s, e, name) = find_any_close(inner, at, to)?;
        if !has_named_open(inner, from, s, &name, ci) {
            return Some((s, e));
        }
        at = e;
    }
}

fn combine(
    attrs: IndexMap<String, Raw>,
    content: &str,
    ci: bool,
    closed: bool,
    depth: usize,
) -> Raw {
    if depth < MAX_DEPTH && content.contains('<') {
        let mut nested = IndexMap::new();
        let mut loose = Vec::new();
        parse_children(
            content,
            ci,
            &mut nested,
            Some(&mut loose),
            closed,
            depth + 1,
        );
        if !nested.is_empty() {
            let mut merged = attrs;
            for (k, v) in nested {
                merged.insert(k, v);
            }
            let text = mixed_text(&loose);
            if !text.is_empty() {
                merged.insert(TEXT_KEY.to_string(), Raw::Str(text));
            }
            return Raw::Map(merged);
        }
    }
    text_value(attrs, content)
}

fn remove_close_tags(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    let mut pos = 0;
    while let Some((s, e, _)) = find_any_close(seg, pos, seg.len()) {
        out.push_str(&seg[pos..s]);
        pos = e;
    }
    out.push_str(&seg[pos..]);
    out
}

fn mixed_text(segments: &[String]) -> String {
    segments
        .iter()
        .map(|seg| decode_entities(remove_close_tags(seg).trim()))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn text_value(attrs: IndexMap<String, Raw>, content: &str) -> Raw {
    let text = decode_entities(content.trim());
    if attrs.is_empty() {
        return Raw::Str(text);
    }
    let mut m = attrs;
    m.insert(TEXT_KEY.to_string(), Raw::Str(text));
    Raw::Map(m)
}

/// Attributes: `([A-Za-z_:][A-Za-z0-9_:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))`,
/// every match in order. The first of a repeated name wins.
fn parse_attrs(raw: &str, ci: bool) -> IndexMap<String, Raw> {
    let mut attrs = IndexMap::new();
    let b = raw.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let Some((name, value, end)) = attr_at(raw, i) else {
            i += 1;
            continue;
        };
        let name = if ci { name.to_lowercase() } else { name };
        attrs
            .entry(name)
            .or_insert_with(|| Raw::Str(decode_entities(&value)));
        i = end;
    }
    attrs
}

fn attr_at(raw: &str, i: usize) -> Option<(String, String, usize)> {
    let b = raw.as_bytes();
    if !(b[i].is_ascii_alphabetic() || b[i] == b'_' || b[i] == b':') {
        return None;
    }
    let mut j = i + 1;
    while j < b.len() && (b[j].is_ascii_alphanumeric() || matches!(b[j], b'_' | b':' | b'.' | b'-'))
    {
        j += 1;
    }
    let name = raw[i..j].to_string();
    let rest = &raw[j..];
    let after_ws = rest.trim_start();
    let after_eq = after_ws.strip_prefix('=')?;
    let value_part = after_eq.trim_start();
    let value_start = raw.len() - value_part.len();
    for q in ['"', '\''] {
        if let Some(body) = value_part.strip_prefix(q)
            && let Some(close) = body.find(q)
        {
            return Some((name, body[..close].to_string(), value_start + 1 + close + 1));
        }
    }
    let len = value_part
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .unwrap_or(value_part.len());
    if len == 0 {
        return None;
    }
    Some((name, value_part[..len].to_string(), value_start + len))
}

fn accumulate(out: &mut IndexMap<String, Raw>, key: String, value: Raw) {
    match out.get_mut(&key) {
        None => {
            out.insert(key, value);
        }
        Some(Raw::List(xs)) => xs.push(value),
        Some(existing) => {
            let first = std::mem::replace(existing, Raw::Null);
            *existing = Raw::List(vec![first, value]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> Raw {
        Raw::Str(v.to_string())
    }

    #[test]
    fn reads_children_attrs_and_repeats() {
        let m = read(
            "<r><a>1</a><b x=\"2\"/><t k='v'>hi &amp; bye</t><a>3</a></r>",
            true,
        );
        assert_eq!(m["a"], Raw::List(vec![s("1"), s("3")]));
        let Raw::Map(b) = &m["b"] else { panic!() };
        assert_eq!(b["x"], s("2"));
        let Raw::Map(t) = &m["t"] else { panic!() };
        assert_eq!(t[TEXT_KEY], s("hi & bye"));
    }

    #[test]
    fn cdata_and_comments() {
        let m = read("<r><!-- <a>no</a> --><a><![CDATA[x<y]]></a></r>", true);
        assert_eq!(m["a"], s("x<y"));
    }

    #[test]
    fn deep_nesting_returns_without_overflow() {
        let reply = format!("<r>{}", "<a>".repeat(50_000));
        let m = read(&reply, true);
        let mut v = &m["a"];
        let mut levels = 1;
        while let Raw::Map(inner) = v {
            v = &inner["a"];
            levels += 1;
        }
        assert!(levels <= MAX_DEPTH + 1);
        assert!(matches!(v, Raw::Str(t) if t.starts_with("<a>")));
    }

    #[test]
    fn unclosed_leaf_stops_at_sibling() {
        let m = read("<r><a>one<b>two</b></r>", true);
        assert_eq!(m["a"], s("one"));
        assert_eq!(m["b"], s("two"));
    }
}
