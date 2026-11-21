//! Format-keyed escapers (FR-004).
//!
//! Every `{{value}}` substitution is escaped for the template's format; `{{{value}}}` and
//! `{{&value}}` bypass it. The behaviour is character-for-character the same as the
//! TypeScript reference (`server/typescript/packages/render/src/escapers.ts`) and the C#,
//! Java and Python ports, and the render-conformance corpus holds every port to it.

/// No escaping.
pub const FORMAT_TEXT: &str = "text";
/// No escaping: markdown is text a model reads.
pub const FORMAT_MARKDOWN: &str = "markdown";
/// The XML entity set (FR-004 gives HTML the same one).
pub const FORMAT_HTML: &str = "html";
/// `& < > " '` as entities.
pub const FORMAT_XML: &str = "xml";
/// The formula-injection guard, then RFC 4180 quoting when a cell needs it.
pub const FORMAT_CSV: &str = "csv";
/// XML escaping, then the formula-injection guard.
pub const FORMAT_SPREADSHEET: &str = "spreadsheet";
/// The inside of a JSON string literal, as `JSON.stringify(s).slice(1, -1)` writes it.
pub const FORMAT_JSON: &str = "json";

/// Every registered format, in the order the reference registers them.
pub const FORMATS: [&str; 7] = [
    FORMAT_TEXT,
    FORMAT_MARKDOWN,
    FORMAT_HTML,
    FORMAT_XML,
    FORMAT_CSV,
    FORMAT_SPREADSHEET,
    FORMAT_JSON,
];

/// Is `format` one of [`FORMATS`]?
#[must_use]
pub fn is_format(format: &str) -> bool {
    FORMATS.contains(&format)
}

/// Does `format` leave every value unchanged? A render in such a format needs no
/// per-value escaping pass.
#[must_use]
pub fn is_identity(format: &str) -> bool {
    format == FORMAT_TEXT || format == FORMAT_MARKDOWN
}

/// Escape `value` for `format`, or `None` when the format is not registered.
#[must_use]
pub fn escape(format: &str, value: &str) -> Option<String> {
    Some(match format {
        FORMAT_TEXT | FORMAT_MARKDOWN => value.to_string(),
        FORMAT_HTML | FORMAT_XML => escape_xml(value),
        FORMAT_CSV => escape_csv(value),
        FORMAT_SPREADSHEET => injection_guard(&escape_xml(value)),
        FORMAT_JSON => escape_json(value),
        _ => return None,
    })
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// `-?[0-9]+(\.[0-9]+)?` over the whole string, ASCII digits only. A strict numeric
/// literal such as `-5` is data, not a formula, so the guard leaves it alone.
fn is_strict_numeric(s: &str) -> bool {
    let body = s.strip_prefix('-').unwrap_or(s);
    let (int, frac) = match body.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (body, None),
    };
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    digits(int) && frac.is_none_or(digits)
}

/// The OWASP CSV formula-injection guard: a cell that starts with `= + - @`, a tab or a
/// carriage return gets a leading apostrophe, unless it is a strict numeric literal.
fn injection_guard(s: &str) -> String {
    match s.chars().next() {
        Some('=' | '+' | '-' | '@' | '\t' | '\r') if !is_strict_numeric(s) => format!("'{s}"),
        _ => s.to_string(),
    }
}

fn escape_csv(s: &str) -> String {
    let guarded = injection_guard(s);
    if guarded.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_escapes_the_five_entities() {
        assert_eq!(
            escape(FORMAT_XML, "a&b<c>\"d'").unwrap(),
            "a&amp;b&lt;c&gt;&quot;d&#39;"
        );
    }

    #[test]
    fn csv_guards_and_quotes() {
        assert_eq!(escape(FORMAT_CSV, "=cmd()").unwrap(), "'=cmd()");
        assert_eq!(escape(FORMAT_CSV, "a,b").unwrap(), "\"a,b\"");
        assert_eq!(escape(FORMAT_CSV, "-5.25").unwrap(), "-5.25");
        assert_eq!(escape(FORMAT_CSV, "-5.").unwrap(), "'-5.");
        assert_eq!(
            escape(FORMAT_CSV, "say \"hi\"").unwrap(),
            "\"say \"\"hi\"\"\""
        );
    }

    #[test]
    fn spreadsheet_escapes_then_guards() {
        assert_eq!(escape(FORMAT_SPREADSHEET, "=a&b").unwrap(), "'=a&amp;b");
    }

    #[test]
    fn json_escapes_controls_only() {
        assert_eq!(
            escape(FORMAT_JSON, "a\"b\\c\n\u{01}<").unwrap(),
            "a\\\"b\\\\c\\n\\u0001<"
        );
    }

    #[test]
    fn unknown_format_is_none() {
        assert!(escape("yaml", "x").is_none());
        assert!(!is_format("yaml"));
    }
}
