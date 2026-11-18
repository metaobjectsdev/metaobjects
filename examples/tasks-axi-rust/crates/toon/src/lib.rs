//! A strict, std-only encoder for TOON (Token-Oriented Object Notation) v4.1.
//!
//! Covers objects, inline primitive arrays, tabular arrays, keyed tabular
//! objects and list form, for the JSON data model.

/// A JSON-shaped value. Object keys keep insertion order.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    Array(Vec<Value>),
    Object(Vec<(String, Value)>),
}

/// Delimiter used between array values and tabular cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delimiter {
    Comma,
    Tab,
    Pipe,
}

impl Delimiter {
    fn ch(self) -> char {
        match self {
            Delimiter::Comma => ',',
            Delimiter::Tab => '\t',
            Delimiter::Pipe => '|',
        }
    }

    /// The symbol shown inside a bracket segment; comma is spelled by omission.
    fn symbol(self) -> &'static str {
        match self {
            Delimiter::Comma => "",
            Delimiter::Tab => "\t",
            Delimiter::Pipe => "|",
        }
    }
}

/// Which encoder's string-quoting rules to follow.
///
/// The spec's own rules and the ones the `@toon-format/toon` 2.3.x library ships differ in three
/// places, and a tool that must print what that library prints needs the second set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Spec v4.1.1 (the conformance fixtures): a string starting with `#` is quoted, a leading `+`
    /// makes a string numeric-like, and padding means a space or tab.
    Spec,
    /// `@toon-format/toon` 2.3.x: `#` is not special, `+1` is not numeric-like, and padding is
    /// anything JavaScript's `String.prototype.trim` strips.
    ToonJs2,
}

/// Encoder options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub indent: usize,
    pub delimiter: Delimiter,
    pub dialect: Dialect,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            indent: 2,
            delimiter: Delimiter::Comma,
            dialect: Dialect::Spec,
        }
    }
}

/// JavaScript's `\s` set, which `String.prototype.trim` strips.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Encode with default options. No trailing newline.
pub fn encode(value: &Value) -> String {
    encode_with(value, &Options::default())
}

/// Encode with explicit options. No trailing newline.
pub fn encode_with(value: &Value, opts: &Options) -> String {
    Encoder { opts: *opts }.root(value).join("\n")
}

/// Encode one primitive as it would appear as a field value (comma delimiter).
/// Non-primitives encode as `null`.
pub fn encode_scalar(value: &Value) -> String {
    encode_scalar_with(value, &Options::default())
}

/// [`encode_scalar`] with explicit options.
pub fn encode_scalar_with(value: &Value, opts: &Options) -> String {
    Encoder { opts: *opts }.primitive(value)
}

/// Header columns: a name plus, for a nested-uniform column, its own columns.
type Fields = Vec<Field>;

struct Field {
    name: String,
    nested: Option<Fields>,
}

fn is_primitive(v: &Value) -> bool {
    !matches!(v, Value::Array(_) | Value::Object(_))
}

fn lookup<'a>(obj: &'a [(String, Value)], name: &str) -> &'a Value {
    obj.iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v)
        .unwrap_or(&Value::Null)
}

fn is_bare_key(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
}

/// Section 7.2: would this string be read back as a number?
fn is_numeric_like(s: &str, dialect: Dialect) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    let signs: &[u8] = match dialect {
        Dialect::Spec => b"+-",
        Dialect::ToonJs2 => b"-",
    };
    if i < b.len() && signs.contains(&b[i]) {
        i += 1;
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > start
    };
    if !digits(&mut i) {
        return false;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        if !digits(&mut i) {
            return false;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Section 2: canonical decimal form for 0 and 1e-6 <= |x| < 1e21.
fn format_number(v: f64) -> String {
    if !v.is_finite() {
        return "null".to_string();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    let a = v.abs();
    if (1e-6..1e21).contains(&a) {
        // Display prints the shortest round-tripping digits and never uses an
        // exponent; an integral value prints without a fractional part.
        return format!("{v}");
    }
    // Exponent notation is permitted outside the canonical range.
    let s = format!("{v:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

struct Encoder {
    opts: Options,
}

impl Encoder {
    fn delim(&self) -> char {
        self.opts.delimiter.ch()
    }

    fn pad(&self, depth: usize) -> String {
        " ".repeat(self.opts.indent * depth)
    }

    fn primitive(&self, v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(true) => "true".into(),
            Value::Bool(false) => "false".into(),
            Value::Int(i) => i.to_string(),
            Value::Num(n) => format_number(*n),
            Value::Str(s) => self.string(s),
            _ => "null".into(),
        }
    }

    fn string(&self, s: &str) -> String {
        if self.needs_quote(s) {
            quote(s)
        } else {
            s.to_string()
        }
    }

    fn needs_quote(&self, s: &str) -> bool {
        let padded = match self.opts.dialect {
            Dialect::Spec => s.starts_with([' ', '\t']) || s.ends_with([' ', '\t']),
            Dialect::ToonJs2 => s.starts_with(is_js_space) || s.ends_with(is_js_space),
        };
        let hash = self.opts.dialect == Dialect::Spec && s.starts_with('#');
        s.is_empty()
            || padded
            || matches!(s, "true" | "false" | "null")
            || is_numeric_like(s, self.opts.dialect)
            || s.chars().any(|c| {
                matches!(c, ':' | '"' | '\\' | '[' | ']' | '{' | '}')
                    || (c as u32) < 0x20
                    || c == self.delim()
            })
            || hash
            || s.starts_with('-')
    }

    fn key(&self, name: &str) -> String {
        if is_bare_key(name) {
            name.to_string()
        } else {
            quote(name)
        }
    }

    fn bracket(&self, len: usize, keyed: bool) -> String {
        let marker = if keyed {
            format!("{len}:")
        } else {
            len.to_string()
        };
        format!("[{marker}{}]", self.opts.delimiter.symbol())
    }

    fn field_list(&self, fields: &Fields) -> String {
        let d = self.delim().to_string();
        fields
            .iter()
            .map(|f| match &f.nested {
                None => self.key(&f.name),
                Some(n) => format!("{}{{{}}}", self.key(&f.name), self.field_list(n)),
            })
            .collect::<Vec<_>>()
            .join(&d)
    }

    fn tabular_fields(&self, items: &[&Value]) -> Option<Fields> {
        if items.is_empty() {
            return None;
        }
        let mut objs = Vec::with_capacity(items.len());
        for item in items {
            match item {
                Value::Object(o) if !o.is_empty() => objs.push(o),
                _ => return None,
            }
        }
        let first = objs[0];
        let same_keys = |o: &[(String, Value)]| {
            o.len() == first.len()
                && o.iter().all(|(k, _)| first.iter().any(|(k2, _)| k2 == k))
                && first.iter().all(|(k, _)| o.iter().any(|(k2, _)| k2 == k))
        };
        if !objs.iter().all(|o| same_keys(o)) {
            return None;
        }
        let mut fields = Fields::new();
        for (name, _) in first {
            let column: Vec<&Value> = objs.iter().map(|o| lookup(o, name)).collect();
            if column.iter().all(|v| is_primitive(v)) {
                fields.push(Field {
                    name: name.clone(),
                    nested: None,
                });
            } else {
                fields.push(Field {
                    name: name.clone(),
                    nested: Some(self.tabular_fields(&column)?),
                });
            }
        }
        Some(fields)
    }

    fn keyed_fields(&self, obj: &[(String, Value)]) -> Option<Fields> {
        if obj.len() < 2 {
            return None;
        }
        let vals: Vec<&Value> = obj.iter().map(|(_, v)| v).collect();
        self.tabular_fields(&vals)
    }

    fn cells(&self, obj: &[(String, Value)], fields: &Fields, out: &mut Vec<String>) {
        for f in fields {
            let v = lookup(obj, &f.name);
            match (&f.nested, v) {
                (None, v) => out.push(self.primitive(v)),
                (Some(n), Value::Object(o)) => self.cells(o, n, out),
                _ => {}
            }
        }
    }

    fn row(&self, v: &Value, fields: &Fields) -> String {
        let mut cells = Vec::new();
        if let Value::Object(o) = v {
            self.cells(o, fields, &mut cells);
        }
        cells.join(&self.delim().to_string())
    }

    fn keyed_block(
        &self,
        head_prefix: &str,
        obj: &[(String, Value)],
        fields: &Fields,
        depth: usize,
    ) -> Vec<String> {
        let mut lines = vec![format!(
            "{head_prefix}{}{{{}}}:",
            self.bracket(obj.len(), true),
            self.field_list(fields)
        )];
        for (k, v) in obj {
            lines.push(format!(
                "{}{}: {}",
                self.pad(depth + 1),
                self.key(k),
                self.row(v, fields)
            ));
        }
        lines
    }

    fn root(&self, v: &Value) -> Vec<String> {
        match v {
            Value::Object(o) => {
                if o.is_empty() {
                    return Vec::new();
                }
                if let Some(f) = self.keyed_fields(o) {
                    return self.keyed_block("", o, &f, 0);
                }
                self.object_body(o, 0)
            }
            Value::Array(a) => self.array(None, a, 0, true),
            _ => vec![self.primitive(v)],
        }
    }

    fn object_body(&self, obj: &[(String, Value)], depth: usize) -> Vec<String> {
        obj.iter()
            .flat_map(|(k, v)| self.field(k, v, depth))
            .collect()
    }

    fn field(&self, name: &str, v: &Value, depth: usize) -> Vec<String> {
        let pad = self.pad(depth);
        let key = self.key(name);
        match v {
            Value::Array(a) => self.array(Some(&key), a, depth, true),
            Value::Object(o) => {
                if o.is_empty() {
                    return vec![format!("{pad}{key}:")];
                }
                if let Some(f) = self.keyed_fields(o) {
                    return self.keyed_block(&format!("{pad}{key}"), o, &f, depth);
                }
                let mut lines = vec![format!("{pad}{key}:")];
                lines.extend(self.object_body(o, depth + 1));
                lines
            }
            _ => vec![format!("{pad}{key}: {}", self.primitive(v))],
        }
    }

    fn array(
        &self,
        key: Option<&str>,
        items: &[Value],
        depth: usize,
        allow_tabular: bool,
    ) -> Vec<String> {
        let pad = self.pad(depth);
        let prefix = key.unwrap_or("");
        if items.is_empty() {
            return vec![match key {
                Some(k) => format!("{pad}{k}: []"),
                None => format!("{pad}[]"),
            }];
        }
        let bracket = self.bracket(items.len(), false);
        if items.iter().all(is_primitive) {
            let vals: Vec<String> = items.iter().map(|i| self.primitive(i)).collect();
            return vec![format!(
                "{pad}{prefix}{bracket}: {}",
                vals.join(&self.delim().to_string())
            )];
        }
        if allow_tabular {
            let refs: Vec<&Value> = items.iter().collect();
            if let Some(fields) = self.tabular_fields(&refs) {
                let mut lines = vec![format!(
                    "{pad}{prefix}{bracket}{{{}}}:",
                    self.field_list(&fields)
                )];
                for item in items {
                    lines.push(format!(
                        "{}{}",
                        self.pad(depth + 1),
                        self.row(item, &fields)
                    ));
                }
                return lines;
            }
        }
        let mut lines = vec![format!("{pad}{prefix}{bracket}:")];
        for item in items {
            lines.extend(self.list_item(item, depth + 1));
        }
        lines
    }

    fn list_item(&self, v: &Value, depth: usize) -> Vec<String> {
        let pad = self.pad(depth);
        match v {
            Value::Array(a) => {
                if a.is_empty() {
                    return vec![format!("{pad}- {}:", self.bracket(0, false))];
                }
                self.hyphenate(self.array(None, a, depth, false), depth, depth)
            }
            Value::Object(o) => {
                let Some((first, first_v)) = o.first() else {
                    return vec![format!("{pad}-")];
                };
                let mut lines =
                    self.hyphenate(self.field(first, first_v, depth + 1), depth, depth + 1);
                for (k, val) in &o[1..] {
                    lines.extend(self.field(k, val, depth + 1));
                }
                lines
            }
            _ => vec![format!("{pad}- {}", self.primitive(v))],
        }
    }

    /// Move the first line onto a `- ` marker at `marker_depth`.
    fn hyphenate(&self, lines: Vec<String>, marker_depth: usize, head_depth: usize) -> Vec<String> {
        let mut it = lines.into_iter();
        let head = it.next().unwrap_or_default();
        let rest = &head[self.pad(head_depth).len()..];
        let mut out = vec![format!("{}- {rest}", self.pad(marker_depth))];
        out.extend(it);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> String {
        encode_scalar(&Value::Str(x.into()))
    }

    #[test]
    fn plain_strings_stay_bare() {
        assert_eq!(s("hello world"), "hello world");
        assert_eq!(s("a-b"), "a-b");
        assert_eq!(s("é"), "é");
    }

    #[test]
    fn reserved_and_numeric_like_are_quoted() {
        for v in [
            "", "true", "false", "null", "42", "-3.5", "1e5", "+7", "1E-2",
        ] {
            assert_eq!(s(v), format!("\"{v}\""), "{v}");
        }
        assert_eq!(s("1.2.3"), "1.2.3");
        assert_eq!(s("1."), "1.");
    }

    #[test]
    fn structural_and_edge_chars_are_quoted() {
        assert_eq!(s("a:b"), "\"a:b\"");
        assert_eq!(s(" x"), "\" x\"");
        assert_eq!(s("x "), "\"x \"");
        assert_eq!(s("-x"), "\"-x\"");
        assert_eq!(s("#x"), "\"#x\"");
        assert_eq!(s("a,b"), "\"a,b\"");
        assert_eq!(s("[x]"), "\"[x]\"");
        assert_eq!(s("a\nb"), "\"a\\nb\"");
        assert_eq!(s("a\u{1}b"), "\"a\\u0001b\"");
        assert_eq!(s("q\"b\\"), "\"q\\\"b\\\\\"");
    }

    #[test]
    fn delimiter_quoting_is_delimiter_aware() {
        let v = Value::Array(vec![Value::Str("a|b".into()), Value::Str("c,d".into())]);
        let o = Options {
            delimiter: Delimiter::Pipe,
            ..Options::default()
        };
        assert_eq!(encode_with(&v, &o), "[2|]: \"a|b\"|c,d");
    }

    #[test]
    fn keys_quote_unless_bare() {
        let v = Value::Object(vec![
            ("ok_key.1".into(), Value::Int(1)),
            ("a b".into(), Value::Int(2)),
            ("1x".into(), Value::Int(3)),
        ]);
        assert_eq!(encode(&v), "ok_key.1: 1\n\"a b\": 2\n\"1x\": 3");
    }

    #[test]
    fn numbers() {
        let n = |x: f64| encode_scalar(&Value::Num(x));
        assert_eq!(n(1.0), "1");
        assert_eq!(n(-0.0), "0");
        assert_eq!(n(1.5), "1.5");
        assert_eq!(n(1e-6), "0.000001");
        assert_eq!(n(1e20), "100000000000000000000");
        assert_eq!(n(1e21), "1e+21");
        assert_eq!(n(1e-7), "1e-7");
        assert_eq!(n(f64::NAN), "null");
        assert_eq!(n(f64::INFINITY), "null");
        assert_eq!(encode_scalar(&Value::Int(-5)), "-5");
    }

    #[test]
    fn empty_object_root_is_empty() {
        assert_eq!(encode(&Value::Object(vec![])), "");
    }
}

#[cfg(test)]
mod dialect_tests {
    use super::*;

    fn js(s: &str) -> String {
        let opts = Options {
            dialect: Dialect::ToonJs2,
            ..Options::default()
        };
        encode_scalar_with(&Value::Str(s.to_string()), &opts)
    }

    #[test]
    fn the_js_library_does_not_quote_a_leading_hash_or_plus_number() {
        assert_eq!(js("## Intent"), "## Intent");
        assert_eq!(js("+1"), "+1");
        assert_eq!(encode_scalar(&Value::Str("#x".into())), "\"#x\"");
        assert_eq!(encode_scalar(&Value::Str("+1".into())), "\"+1\"");
    }

    #[test]
    fn the_js_library_pads_with_every_trimmed_character() {
        assert_eq!(js("\u{a0}x"), "\"\u{a0}x\"");
        assert_eq!(js("x\u{feff}"), "\"x\u{feff}\"");
        assert_eq!(js("\u{85}x"), "\u{85}x");
    }
}
