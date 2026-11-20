//! A small, dependency-free, full-match regular-expression matcher for `validator.regex`.
//!
//! It implements the subset of regular-expression syntax every MetaObjects port agrees on, so a
//! pattern means the same thing in every language. A pattern is parsed once into a tree and
//! matched by backtracking. Matching is over `char`s, case-sensitive, and the class escapes are
//! ASCII only. Nothing is captured.
//!
//! Supported: literals; the escapes `\d \D \w \W \s \S \t \n \r \f \v \0 \xHH \uHHHH` and an
//! escaped punctuation character; `.` (any character but `\n`); classes `[...]` and `[^...]`
//! with ranges; groups `( ... )` and `(?: ... )`; alternation `|`; the quantifiers `* + ? {n}
//! {n,} {n,m}` and their lazy forms; and the anchors `^` and `$`. Everything else is refused
//! with a [`PatternError`]: lookaround, named groups, inline flags, backreferences, `\b`, `\p{..}`
//! and possessive quantifiers.
//!
//! A match gives up and answers `false` after a fixed number of steps, or when it nests too deeply,
//! so a pathological pattern cannot hang or overflow the stack of a caller.
//!
//! This file is written by the `entity` generator into the support crate (`meta_support`)
//! every generated model crate depends on.

use std::cell::Cell;
use std::fmt;

/// The most steps one match may take before it answers `false`.
const STEP_BUDGET: u32 = 1_000_000;
/// The deepest nesting of group and repeat work one match may reach before it answers `false`.
const DEPTH_LIMIT: u32 = 1_000;
/// The deepest nesting of groups a pattern may have.
const NESTING_LIMIT: u32 = 100;

/// Why a pattern was refused. `at` is the byte offset in the pattern source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternError {
    pub at: usize,
    pub message: String,
}

impl fmt::Display for PatternError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} at offset {}", self.message, self.at)
    }
}

impl std::error::Error for PatternError {}

/// One member of a character class.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ClassItem {
    Range(char, char),
    Digit,
    NotDigit,
    Word,
    NotWord,
    Space,
    NotSpace,
}

/// Whether `count` is still under the optional upper bound.
fn below<T: PartialOrd>(max: Option<T>, count: T) -> bool {
    match max {
        Some(m) => count < m,
        None => true,
    }
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0B' | '\x0C')
}

impl ClassItem {
    fn matches(&self, c: char) -> bool {
        match *self {
            ClassItem::Range(lo, hi) => (lo..=hi).contains(&c),
            ClassItem::Digit => c.is_ascii_digit(),
            ClassItem::NotDigit => !c.is_ascii_digit(),
            ClassItem::Word => is_word(c),
            ClassItem::NotWord => !is_word(c),
            ClassItem::Space => is_space(c),
            ClassItem::NotSpace => !is_space(c),
        }
    }
}

/// A repeated node with its bounds.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Rep {
    node: Box<Node>,
    min: u32,
    max: Option<u32>,
    lazy: bool,
}

/// A parsed pattern node.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
    Char(char),
    Any,
    Class { negated: bool, items: Vec<ClassItem> },
    Start,
    End,
    Group(Vec<Vec<Node>>),
    Repeat(Rep),
}

/// What an escape stands for.
enum Escape {
    Char(char),
    Class(ClassItem),
}

/// A parsed pattern, ready to match whole texts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
    alts: Vec<Vec<Node>>,
}

impl Pattern {
    /// Parses `source`, or says why it is refused.
    pub fn parse(source: &str) -> Result<Pattern, PatternError> {
        let mut parser = Parser {
            chars: source.char_indices().collect(),
            pos: 0,
            nesting: 0,
            end: source.len(),
        };
        let alts = parser.parse_alts()?;
        if parser.peek().is_some() {
            return parser.fail(parser.offset(), "unmatched ')'");
        }
        Ok(Pattern { alts })
    }

    /// True when the whole text matches, as if the pattern were wrapped in `^(?: ... )$`.
    pub fn is_full_match(&self, text: &str) -> bool {
        let chars: Vec<char> = text.chars().collect();
        let matcher = Matcher { text: &chars, steps: Cell::new(0), depth: Cell::new(0) };
        let end = chars.len();
        self.alts.iter().any(|alt| matcher.seq(alt, 0, &|p| p == end))
    }
}

/// Parses and matches in one call; a pattern that does not parse matches nothing.
pub fn full_match(source: &str, text: &str) -> bool {
    Pattern::parse(source).map(|p| p.is_full_match(text)).unwrap_or(false)
}

struct Parser {
    chars: Vec<(usize, char)>,
    pos: usize,
    nesting: u32,
    end: usize,
}

impl Parser {
    fn char_at(&self, index: usize) -> Option<char> {
        self.chars.get(index).map(|&(_, c)| c)
    }

    fn peek(&self) -> Option<char> {
        self.char_at(self.pos)
    }

    fn next(&mut self) -> Option<char> {
        let c = self.peek();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn eat(&mut self, c: char) -> bool {
        let found = self.peek() == Some(c);
        if found {
            self.pos += 1;
        }
        found
    }

    fn offset_at(&self, index: usize) -> usize {
        self.chars.get(index).map_or(self.end, |&(o, _)| o)
    }

    fn offset(&self) -> usize {
        self.offset_at(self.pos)
    }

    fn fail<T>(&self, at: usize, message: &str) -> Result<T, PatternError> {
        Err(PatternError { at, message: message.to_string() })
    }

    fn parse_alts(&mut self) -> Result<Vec<Vec<Node>>, PatternError> {
        let mut alts = Vec::new();
        loop {
            alts.push(self.parse_seq()?);
            if !self.eat('|') {
                return Ok(alts);
            }
        }
    }

    fn parse_seq(&mut self) -> Result<Vec<Node>, PatternError> {
        let mut seq = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.parse_atom()?;
            seq.push(self.parse_quantifier(atom)?);
        }
        Ok(seq)
    }

    fn parse_atom(&mut self) -> Result<Node, PatternError> {
        let at = self.offset();
        let Some(c) = self.next() else {
            return self.fail(at, "unexpected end of pattern");
        };
        Ok(match c {
            '(' => {
                if self.eat('?') && !self.eat(':') {
                    return self.fail(at, "unsupported group syntax");
                }
                if self.nesting >= NESTING_LIMIT {
                    return self.fail(at, "groups are nested too deeply");
                }
                self.nesting += 1;
                let alts = self.parse_alts()?;
                self.nesting -= 1;
                if !self.eat(')') {
                    return self.fail(at, "unclosed group");
                }
                Node::Group(alts)
            }
            '[' => self.parse_class(at)?,
            '.' => Node::Any,
            '^' => Node::Start,
            '$' => Node::End,
            '\\' => match self.parse_escape(at)? {
                Escape::Char(c) => Node::Char(c),
                Escape::Class(item) => Node::Class { negated: false, items: vec![item] },
            },
            '*' | '+' | '?' => return self.fail(at, "nothing to repeat"),
            '{' => {
                if self.braces_at(self.pos)?.is_some() {
                    return self.fail(at, "nothing to repeat");
                }
                Node::Char('{')
            }
            other => Node::Char(other),
        })
    }

    fn parse_quantifier(&mut self, atom: Node) -> Result<Node, PatternError> {
        let at = self.offset();
        let (min, max) = match self.peek() {
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('?') => (0, Some(1)),
            Some('{') => match self.braces_at(self.pos + 1)? {
                Some((min, max, next)) => {
                    if max.is_some_and(|m| m < min) {
                        return self.fail(at, "repeat range is reversed");
                    }
                    self.pos = next - 1;
                    (min, max)
                }
                None => return Ok(atom),
            },
            _ => return Ok(atom),
        };
        self.pos += 1;
        let lazy = self.eat('?');
        if !lazy && self.peek() == Some('+') {
            return self.fail(self.offset(), "possessive quantifiers are not supported");
        }
        Ok(Node::Repeat(Rep { node: Box::new(atom), min, max, lazy }))
    }

    /// Reads `n}`, `n,}` or `n,m}` starting at `start`, just after a `{`. Gives the bounds and
    /// the index after the `}`, or `None` when the text is not a quantifier.
    fn braces_at(&self, start: usize) -> Result<Option<(u32, Option<u32>, usize)>, PatternError> {
        let Some((min, mut i)) = self.number(start)? else {
            return Ok(None);
        };
        let max = if self.char_at(i) == Some(',') {
            i += 1;
            match self.number(i)? {
                Some((m, next)) => {
                    i = next;
                    Some(m)
                }
                None => None,
            }
        } else {
            Some(min)
        };
        if self.char_at(i) != Some('}') {
            return Ok(None);
        }
        Ok(Some((min, max, i + 1)))
    }

    fn number(&self, start: usize) -> Result<Option<(u32, usize)>, PatternError> {
        let mut i = start;
        let mut value: u32 = 0;
        while let Some(digit) = self.char_at(i).and_then(|c| c.to_digit(10)) {
            let Some(next) = value.checked_mul(10).and_then(|v| v.checked_add(digit)) else {
                return self.fail(self.offset_at(start), "repeat count is too large");
            };
            value = next;
            i += 1;
        }
        Ok(if i == start { None } else { Some((value, i)) })
    }

    /// Reads an escape; `at` is the offset of its backslash.
    fn parse_escape(&mut self, at: usize) -> Result<Escape, PatternError> {
        let Some(c) = self.next() else {
            return self.fail(at, "trailing backslash");
        };
        Ok(match c {
            'd' => Escape::Class(ClassItem::Digit),
            'D' => Escape::Class(ClassItem::NotDigit),
            'w' => Escape::Class(ClassItem::Word),
            'W' => Escape::Class(ClassItem::NotWord),
            's' => Escape::Class(ClassItem::Space),
            'S' => Escape::Class(ClassItem::NotSpace),
            't' => Escape::Char('\t'),
            'n' => Escape::Char('\n'),
            'r' => Escape::Char('\r'),
            'f' => Escape::Char('\x0C'),
            'v' => Escape::Char('\x0B'),
            '0' => Escape::Char('\0'),
            'x' => Escape::Char(self.parse_hex(2, at)?),
            'u' => Escape::Char(self.parse_hex(4, at)?),
            c if c.is_ascii_alphanumeric() => return self.fail(at, "unsupported escape"),
            c => Escape::Char(c),
        })
    }

    fn parse_hex(&mut self, digits: usize, at: usize) -> Result<char, PatternError> {
        let mut value: u32 = 0;
        for _ in 0..digits {
            let Some(d) = self.peek().and_then(|c| c.to_digit(16)) else {
                return self.fail(at, "invalid hex escape");
            };
            value = value * 16 + d;
            self.pos += 1;
        }
        match char::from_u32(value) {
            Some(c) => Ok(c),
            None => self.fail(at, "invalid code point"),
        }
    }

    /// Reads a class after its `[`; `at` is the offset of that bracket.
    fn parse_class(&mut self, at: usize) -> Result<Node, PatternError> {
        let negated = self.eat('^');
        let mut items = Vec::new();
        loop {
            let item_at = self.offset();
            let Some(c) = self.next() else {
                return self.fail(at, "unclosed character class");
            };
            if c == ']' {
                break;
            }
            let lo = if c == '\\' {
                match self.parse_escape(item_at)? {
                    Escape::Class(item) => {
                        items.push(item);
                        continue;
                    }
                    Escape::Char(ch) => ch,
                }
            } else {
                c
            };
            let is_range =
                self.peek() == Some('-') && !matches!(self.char_at(self.pos + 1), None | Some(']'));
            if !is_range {
                items.push(ClassItem::Range(lo, lo));
                continue;
            }
            self.pos += 1;
            let hi_at = self.offset();
            let Some(hi_char) = self.next() else {
                return self.fail(at, "unclosed character class");
            };
            let hi = if hi_char == '\\' {
                match self.parse_escape(hi_at)? {
                    Escape::Char(ch) => ch,
                    Escape::Class(_) => return self.fail(item_at, "invalid range"),
                }
            } else {
                hi_char
            };
            if hi < lo {
                return self.fail(item_at, "reversed range");
            }
            items.push(ClassItem::Range(lo, hi));
        }
        if items.is_empty() {
            return self.fail(at, "empty character class");
        }
        Ok(Node::Class { negated, items })
    }
}

struct Matcher<'a> {
    text: &'a [char],
    steps: Cell<u32>,
    depth: Cell<u32>,
}

impl Matcher<'_> {
    /// Counts one step; false once the budget is spent.
    fn tick(&self) -> bool {
        let steps = self.steps.get();
        if steps >= STEP_BUDGET {
            return false;
        }
        self.steps.set(steps + 1);
        true
    }

    /// Counts one step and one level of nesting; false when either limit is reached.
    fn enter(&self) -> bool {
        let depth = self.depth.get();
        if depth >= DEPTH_LIMIT || !self.tick() {
            return false;
        }
        self.depth.set(depth + 1);
        true
    }

    fn leave(&self) {
        self.depth.set(self.depth.get() - 1);
    }

    fn is_single(node: &Node) -> bool {
        matches!(node, Node::Char(_) | Node::Any | Node::Class { .. })
    }

    /// Whether a one-character node accepts the character at `pos`.
    fn single(&self, node: &Node, pos: usize) -> bool {
        let Some(&c) = self.text.get(pos) else {
            return false;
        };
        match node {
            Node::Char(want) => c == *want,
            Node::Any => c != '\n',
            Node::Class { negated, items } => items.iter().any(|i| i.matches(c)) != *negated,
            _ => false,
        }
    }

    /// Matches `nodes` at `pos`, then calls `k` with the position after them.
    fn seq(&self, nodes: &[Node], pos: usize, k: &dyn Fn(usize) -> bool) -> bool {
        if !self.enter() {
            return false;
        }
        let result = match nodes.split_first() {
            None => k(pos),
            Some((first, rest)) => self.node(first, pos, &|p| self.seq(rest, p, k)),
        };
        self.leave();
        result
    }

    fn node(&self, node: &Node, pos: usize, k: &dyn Fn(usize) -> bool) -> bool {
        match node {
            Node::Start => pos == 0 && k(pos),
            Node::End => pos == self.text.len() && k(pos),
            Node::Group(alts) => alts.iter().any(|alt| self.seq(alt, pos, k)),
            Node::Repeat(rep) => self.repeat(rep, pos, k),
            _ => self.single(node, pos) && k(pos + 1),
        }
    }

    fn repeat(&self, rep: &Rep, pos: usize, k: &dyn Fn(usize) -> bool) -> bool {
        if !Self::is_single(&rep.node) {
            return self.rep_more(rep, 0, pos, k);
        }
        let mut avail = 0;
        while below(rep.max.map(|m| m as usize), avail) && self.single(&rep.node, pos + avail) {
            avail += 1;
        }
        let min = rep.min as usize;
        if avail < min {
            return false;
        }
        let counts: Vec<usize> =
            if rep.lazy { (min..=avail).collect() } else { (min..=avail).rev().collect() };
        counts.into_iter().any(|n| self.tick() && k(pos + n))
    }

    /// Repeats a multi-character node; `count` iterations are done and the next starts at `pos`.
    fn rep_more(&self, rep: &Rep, count: u32, pos: usize, k: &dyn Fn(usize) -> bool) -> bool {
        if !self.enter() {
            return false;
        }
        let can_more = below(rep.max, count);
        let more = || {
            can_more
                && self.node(&rep.node, pos, &|p| {
                    // An iteration that consumed nothing and is past the minimum adds nothing.
                    (p != pos || count < rep.min) && self.rep_more(rep, count + 1, p, k)
                })
        };
        let done = || count >= rep.min && k(pos);
        let result = if rep.lazy { done() || more() } else { more() || done() };
        self.leave();
        result
    }
}
