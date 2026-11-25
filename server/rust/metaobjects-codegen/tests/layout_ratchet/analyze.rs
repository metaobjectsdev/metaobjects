//! The layout ratchet's analyzer (ADR-0063): finds layout a generator typed by hand.
//!
//! Generators say what a line contains and the writer decides where it sits, so generator
//! source should never spell a line break or an indentation run. This parses a source file
//! with `syn` and walks the syntax tree. Working on the tree, not the text, is what makes the
//! rules exact: comments and doc comments are never literals, a string's value is the
//! parser's value (so `"\n"` and a line break inside a raw string are the same finding), a
//! macro's arguments (`format!`, `writeln!`) are parsed as the expressions they are, and a
//! constant is followed to its same-file definition, so `const NL: &str = "\n"; xs.join(NL)`
//! is a finding at the join as well as at the constant.
//!
//! Four rules, the same four as every port's ratchet:
//!
//! - `newline-literal`: a string or char literal whose value contains a line break, and a
//!   `writeln!`, which writes one.
//! - `indent-literal`: a string literal that begins with an indentation run (two or more
//!   spaces, or a tab).
//! - `newline-join`: `xs.join(sep)` whose separator, resolved through same-file constants,
//!   contains a line break.
//! - `indent-repeat`: `s.repeat(n)` or `std::iter::repeat(s)` where `s` resolves to
//!   whitespace: building indentation.
//!
//! Places a literal is not output, and so is not layout, are ruled out by position:
//!
//! - an attribute (doc comments among them), and test code (`#[cfg(test)]`, `#[test]`);
//! - a search pattern: the first argument of `split`, `lines`-style searches, `contains`,
//!   `starts_with`, `ends_with`, `find`, `rfind`, `matches`, `replace`, `replacen`,
//!   `strip_prefix`, `strip_suffix`, `trim_matches`, `trim_start_matches`, `trim_end_matches`,
//!   `split_once`, `rsplit_once`, `split_terminator`, `rsplit`, `splitn` or `rsplitn`;
//! - a comparison operand (`x == "\n"`) and a pattern (a `match` arm, `matches!`'s second
//!   argument): it is read, not written;
//! - a writer snippet: the argument of a `.text(...)` call, the writer's entry for fixed code
//!   written as it should read.

use std::collections::HashMap;

use proc_macro2::Span;
use syn::punctuated::Punctuated;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{BinOp, Expr, Lit, Token};

/// One piece of hand-typed layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub kind: &'static str,
    pub line: usize,
    pub column: usize,
    pub excerpt: String,
}

const SEARCH_METHODS: &[&str] = &[
    "split",
    "rsplit",
    "splitn",
    "rsplitn",
    "split_terminator",
    "split_once",
    "rsplit_once",
    "contains",
    "starts_with",
    "ends_with",
    "find",
    "rfind",
    "matches",
    "rmatches",
    "match_indices",
    "replace",
    "replacen",
    "strip_prefix",
    "strip_suffix",
    "trim_matches",
    "trim_start_matches",
    "trim_end_matches",
];
const SNIPPET_METHOD: &str = "text";
const MAX_RESOLVE_DEPTH: usize = 8;

/// Scope by rule, not by list: every `.rs` file under `src/` of the generator crate except the
/// writer itself. `path` is relative to the crate's `src/`.
pub fn is_generator_source(path: &str) -> bool {
    path.ends_with(".rs") && path != "writer.rs" && !path.starts_with("writer/")
}

/// The findings in `source`, in line and column order.
pub fn analyze(source: &str) -> Result<Vec<Finding>, String> {
    let file = syn::parse_file(source).map_err(|e| e.to_string())?;
    let mut consts = HashMap::new();
    collect_consts(&file, &mut consts);
    let mut a = Analyzer {
        lines: source.lines().collect(),
        consts,
        findings: Vec::new(),
    };
    a.visit_file(&file);
    a.findings
        .sort_by(|x, y| (x.line, x.column, x.kind).cmp(&(y.line, y.column, y.kind)));
    Ok(a.findings)
}

/// Every same-file `const`, `static` and single-name `let` with an initializer, by name.
fn collect_consts(file: &syn::File, out: &mut HashMap<String, Expr>) {
    struct C<'a>(&'a mut HashMap<String, Expr>);
    impl<'ast> Visit<'ast> for C<'_> {
        fn visit_item_const(&mut self, i: &'ast syn::ItemConst) {
            self.0.insert(i.ident.to_string(), (*i.expr).clone());
            visit::visit_item_const(self, i);
        }
        fn visit_item_static(&mut self, i: &'ast syn::ItemStatic) {
            self.0.insert(i.ident.to_string(), (*i.expr).clone());
            visit::visit_item_static(self, i);
        }
        fn visit_local(&mut self, i: &'ast syn::Local) {
            let name = match &i.pat {
                syn::Pat::Ident(p) => Some(p.ident.to_string()),
                syn::Pat::Type(t) => match &*t.pat {
                    syn::Pat::Ident(p) => Some(p.ident.to_string()),
                    _ => None,
                },
                _ => None,
            };
            if let (Some(name), Some(init)) = (name, &i.init) {
                self.0.insert(name, (*init.expr).clone());
            }
            visit::visit_local(self, i);
        }
    }
    C(out).visit_file(file);
}

struct Resolved {
    text: String,
    complete: bool,
}

struct Analyzer<'s> {
    lines: Vec<&'s str>,
    consts: HashMap<String, Expr>,
    findings: Vec<Finding>,
}

fn is_test_attr(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| {
        let p = a.path();
        if p.is_ident("test") {
            return true;
        }
        if p.is_ident("cfg") {
            let mut test = false;
            let _ = a.parse_nested_meta(|m| {
                if m.path.is_ident("test") {
                    test = true;
                }
                Ok(())
            });
            return test;
        }
        false
    })
}

fn has_line_break(s: &str) -> bool {
    s.contains('\n') || s.contains('\r')
}

fn starts_with_indent(s: &str) -> bool {
    s.starts_with("  ") || s.starts_with('\t')
}

fn is_whitespace(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| matches!(c, ' ' | '\t' | '\r' | '\n'))
}

impl Analyzer<'_> {
    fn add(&mut self, kind: &'static str, span: Span) {
        let start = span.start();
        let text = self
            .lines
            .get(start.line.wrapping_sub(1))
            .map(|l| l.trim())
            .unwrap_or("");
        self.findings.push(Finding {
            kind,
            line: start.line,
            column: start.column + 1,
            excerpt: text.chars().take(80).collect(),
        });
    }

    fn resolve(&self, e: &Expr, depth: usize) -> Option<Resolved> {
        if depth > MAX_RESOLVE_DEPTH {
            return None;
        }
        match e {
            Expr::Lit(l) => match &l.lit {
                Lit::Str(s) => Some(Resolved {
                    text: s.value(),
                    complete: true,
                }),
                Lit::Char(c) => Some(Resolved {
                    text: c.value().to_string(),
                    complete: true,
                }),
                _ => None,
            },
            Expr::Path(p) if p.qself.is_none() => {
                let name = p.path.get_ident()?.to_string();
                self.resolve(self.consts.get(&name)?, depth + 1)
            }
            Expr::Reference(r) => self.resolve(&r.expr, depth + 1),
            Expr::Paren(p) => self.resolve(&p.expr, depth + 1),
            Expr::Group(g) => self.resolve(&g.expr, depth + 1),
            Expr::If(i) => {
                // Either branch of a conditional separator counts.
                let then = i.then_branch.stmts.last().and_then(|s| match s {
                    syn::Stmt::Expr(e, None) => self.resolve(e, depth + 1),
                    _ => None,
                });
                let other = i
                    .else_branch
                    .as_ref()
                    .and_then(|(_, e)| self.resolve(e, depth + 1));
                let text = match (&then, &other) {
                    (Some(a), _) if has_line_break(&a.text) => a.text.clone(),
                    (_, Some(b)) => b.text.clone(),
                    (Some(a), None) => a.text.clone(),
                    (None, None) => return None,
                };
                Some(Resolved {
                    text,
                    complete: false,
                })
            }
            Expr::Block(b) => match b.block.stmts.last() {
                Some(syn::Stmt::Expr(e, None)) => self.resolve(e, depth + 1),
                _ => None,
            },
            _ => None,
        }
    }

    /// A macro's arguments as expressions, when they parse as a comma list.
    fn macro_args(mac: &syn::Macro) -> Option<Punctuated<Expr, Token![,]>> {
        mac.parse_body_with(Punctuated::<Expr, Token![,]>::parse_terminated)
            .ok()
    }
}

impl<'ast> Visit<'ast> for Analyzer<'_> {
    fn visit_attribute(&mut self, _: &'ast syn::Attribute) {}

    fn visit_item_mod(&mut self, i: &'ast syn::ItemMod) {
        if !is_test_attr(&i.attrs) {
            visit::visit_item_mod(self, i);
        }
    }

    fn visit_item_fn(&mut self, i: &'ast syn::ItemFn) {
        if !is_test_attr(&i.attrs) {
            visit::visit_item_fn(self, i);
        }
    }

    fn visit_impl_item_fn(&mut self, i: &'ast syn::ImplItemFn) {
        if !is_test_attr(&i.attrs) {
            visit::visit_impl_item_fn(self, i);
        }
    }

    fn visit_pat(&mut self, _: &'ast syn::Pat) {
        // A pattern matches a value; it writes nothing.
    }

    fn visit_lit_str(&mut self, s: &'ast syn::LitStr) {
        let v = s.value();
        if has_line_break(&v) {
            self.add("newline-literal", s.span());
        }
        if starts_with_indent(&v) {
            self.add("indent-literal", s.span());
        }
    }

    fn visit_lit_char(&mut self, c: &'ast syn::LitChar) {
        if matches!(c.value(), '\n' | '\r') {
            self.add("newline-literal", c.span());
        }
    }

    fn visit_expr_binary(&mut self, b: &'ast syn::ExprBinary) {
        // A comparison reads a value; it writes nothing.
        if matches!(b.op, BinOp::Eq(_) | BinOp::Ne(_)) {
            return;
        }
        visit::visit_expr_binary(self, b);
    }

    fn visit_expr_method_call(&mut self, m: &'ast syn::ExprMethodCall) {
        let name = m.method.to_string();
        self.visit_expr(&m.receiver);
        if name == SNIPPET_METHOD {
            return;
        }
        let skip_first = SEARCH_METHODS.contains(&name.as_str());
        if name == "join"
            && let Some(sep) = m.args.first()
            && self
                .resolve(sep, 0)
                .is_some_and(|r| has_line_break(&r.text))
        {
            self.add("newline-join", m.method.span());
        }
        if name == "repeat"
            && self
                .resolve(&m.receiver, 0)
                .is_some_and(|r| r.complete && is_whitespace(&r.text))
        {
            self.add("indent-repeat", m.method.span());
        }
        for (i, a) in m.args.iter().enumerate() {
            if !(skip_first && i == 0) {
                self.visit_expr(a);
            }
        }
    }

    fn visit_expr_call(&mut self, c: &'ast syn::ExprCall) {
        if let Expr::Path(p) = &*c.func
            && p.path.segments.last().is_some_and(|s| s.ident == "repeat")
            && let Some(arg) = c.args.first()
            && self
                .resolve(arg, 0)
                .is_some_and(|r| r.complete && is_whitespace(&r.text))
        {
            self.add("indent-repeat", p.span());
        }
        visit::visit_expr_call(self, c);
    }

    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let name = mac
            .path
            .segments
            .last()
            .map(|s| s.ident.to_string())
            .unwrap_or_default();
        if name == "writeln" {
            self.add("newline-literal", mac.path.span());
        }
        if let Some(args) = Self::macro_args(mac) {
            // `matches!(value, pattern)`: only the value is an expression.
            let take = if name == "matches" { 1 } else { args.len() };
            for a in args.iter().take(take) {
                self.visit_expr(a);
            }
        }
    }
}
