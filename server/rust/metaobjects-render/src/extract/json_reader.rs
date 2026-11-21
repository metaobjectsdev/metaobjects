//! Stage 4: the tolerant JSON reader for the bounded malformation set. Never fails.
//!
//! A key whose value is empty or cut off is recorded as [`Raw::Truncated`], so the field
//! classifies `MALFORMED` rather than lost; the `null` literal is [`Raw::Null`]. Bare
//! scalars (numbers, `true`) stay text: coercion types them. Mirrors
//! `json_forgiving_reader.py`.

use indexmap::IndexMap;

/// A value the tolerant readers produce.
#[derive(Debug, Clone, PartialEq)]
pub enum Raw {
    Str(String),
    Map(IndexMap<String, Raw>),
    List(Vec<Raw>),
    /// A key that appeared with an empty or cut-off value.
    Truncated,
    /// The JSON `null` literal.
    Null,
}

/// Container nesting past which the reader skips a container rather than recursing.
const MAX_DEPTH: usize = 100;

/// Parse `span` as a forgiving JSON object; empty for garbage or a non-object root.
#[must_use]
pub fn read(span: &str) -> IndexMap<String, Raw> {
    let mut r = Reader {
        s: span.chars().collect(),
        i: 0,
        depth: 0,
    };
    r.ws();
    if r.peek() != Some('{') {
        return IndexMap::new();
    }
    match r.read_value() {
        Some(Raw::Map(m)) => m,
        _ => IndexMap::new(),
    }
}

struct Reader {
    s: Vec<char>,
    i: usize,
    depth: usize,
}

impl Reader {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn at(&self, c: char) -> bool {
        self.peek() == Some(c)
    }

    fn read_value(&mut self) -> Option<Raw> {
        self.ws();
        let c = self.peek()?;
        if c == '{' || c == '[' {
            if self.depth >= MAX_DEPTH {
                self.skip_balanced();
                return None;
            }
            self.depth += 1;
            let v = if c == '{' {
                Raw::Map(self.read_object())
            } else {
                Raw::List(self.read_array())
            };
            self.depth -= 1;
            return Some(v);
        }
        if c == '"' || c == '\'' {
            return Some(Raw::Str(self.read_string(c)));
        }
        self.read_bare_scalar()
    }

    fn skip_balanced(&mut self) {
        let mut depth = 0i32;
        while let Some(ch) = self.peek() {
            if ch == '"' || ch == '\'' {
                self.read_string(ch);
                continue;
            }
            self.i += 1;
            if ch == '{' || ch == '[' {
                depth += 1;
            } else if ch == '}' || ch == ']' {
                depth -= 1;
                if depth <= 0 {
                    return;
                }
            }
        }
    }

    fn read_object(&mut self) -> IndexMap<String, Raw> {
        let mut m = IndexMap::new();
        self.i += 1;
        loop {
            self.ws();
            match self.peek() {
                None => return m,
                Some('}') => {
                    self.i += 1;
                    return m;
                }
                _ => {}
            }
            let Some(key) = self.read_key() else {
                return m;
            };
            self.ws();
            if !self.at(':') {
                return m;
            }
            self.i += 1;
            self.ws();
            if self.peek().is_none() {
                m.insert(key, Raw::Truncated);
                return m;
            }
            let Some(v) = self.read_value() else {
                m.insert(key, Raw::Truncated);
                self.ws();
                if self.at(',') {
                    self.i += 1;
                    continue;
                }
                if self.at('}') {
                    self.i += 1;
                }
                return m;
            };
            m.insert(key, v);
            self.ws();
            if self.at(',') {
                self.i += 1;
            }
        }
    }

    fn read_array(&mut self) -> Vec<Raw> {
        let mut xs = Vec::new();
        self.i += 1;
        loop {
            self.ws();
            match self.peek() {
                None => return xs,
                Some(']' | '}') => {
                    self.i += 1;
                    return xs;
                }
                _ => {}
            }
            let Some(v) = self.read_value() else {
                self.ws();
                if self.at(']') || self.at('}') {
                    self.i += 1;
                }
                return xs;
            };
            xs.push(v);
            self.ws();
            if self.at(',') {
                self.i += 1;
            } else if self.at(']') {
                self.i += 1;
                return xs;
            } else {
                return xs;
            }
        }
    }

    fn read_key(&mut self) -> Option<String> {
        self.ws();
        let c = self.peek()?;
        if c == '"' || c == '\'' {
            return Some(self.read_string(c));
        }
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            self.i += 1;
        }
        (self.i > start).then(|| self.s[start..self.i].iter().collect())
    }

    fn read_string(&mut self, quote: char) -> String {
        self.i += 1;
        let mut out = String::new();
        while let Some(c) = self.peek() {
            self.i += 1;
            if c == '\\' {
                out.push_str(&self.read_escape());
            } else if c == quote {
                return out;
            } else {
                out.push(c);
            }
        }
        out
    }

    fn read_escape(&mut self) -> String {
        let Some(c) = self.peek() else {
            return String::new();
        };
        self.i += 1;
        let simple = match c {
            'n' => Some('\n'),
            't' => Some('\t'),
            'r' => Some('\r'),
            'b' => Some('\u{08}'),
            'f' => Some('\u{0C}'),
            _ => None,
        };
        if let Some(s) = simple {
            return s.to_string();
        }
        if c != 'u' {
            return c.to_string();
        }
        let Some(unit) = self.hex4() else {
            return "u".to_string();
        };
        if (0xD800..0xDC00).contains(&unit)
            && self.s.get(self.i) == Some(&'\\')
            && self.s.get(self.i + 1) == Some(&'u')
        {
            let save = self.i;
            self.i += 2;
            if let Some(low) = self.hex4()
                && (0xDC00..0xE000).contains(&low)
            {
                let cp = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00);
                return char::from_u32(cp).map(String::from).unwrap_or_default();
            }
            self.i = save;
        }
        // A lone surrogate has no `char`; it becomes U+FFFD, the nearest a Rust string holds.
        char::from_u32(unit).unwrap_or('\u{FFFD}').to_string()
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits: String = self.s.get(self.i..self.i + 4)?.iter().collect();
        if digits.chars().all(|d| d.is_ascii_hexdigit()) {
            self.i += 4;
            u32::from_str_radix(&digits, 16).ok()
        } else {
            None
        }
    }

    fn read_bare_scalar(&mut self) -> Option<Raw> {
        let start = self.i;
        while let Some(c) = self.peek() {
            if c == ',' || c == '}' || c == ']' {
                break;
            }
            if self.i > start
                && self.s[self.i - 1].is_whitespace()
                && comment_opens_at(&self.s, self.i)
            {
                break;
            }
            self.i += 1;
        }
        let text: String = self.s[start..self.i].iter().collect();
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        if text == "null" {
            return Some(Raw::Null);
        }
        Some(Raw::Str(text.to_string()))
    }

    fn ws(&mut self) {
        loop {
            while self.peek().is_some_and(char::is_whitespace) {
                self.i += 1;
            }
            match comment_end(&self.s, self.i) {
                Some(end) => self.i = end,
                None => return,
            }
        }
    }
}

/// Does a `//` or `/*` comment open at `i`?
pub(crate) fn comment_opens_at(s: &[char], i: usize) -> bool {
    i + 1 < s.len() && s[i] == '/' && (s[i + 1] == '/' || s[i + 1] == '*')
}

/// When a comment opens at `i`, the index just past it (a line comment runs to its line
/// end, a block comment to its `*/` or the end of the text).
pub(crate) fn comment_end(s: &[char], i: usize) -> Option<usize> {
    if !comment_opens_at(s, i) {
        return None;
    }
    if s[i + 1] == '/' {
        let mut j = i + 2;
        while j < s.len() && s[j] != '\n' && s[j] != '\r' {
            j += 1;
        }
        return Some(j);
    }
    let mut j = i + 2;
    while j + 1 < s.len() {
        if s[j] == '*' && s[j + 1] == '/' {
            return Some(j + 2);
        }
        j += 1;
    }
    Some(s.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forgiving_reads() {
        let m = read("{\"a\": 1, b: 'x', \"c\": null, \"d\": , \"e\": [1, 2,] // tail\n}");
        assert_eq!(m["a"], Raw::Str("1".into()));
        assert_eq!(m["b"], Raw::Str("x".into()));
        assert_eq!(m["c"], Raw::Null);
        assert_eq!(m["d"], Raw::Truncated);
        assert_eq!(
            m["e"],
            Raw::List(vec![Raw::Str("1".into()), Raw::Str("2".into())])
        );
        assert!(read("[1]").is_empty());
        assert_eq!(read("{\"xs\":[}").len(), 1);
    }
}
