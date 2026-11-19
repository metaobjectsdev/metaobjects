//! `jsre`: a tiny backtracking regex engine that reproduces JavaScript
//! (ECMAScript, non-unicode mode, no `i`/`m`/`s` flags) matching semantics for a
//! small, fixed subset of pattern syntax. Anything outside the subset is
//! rejected by [`Regex::new`] rather than silently mis-matched.
//!
//! Positions are indices into a `&[char]` (code points), not bytes or UTF-16
//! units.

/// Predefined character-class escapes.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Esc {
    Space,
    NotSpace,
    Digit,
    NotDigit,
    Word,
    NotWord,
}

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

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

impl Esc {
    fn matches(self, c: char) -> bool {
        match self {
            Esc::Space => is_js_space(c),
            Esc::NotSpace => !is_js_space(c),
            Esc::Digit => c.is_ascii_digit(),
            Esc::NotDigit => !c.is_ascii_digit(),
            Esc::Word => is_word(c),
            Esc::NotWord => !is_word(c),
        }
    }
}

#[derive(Debug, Clone)]
enum ClassItem {
    Range(char, char),
    Esc(Esc),
}

#[derive(Debug, Clone)]
struct Rep {
    node: Node,
    min: usize,
    max: usize,
    greedy: bool,
    /// Capture indices `lo..hi` live inside the body and reset per iteration.
    lo: usize,
    hi: usize,
}

#[derive(Debug, Clone)]
enum Node {
    Empty,
    Char(char),
    Any,
    Class { items: Vec<ClassItem>, neg: bool },
    Esc(Esc),
    Seq(Vec<Node>),
    Alt(Vec<Node>),
    Group(usize, Box<Node>),
    NegLook(Box<Node>),
    Repeat(Box<Rep>),
    Bol,
    Eol,
    WordB(bool),
}

impl Node {
    /// For single-character nodes, whether `c` matches; `None` otherwise.
    fn single(&self, c: char) -> Option<bool> {
        match self {
            Node::Char(x) => Some(*x == c),
            Node::Any => Some(!matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')),
            Node::Esc(e) => Some(e.matches(c)),
            Node::Class { items, neg } => {
                let hit = items.iter().any(|it| match it {
                    ClassItem::Range(lo, hi) => *lo <= c && c <= *hi,
                    ClassItem::Esc(e) => e.matches(c),
                });
                Some(hit != *neg)
            }
            _ => None,
        }
    }

    fn is_single(&self) -> bool {
        matches!(
            self,
            Node::Char(_) | Node::Any | Node::Esc(_) | Node::Class { .. }
        )
    }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

struct Parser {
    s: Vec<char>,
    pos: usize,
    ngroups: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.s.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn err<T>(&self, msg: &str) -> Result<T, String> {
        Err(format!("{} at offset {}", msg, self.pos))
    }

    fn parse_alt(&mut self) -> Result<Node, String> {
        let mut alts = vec![self.parse_seq()?];
        while self.peek() == Some('|') {
            self.pos += 1;
            alts.push(self.parse_seq()?);
        }
        Ok(if alts.len() == 1 {
            alts.pop().unwrap()
        } else {
            Node::Alt(alts)
        })
    }

    fn parse_seq(&mut self) -> Result<Node, String> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            items.push(self.parse_term()?);
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap(),
            _ => Node::Seq(items),
        })
    }

    fn parse_term(&mut self) -> Result<Node, String> {
        let before = self.ngroups;
        let c = self.next().unwrap();
        let (atom, quantifiable) = match c {
            '^' => (Node::Bol, false),
            '$' => (Node::Eol, false),
            '.' => (Node::Any, true),
            '(' => {
                if self.peek() == Some('?') {
                    self.pos += 1;
                    match self.next() {
                        Some(':') => {
                            let n = self.parse_alt()?;
                            self.expect_close()?;
                            (n, true)
                        }
                        Some('!') => {
                            let n = self.parse_alt()?;
                            self.expect_close()?;
                            (Node::NegLook(Box::new(n)), false)
                        }
                        _ => return self.err("unsupported group syntax"),
                    }
                } else {
                    self.ngroups += 1;
                    let idx = self.ngroups;
                    let n = self.parse_alt()?;
                    self.expect_close()?;
                    (Node::Group(idx, Box::new(n)), true)
                }
            }
            '[' => (self.parse_class()?, true),
            '\\' => self.parse_escape()?,
            '*' | '+' | '?' => return self.err("nothing to repeat"),
            '{' | '}' | ']' => return self.err("unsupported brace or bracket"),
            c => (Node::Char(c), true),
        };
        let after = self.ngroups;
        match self.peek() {
            Some('*') | Some('+') | Some('?') | Some('{') => {
                if !quantifiable {
                    return self.err("quantifier on a non-quantifiable atom");
                }
                let (min, max) = self.parse_quant()?;
                let greedy = if self.peek() == Some('?') {
                    self.pos += 1;
                    false
                } else {
                    true
                };
                if matches!(self.peek(), Some('*') | Some('+') | Some('?') | Some('{')) {
                    return self.err("nothing to repeat");
                }
                Ok(Node::Repeat(Box::new(Rep {
                    node: atom,
                    min,
                    max,
                    greedy,
                    lo: before + 1,
                    hi: after + 1,
                })))
            }
            _ => Ok(atom),
        }
    }

    fn expect_close(&mut self) -> Result<(), String> {
        if self.next() == Some(')') {
            Ok(())
        } else {
            self.err("unterminated group")
        }
    }

    fn parse_quant(&mut self) -> Result<(usize, usize), String> {
        match self.next().unwrap() {
            '*' => Ok((0, usize::MAX)),
            '+' => Ok((1, usize::MAX)),
            '?' => Ok((0, 1)),
            _ => {
                let min = self.parse_int()?;
                let max = if self.peek() == Some(',') {
                    self.pos += 1;
                    if self.peek() == Some('}') {
                        usize::MAX
                    } else {
                        self.parse_int()?
                    }
                } else {
                    min
                };
                if self.next() != Some('}') {
                    return self.err("malformed {} quantifier");
                }
                if max < min {
                    return self.err("quantifier range out of order");
                }
                Ok((min, max))
            }
        }
    }

    fn parse_int(&mut self) -> Result<usize, String> {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
        }
        if start == self.pos {
            return self.err("expected digits");
        }
        let t: String = self.s[start..self.pos].iter().collect();
        t.parse().map_err(|_| "quantifier too large".to_string())
    }

    fn simple_escape(c: char) -> Option<char> {
        match c {
            't' => Some('\t'),
            'n' => Some('\n'),
            'r' => Some('\r'),
            'v' => Some('\u{b}'),
            'f' => Some('\u{c}'),
            _ => None,
        }
    }

    fn class_esc(c: char) -> Option<Esc> {
        match c {
            's' => Some(Esc::Space),
            'S' => Some(Esc::NotSpace),
            'd' => Some(Esc::Digit),
            'D' => Some(Esc::NotDigit),
            'w' => Some(Esc::Word),
            'W' => Some(Esc::NotWord),
            _ => None,
        }
    }

    fn parse_escape(&mut self) -> Result<(Node, bool), String> {
        let c = match self.next() {
            Some(c) => c,
            None => return self.err("trailing backslash"),
        };
        if let Some(e) = Self::class_esc(c) {
            return Ok((Node::Esc(e), true));
        }
        if let Some(l) = Self::simple_escape(c) {
            return Ok((Node::Char(l), true));
        }
        match c {
            'b' => Ok((Node::WordB(true), false)),
            'B' => Ok((Node::WordB(false), false)),
            c if c.is_ascii_alphanumeric() => self.err("unsupported escape"),
            c => Ok((Node::Char(c), true)),
        }
    }

    /// One class atom: `Ok(Err(esc))` for a class escape, `Ok(Ok(char))` for a char.
    fn class_atom(&mut self) -> Result<Result<char, Esc>, String> {
        let c = match self.next() {
            Some(c) => c,
            None => return self.err("unterminated class"),
        };
        if c != '\\' {
            return Ok(Ok(c));
        }
        let e = match self.next() {
            Some(e) => e,
            None => return self.err("trailing backslash"),
        };
        if let Some(esc) = Self::class_esc(e) {
            return Ok(Err(esc));
        }
        if let Some(l) = Self::simple_escape(e) {
            return Ok(Ok(l));
        }
        if e.is_ascii_alphanumeric() {
            return self.err("unsupported escape in class");
        }
        Ok(Ok(e))
    }

    fn parse_class(&mut self) -> Result<Node, String> {
        let neg = if self.peek() == Some('^') {
            self.pos += 1;
            true
        } else {
            false
        };
        let mut items = Vec::new();
        loop {
            if self.peek().is_none() {
                return self.err("unterminated class");
            }
            if self.peek() == Some(']') {
                self.pos += 1;
                break;
            }
            let lo = self.class_atom()?;
            let is_range =
                self.peek() == Some('-') && self.s.get(self.pos + 1).is_some_and(|c| *c != ']');
            match (lo, is_range) {
                (Ok(lo), true) => {
                    self.pos += 1;
                    match self.class_atom()? {
                        Ok(hi) if lo <= hi => items.push(ClassItem::Range(lo, hi)),
                        Ok(_) => return self.err("class range out of order"),
                        Err(_) => return self.err("class escape as range endpoint"),
                    }
                }
                (Err(_), true) => return self.err("class escape as range endpoint"),
                (Ok(c), false) => items.push(ClassItem::Range(c, c)),
                (Err(e), false) => items.push(ClassItem::Esc(e)),
            }
        }
        Ok(Node::Class { items, neg })
    }
}

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

struct St {
    caps: Vec<Option<(usize, usize)>>,
}

type K<'a> = &'a mut dyn FnMut(usize, &mut St) -> bool;

struct Ctx<'h> {
    h: &'h [char],
}

impl Ctx<'_> {
    fn m(&self, node: &Node, i: usize, st: &mut St, k: K) -> bool {
        match node {
            Node::Empty => k(i, st),
            Node::Char(_) | Node::Any | Node::Esc(_) | Node::Class { .. } => {
                if i < self.h.len() && node.single(self.h[i]) == Some(true) {
                    k(i + 1, st)
                } else {
                    false
                }
            }
            Node::Seq(v) => self.seq(v, i, st, k),
            Node::Alt(v) => {
                for n in v {
                    if self.m(n, i, st, &mut *k) {
                        return true;
                    }
                }
                false
            }
            Node::Group(idx, n) => self.m(n, i, st, &mut |j, st| {
                let old = st.caps[*idx];
                st.caps[*idx] = Some((i, j));
                if k(j, st) {
                    true
                } else {
                    st.caps[*idx] = old;
                    false
                }
            }),
            Node::NegLook(n) => {
                let saved = st.caps.clone();
                let matched = self.m(n, i, st, &mut |_, _| true);
                st.caps = saved;
                !matched && k(i, st)
            }
            Node::Bol => i == 0 && k(i, st),
            Node::Eol => i == self.h.len() && k(i, st),
            Node::WordB(want) => {
                let a = i > 0 && is_word(self.h[i - 1]);
                let b = i < self.h.len() && is_word(self.h[i]);
                ((a != b) == *want) && k(i, st)
            }
            Node::Repeat(r) => {
                if r.node.is_single() {
                    self.rep_single(r, i, st, k)
                } else {
                    self.rep(r, 0, i, st, k)
                }
            }
        }
    }

    fn seq(&self, v: &[Node], i: usize, st: &mut St, k: K) -> bool {
        match v.split_first() {
            None => k(i, st),
            Some((first, rest)) => {
                self.m(first, i, st, &mut |j, st| self.seq(rest, j, st, &mut *k))
            }
        }
    }

    fn rep_single(&self, r: &Rep, i: usize, st: &mut St, k: K) -> bool {
        let mut avail = 0;
        while avail < r.max
            && i + avail < self.h.len()
            && r.node.single(self.h[i + avail]) == Some(true)
        {
            avail += 1;
        }
        if avail < r.min {
            return false;
        }
        if r.greedy {
            for n in (r.min..=avail).rev() {
                if k(i + n, st) {
                    return true;
                }
            }
        } else {
            for n in r.min..=avail {
                if k(i + n, st) {
                    return true;
                }
            }
        }
        false
    }

    fn iterate(&self, r: &Rep, count: usize, i: usize, st: &mut St, k: K) -> bool {
        let saved: Vec<_> = st.caps[r.lo..r.hi].to_vec();
        for c in &mut st.caps[r.lo..r.hi] {
            *c = None;
        }
        let ok = self.m(&r.node, i, st, &mut |j, st| {
            if j == i && count >= r.min {
                return false;
            }
            self.rep(r, count + 1, j, st, &mut *k)
        });
        if !ok {
            st.caps[r.lo..r.hi].copy_from_slice(&saved);
        }
        ok
    }

    fn rep(&self, r: &Rep, count: usize, i: usize, st: &mut St, k: K) -> bool {
        if r.greedy {
            if count < r.max && self.iterate(r, count, i, st, &mut *k) {
                return true;
            }
            count >= r.min && k(i, st)
        } else {
            if count >= r.min && k(i, st) {
                return true;
            }
            count < r.max && self.iterate(r, count, i, st, k)
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// A successful match. `groups[0]` is the whole match; non-participating
/// groups are `None`. Offsets are char indices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub start: usize,
    pub end: usize,
    pub groups: Vec<Option<(usize, usize)>>,
}

/// A compiled pattern.
#[derive(Debug, Clone)]
pub struct Regex {
    node: Node,
    ngroups: usize,
}

impl Regex {
    /// Compile `pattern`, or return an error naming the unsupported feature.
    pub fn new(pattern: &str) -> Result<Regex, String> {
        let mut p = Parser {
            s: pattern.chars().collect(),
            pos: 0,
            ngroups: 0,
        };
        let node = p.parse_alt()?;
        if p.pos != p.s.len() {
            return p.err("unmatched )");
        }
        Ok(Regex {
            node,
            ngroups: p.ngroups,
        })
    }

    /// Leftmost match starting at an index `>= start`.
    pub fn find_at(&self, hay: &[char], start: usize) -> Option<Match> {
        let ctx = Ctx { h: hay };
        for s in start..=hay.len() {
            let mut st = St {
                caps: vec![None; self.ngroups + 1],
            };
            let mut end = None;
            if ctx.m(&self.node, s, &mut st, &mut |j, _| {
                end = Some(j);
                true
            }) {
                let end = end.unwrap();
                st.caps[0] = Some((s, end));
                return Some(Match {
                    start: s,
                    end,
                    groups: st.caps,
                });
            }
        }
        None
    }

    /// All matches with `matchAll` / global-flag semantics.
    pub fn find_all(&self, hay: &[char]) -> Vec<Match> {
        let mut out = Vec::new();
        let mut last = 0;
        while last <= hay.len() {
            let Some(m) = self.find_at(hay, last) else {
                break;
            };
            last = if m.end == m.start { m.end + 1 } else { m.end };
            out.push(m);
        }
        out
    }

    /// First match at or after `start`, with every group as a `String`.
    pub fn captures_str(&self, hay: &[char], start: usize) -> Option<Vec<Option<String>>> {
        let m = self.find_at(hay, start)?;
        Some(
            m.groups
                .iter()
                .map(|g| g.map(|(s, e)| hay[s..e].iter().collect()))
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cs(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    fn caps(p: &str, s: &str) -> Option<Vec<Option<String>>> {
        Regex::new(p).unwrap().captures_str(&cs(s), 0)
    }

    fn some(s: &str) -> Option<String> {
        Some(s.to_string())
    }

    #[test]
    fn literals_and_leftmost() {
        let r = Regex::new("ab").unwrap();
        let m = r.find_at(&cs("xxabab"), 0).unwrap();
        assert_eq!((m.start, m.end), (2, 4));
        let m = r.find_at(&cs("xxabab"), 3).unwrap();
        assert_eq!((m.start, m.end), (4, 6));
        assert!(r.find_at(&cs("ba"), 0).is_none());
    }

    #[test]
    fn greedy_vs_lazy() {
        assert_eq!(caps("a(.*)b", "axbxb").unwrap()[1], some("xbx"));
        assert_eq!(caps("a(.*?)b", "axbxb").unwrap()[1], some("x"));
        assert_eq!(caps("a(x{1,2}?)", "axxx").unwrap()[1], some("x"));
        assert_eq!(caps("a(x{2,})", "axxxb").unwrap()[1], some("xxx"));
        assert_eq!(caps("(a??)a", "a").unwrap()[1], some(""));
        assert_eq!(caps("(a??)b", "ab").unwrap()[1], some("a"));
    }

    #[test]
    fn alternation_and_captures() {
        let c = caps("(a)|(b)", "b").unwrap();
        assert_eq!(c, vec![some("b"), None, some("b")]);
        let c = caps("(?:ab|a)(c)?", "abd").unwrap();
        assert_eq!(c, vec![some("ab"), None]);
        // JS resets captures inside a repeated group on each iteration.
        let c = caps("(?:(a)|b)+", "ab").unwrap();
        assert_eq!(c, vec![some("ab"), None]);
    }

    #[test]
    fn negative_lookahead() {
        let c = caps("(?:(?!ab).)+", "xxabyy").unwrap();
        assert_eq!(c[0], some("xx"));
        assert!(caps("^(?!a)", "abc").is_none());
        assert!(caps("^(?!a)", "bbc").is_some());
    }

    #[test]
    fn classes() {
        assert_eq!(caps("[^a-c]+", "abxyc").unwrap()[0], some("xy"));
        assert_eq!(caps("[\\d.-]+", "a1.-2b").unwrap()[0], some("1.-2"));
        assert_eq!(
            caps("[A-Za-z0-9._-]*", "a_b-c d").unwrap()[0],
            some("a_b-c")
        );
        assert_eq!(caps("[^)]+", "ab)c").unwrap()[0], some("ab"));
    }

    #[test]
    fn anchors_and_boundaries() {
        assert!(caps("^a$", "a").is_some());
        assert!(caps("^a$", "a\n").is_none());
        assert!(caps("^$", "").is_some());
        assert_eq!(caps("\\bfoo\\b", "a foo.").unwrap()[0], some("foo"));
        assert!(caps("\\bfoo\\b", "afoo").is_none());
        assert!(caps("\\Boo", "foo").is_some());
    }

    #[test]
    fn js_whitespace_and_dot() {
        for c in [
            '\u{a0}', '\u{3000}', '\u{feff}', '\u{2028}', '\u{b}', '\u{c}',
        ] {
            assert!(caps("^\\s$", &c.to_string()).is_some(), "{:?}", c);
        }
        assert!(caps("^\\s$", "\u{200b}").is_none());
        assert!(caps("^.$", "\u{2028}").is_none());
        assert!(caps("^.$", "\u{1F600}").is_some());
    }

    #[test]
    fn find_all_empty_matches_advance() {
        let r = Regex::new("a*").unwrap();
        let ms = r.find_all(&cs("baab"));
        let spans: Vec<_> = ms.iter().map(|m| (m.start, m.end)).collect();
        assert_eq!(spans, vec![(0, 0), (1, 3), (3, 3), (4, 4)]);
    }

    #[test]
    fn unsupported_features_are_errors() {
        for p in [
            "(a)\\1", "(?=a)", "(?<=a)", "(?<n>a)", "a{", "a**", "\\u0041", "\\x41", "(a", "a)",
            "[a-\\d]", "^*", "[b-a]", "\\0", "}",
        ] {
            assert!(Regex::new(p).is_err(), "{}", p);
        }
    }
}
