//! The layout ratchet (ADR-0063): generator source never types layout; the writer does.
//!
//! Three parts:
//!   1. the analyzer's own cases: layout it must catch, and writer-based code it must pass;
//!   2. the scope rule: which files are generator source, by rule and not by list;
//!   3. the ratchet over the real crate: every file with hand-typed layout is on the allowlist
//!      with a reason, every allowlisted file still needs its entry, and the allowlist only
//!      shrinks.
//!
//! Lint-gate exception (ADR-0063): part 3 reads the real generator source on purpose. The
//! ratchet is a chartered lint gate over source layout, the same per-port gate the TypeScript,
//! Python and C# ports run, so scanning the source tree is its contract and not a proxy for
//! behavior. The writer's behavior is covered by the writer-conformance tests, and what the
//! generators write by their golden and compile tests. The only-shrinks check compares with
//! local git refs and passes when they are absent, as in an export or a fresh clone.

#[path = "layout_ratchet/analyze.rs"]
mod analyze;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use analyze::{analyze, is_generator_source};

fn kinds(source: &str) -> Vec<&'static str> {
    let mut k: Vec<_> = analyze(source)
        .unwrap()
        .into_iter()
        .map(|f| f.kind)
        .collect();
    k.sort();
    k
}

// ── 1. the analyzer ──────────────────────────────────────────────────────────────────────

fn wrap(body: &str) -> String {
    format!("fn f(w: &mut W, xs: &[String], depth: usize, name: &str) {{ {body} }}")
}

#[test]
fn the_analyzer_catches_hand_typed_layout() {
    let cases: &[(&str, &str, &[&str])] = &[
        (
            "a newline escape",
            r#"let s = "a\nb";"#,
            &["newline-literal"],
        ),
        (
            "a unicode newline escape",
            r#"let s = "a\u{a}b";"#,
            &["newline-literal"],
        ),
        (
            "a carriage return",
            r#"let s = "a\r";"#,
            &["newline-literal"],
        ),
        (
            "a raw string that spans lines",
            "let s = r\"a\nb\";",
            &["newline-literal"],
        ),
        (
            "a newline char",
            r"let mut s = String::new(); s.push('\n');",
            &["newline-literal"],
        ),
        (
            "a line break inside format!",
            r#"let s = format!("{name}\n");"#,
            &["newline-literal"],
        ),
        (
            "writeln! writes a line",
            r#"writeln!(out, "class A").unwrap();"#,
            &["newline-literal"],
        ),
        (
            "a string that starts with two spaces",
            r#"let s = format!("  {name}");"#,
            &["indent-literal"],
        ),
        (
            "a string that starts with a tab",
            r#"let s = "\tx";"#,
            &["indent-literal"],
        ),
        (
            "a join on a newline",
            r#"let s = xs.join("\n");"#,
            &["newline-join", "newline-literal"],
        ),
        (
            "a repeat of spaces",
            r#"let pad = " ".repeat(depth * 4);"#,
            &["indent-repeat"],
        ),
        (
            "iter::repeat of a space",
            r#"let pad: String = std::iter::repeat(' ').take(depth).collect();"#,
            &["indent-repeat"],
        ),
        (
            "a literal inside a nested call",
            r#"w.line(format!("{}\n", name));"#,
            &["newline-literal"],
        ),
    ];
    for (name, body, expected) in cases {
        let mut want = expected.to_vec();
        want.sort();
        assert_eq!(kinds(&wrap(body)), want, "{name}");
    }
}

#[test]
fn a_newline_behind_a_same_file_constant_is_caught_where_it_is_used() {
    let src = "const NL: &str = \"\\n\";\nfn f(xs: &[String]) -> String {\n    xs.join(NL)\n}\n";
    let found: Vec<_> = analyze(src)
        .unwrap()
        .into_iter()
        .map(|f| (f.kind, f.line))
        .collect();
    assert_eq!(found, [("newline-literal", 1), ("newline-join", 3)]);
}

#[test]
fn the_constant_may_hide_behind_a_reference_or_a_conditional() {
    let src = "const NL: &str = \"\\n\";\nfn f(xs: &[String], c: bool) -> String {\n    let sep = if c { NL } else { \", \" };\n    xs.join(&sep)\n}\n";
    let joins: Vec<_> = analyze(src)
        .unwrap()
        .into_iter()
        .filter(|f| f.kind == "newline-join")
        .map(|f| f.line)
        .collect();
    assert_eq!(joins, [4]);
}

#[test]
fn findings_carry_the_line_and_column_of_the_literal() {
    let f = analyze("fn f() {\n    let s = \"x\\ny\";\n}\n").unwrap();
    assert_eq!(f.len(), 1);
    assert_eq!((f[0].line, f[0].column), (2, 13));
    assert_eq!(f[0].excerpt, "let s = \"x\\ny\";");
}

#[test]
fn the_analyzer_passes_code_that_leaves_layout_to_the_writer() {
    let passed = [
        r#"w.line("pub struct A {"); w.close("}");"#,
        r#"w.block("impl A", |w| { w.line("fn x() {}"); });"#,
        "// a comment may say \"a\\nb\" and writeln!(out)\nlet x = 1;",
        r#"let parts: Vec<_> = name.split('\n').collect();"#,
        r#"let has = name.contains("\n");"#,
        r#"let cleaned = name.replace("\n", " ");"#,
        r#"let first = name.split_once("\r\n");"#,
        r#"if name == "\n" { return; }"#,
        r#"match name.chars().next() { Some('\n') => {} _ => {} }"#,
        r#"let blank = matches!(name.chars().next(), Some(' ' | '\n'));"#,
        "w.text(\"fixed\n    code\n\");",
        r#"let s = xs.join(", ");"#,
        r#"let s = format!("{name} and {depth}");"#,
        r#"let pad = "ab".repeat(depth);"#,
    ];
    for src in passed {
        assert_eq!(analyze(&wrap(src)).unwrap(), [], "{src}");
    }
}

#[test]
fn doc_comments_attributes_and_test_code_are_not_output() {
    let src = r#"
/// A doc comment may show `"a\nb"`.
#[doc = "and so may an attribute: \n"]
pub fn f() {}

#[cfg(test)]
mod tests {
    #[test]
    fn t() { assert_eq!(super::g(), "a\nb\n"); }
}

#[test]
fn loose() { let _ = "  indented\n"; }
"#;
    assert_eq!(analyze(src).unwrap(), []);
}

// ── 2. the scope rule ────────────────────────────────────────────────────────────────────

#[test]
fn scope_is_decided_by_rule() {
    for (path, scanned) in [
        ("entity.rs", true),
        ("output_parser.rs", true),
        ("emitted/wire.rs", true),
        ("emitted/mod.rs", true),
        ("writer.rs", false),
        ("README.md", false),
    ] {
        assert_eq!(is_generator_source(path), scanned, "{path}");
    }
}

// ── 3. the ratchet over the real crate ───────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct Allowlist {
    unconverted: BTreeMap<String, String>,
    exempt: BTreeMap<String, String>,
}

impl Allowlist {
    fn entries(&self) -> BTreeMap<&str, &str> {
        self.unconverted
            .iter()
            .chain(&self.exempt)
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect()
    }
}

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn allowlist_path() -> PathBuf {
    crate_dir().join("tests/layout_ratchet/allowlist.json")
}

/// The sections in file order, so a test can see whether each is sorted.
fn read_allowlist(text: &str) -> (Allowlist, Vec<Vec<String>>) {
    let v: serde_json::Value = serde_json::from_str(text).expect("allowlist.json parses");
    let mut order = Vec::new();
    let mut section = |name: &str| {
        let mut m = BTreeMap::new();
        let mut keys = Vec::new();
        if let Some(obj) = v.get(name).and_then(|s| s.as_object()) {
            for (k, r) in obj {
                keys.push(k.clone());
                m.insert(
                    k.clone(),
                    r.as_str().expect("a reason is a string").to_string(),
                );
            }
        }
        order.push(keys);
        m
    };
    let unconverted = section("unconverted");
    let exempt = section("exempt");
    (
        Allowlist {
            unconverted,
            exempt,
        },
        order,
    )
}

fn current() -> (Allowlist, Vec<Vec<String>>) {
    read_allowlist(&std::fs::read_to_string(allowlist_path()).unwrap())
}

fn rs_files(dir: &Path, base: &Path, out: &mut Vec<String>) {
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            rs_files(&p, base, out);
        } else {
            out.push(
                p.strip_prefix(base)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

fn findings() -> BTreeMap<String, Vec<analyze::Finding>> {
    let src = crate_dir().join("src");
    let mut files = Vec::new();
    rs_files(&src, &src, &mut files);
    files
        .into_iter()
        .filter(|f| is_generator_source(f))
        .map(|f| {
            let text = std::fs::read_to_string(src.join(&f)).unwrap();
            let found = analyze(&text).unwrap_or_else(|e| panic!("{f} does not parse: {e}"));
            (f, found)
        })
        .collect()
}

#[test]
fn it_reads_the_generator_crate() {
    let f = findings();
    assert!(f.contains_key("entity.rs") && f.contains_key("emitted/wire.rs"));
    assert!(!f.contains_key("writer.rs"));
}

#[test]
fn no_generator_source_types_layout_unless_its_file_is_allowlisted() {
    let (list, _) = current();
    let entries = list.entries();
    let offenders: Vec<String> = findings()
        .into_iter()
        .filter(|(f, found)| !found.is_empty() && !entries.contains_key(f.as_str()))
        .map(|(f, found)| {
            let lines: Vec<String> = found
                .iter()
                .take(5)
                .map(|x| format!("  {}:{} {} {}", x.line, x.column, x.kind, x.excerpt))
                .collect();
            format!("{f} ({})\n{}", found.len(), lines.join("\n"))
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "Write these lines through the CodeWriter (src/writer.rs) instead of typing line breaks or \
         indentation. A file is never added to the allowlist: it only shrinks.\n{}",
        offenders.join("\n")
    );
}

#[test]
fn every_allowlisted_file_still_needs_its_entry() {
    let (list, _) = current();
    let found = findings();
    let stale: Vec<&str> = list
        .entries()
        .into_keys()
        .filter(|f| found.get(*f).is_none_or(|x| x.is_empty()))
        .collect();
    assert!(
        stale.is_empty(),
        "these files no longer type layout (or no longer exist): remove their allowlist entries: {}",
        stale.join(", ")
    );
}

#[test]
fn every_entry_is_scoped_and_carries_a_written_reason() {
    let (list, _) = current();
    for (file, reason) in list.entries() {
        assert!(
            is_generator_source(file),
            "{file} is not in the ratchet's scope"
        );
        assert!(
            crate_dir().join("src").join(file).exists(),
            "{file} does not exist"
        );
        assert!(reason.len() > 40, "{file} needs a reason");
    }
}

#[test]
fn a_file_is_unconverted_or_exempt_never_both_and_each_list_is_sorted() {
    let (list, order) = current();
    assert!(
        list.unconverted
            .keys()
            .all(|k| !list.exempt.contains_key(k))
    );
    for keys in order {
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }
}

/// What the allowlist gained from `before` to `now`: an added entry, or an unconverted file
/// relabelled exempt. A removal is not growth.
fn growth(before: &Allowlist, now: &Allowlist) -> Vec<String> {
    let had: BTreeSet<&str> = before.entries().into_keys().collect();
    let mut out: Vec<String> = now
        .entries()
        .into_keys()
        .filter(|f| !had.contains(f))
        .map(|f| format!("added {f}"))
        .collect();
    out.extend(
        now.exempt
            .keys()
            .filter(|f| before.unconverted.contains_key(*f))
            .map(|f| format!("relabelled {f} as exempt")),
    );
    out
}

#[test]
fn growth_is_an_added_entry_or_a_relabel_and_removal_is_not() {
    let list = |u: &[&str], e: &[&str]| Allowlist {
        unconverted: u.iter().map(|k| (k.to_string(), "r".into())).collect(),
        exempt: e.iter().map(|k| (k.to_string(), "r".into())).collect(),
    };
    let before = list(&["a.rs", "b.rs"], &["c.rs"]);
    assert!(growth(&before, &list(&["a.rs"], &[])).is_empty());
    assert_eq!(
        growth(&before, &list(&["a.rs", "d.rs"], &["c.rs"])),
        ["added d.rs"]
    );
    assert_eq!(
        growth(&before, &list(&["a.rs"], &["b.rs", "c.rs"])),
        ["relabelled b.rs as exempt"]
    );
}

fn git(repo: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The allowlist may only shrink. Compared with the copy at the merge base of every
/// integration branch this checkout knows: an entry that is not there was added here. Quiet
/// when git or those refs are unavailable, and for the branch that introduces the allowlist,
/// which has no earlier copy to compare with.
#[test]
fn the_allowlist_only_shrinks() {
    let repo = crate_dir().join("../../..");
    let Some(top) = git(&repo, &["rev-parse", "--show-toplevel"]) else {
        return;
    };
    let top = PathBuf::from(top.trim());
    let rel = allowlist_path()
        .canonicalize()
        .unwrap()
        .strip_prefix(top.canonicalize().unwrap())
        .unwrap()
        .to_string_lossy()
        .replace('\\', "/");
    let refs = git(
        &top,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin/main",
            "refs/remotes/origin/release/",
        ],
    )
    .unwrap_or_default();
    let (now, _) = current();
    for reference in refs.split_whitespace() {
        let Some(base) = git(&top, &["merge-base", "HEAD", reference]) else {
            continue;
        };
        let Some(text) = git(&top, &["show", &format!("{}:{rel}", base.trim())]) else {
            continue;
        };
        let grown = growth(&read_allowlist(&text).0, &now);
        assert!(
            grown.is_empty(),
            "the allowlist grew since the merge base with {reference}; convert the file to the writer instead: {}",
            grown.join(", ")
        );
    }
}
