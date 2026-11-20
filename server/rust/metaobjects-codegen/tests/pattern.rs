//! The full-match pattern matcher that generated crates carry for `validator.regex`.

use metaobjects_codegen::emitted::pattern::{Outcome, Pattern, PatternError, full_match, outcome};
use std::time::{Duration, Instant};

/// Each row is a pattern, the texts it must accept and the texts it must reject.
const CASES: &[(&str, &[&str], &[&str])] = &[
    ("[A-Z]+", &["A", "ABC"], &["xxABCyy", "", "AbC", "ABC "]),
    ("^[A-Z0-9-]+$", &["AB-12", "-", "9"], &["ab", "A B", ""]),
    (
        r"^\d{10}$",
        &["0123456789"],
        &["012345678", "01234567890", "012345678a"],
    ),
    ("^M[0-9]+$", &["M0", "M123"], &["M", "m1", "M1x"]),
    (
        r"^[A-Z]{3}-'\d+$",
        &["ABC-'123"],
        &["ABC-123", "AB-'1", "ABC-'"],
    ),
    ("[A-Z].*", &["A", "Abc def", "Z!"], &["abc", "", "A\nB"]),
    ("(a|ab)c", &["ac", "abc"], &["a", "abcc", "ab"]),
    ("a|ab", &["a", "ab"], &["abc", ""]),
    ("(ab)+", &["ab", "ababab"], &["", "aba", "abb"]),
    (
        "((a{2}b){2}c)+",
        &["aabaabc", "aabaabcaabaabc"],
        &["aabaab", "aabaabaabc"],
    ),
    ("a{2,4}", &["aa", "aaa", "aaaa"], &["a", "aaaaa", ""]),
    ("a{2,}", &["aa", "aaaaaa"], &["a", ""]),
    ("a{0}b", &["b"], &["ab"]),
    ("(?:x|y)z?", &["x", "yz"], &["xyz", "z"]),
    ("a*", &["", "aaa"], &["b", "aab"]),
    ("a?b", &["b", "ab"], &["aab", "a"]),
    ("a+?", &["a", "aaa"], &["", "ab"]),
    ("a*?b", &["b", "aab"], &["aa"]),
    ("<.+?>", &["<a>", "<a><b>"], &["<a", "a>"]),
    ("a{1,2}?a", &["aa", "aaa"], &["a", "aaaa"]),
    ("(a|b)*?c", &["c", "abc"], &["ab"]),
    ("[^0-9]+", &["abc", "a-b", "é"], &["a1", "", "7"]),
    (r"[^\s]+", &["abc"], &["a b", "a\tb"]),
    ("[^a-c]", &["d", "\n"], &["a", "c", "ab"]),
    (r"[\d_]+", &["1_2", "_"], &["a"]),
    (r"[\D]", &["a", "é"], &["1"]),
    (r"[a\-z]+", &["a-z", "-"], &["b"]),
    ("[-a]+", &["a-a"], &["b"]),
    ("[a-]+", &["a-a"], &["b"]),
    (r"[\]]", &["]"], &["["]),
    ("[[]", &["["], &["]"]),
    (".", &["a", "é", " "], &["\n", "", "ab"]),
    (".+", &["abc", "é!"], &["a\nb", "\n"]),
    ("é+", &["é", "éé"], &["", "e", "éa"]),
    ("日本", &["日本"], &["日", "本日"]),
    (r"\w+", &["abc_9", "A"], &["é", "a-b", ""]),
    (r"\W", &["é", "-", " "], &["a", "_", "5"]),
    (r"\d\D", &["1a", "1é"], &["12", "a1"]),
    (r"\s+", &[" \t\n\r\x0B\x0C"], &["a", ""]),
    (r"\S+", &["abc", "é"], &["a b"]),
    (r"\t\n\r\f\v\0", &["\t\n\r\x0C\x0B\0"], &["\t"]),
    (r"\x41éA", &["AéA"], &["aéA"]),
    (r"\.\\\/\-\[\(\'", &[r".\/-[('"], &["a"]),
    ("a{", &["a{"], &["a"]),
    ("a{,2}", &["a{,2}"], &["a", "aa"]),
    ("a{x}", &["a{x}"], &["a"]),
    ("a}", &["a}"], &["a"]),
    ("{", &["{"], &[""]),
    ("^abc$", &["abc"], &["abcd", "xabc"]),
    ("^$", &[""], &["a"]),
    ("", &[""], &["a"]),
    ("a|", &["a", ""], &["b"]),
    ("a^b", &[], &["ab", "a^b"]),
    ("(^a)b", &["ab"], &["b"]),
    ("a|b|c", &["a", "b", "c"], &["d", "ab"]),
    ("(a*)*", &["", "aaa"], &["b", "aab"]),
    ("(a*)+b", &["b", "aab"], &["a"]),
    ("(a|b*)*c", &["c", "abbac"], &["abd"]),
];

#[test]
fn accepts_and_rejects_by_full_match() {
    for (pattern, accepts, rejects) in CASES {
        let parsed = Pattern::parse(pattern).unwrap_or_else(|e| panic!("{pattern:?}: {e}"));
        for text in *accepts {
            assert!(
                parsed.is_full_match(text),
                "{pattern:?} should accept {text:?}"
            );
            assert!(
                full_match(pattern, text),
                "{pattern:?} should accept {text:?}"
            );
        }
        for text in *rejects {
            assert!(
                !parsed.is_full_match(text),
                "{pattern:?} should reject {text:?}"
            );
            assert!(
                !full_match(pattern, text),
                "{pattern:?} should reject {text:?}"
            );
        }
    }
}

/// Each row is a refused pattern and the byte offset the error points at.
const REFUSED: &[(&str, usize)] = &[
    ("(?=a)", 0),
    ("a(?!b)", 1),
    ("(?<=a)b", 0),
    ("(?<n>a)", 0),
    ("(?i)a", 0),
    (r"\1", 0),
    (r"\b", 0),
    (r"\B", 0),
    (r"\p{L}", 0),
    (r"\k<n>", 0),
    (r"ab\q", 2),
    (r"\d\1", 2),
    ("*", 0),
    ("a|+", 2),
    ("(*a)", 1),
    ("?", 0),
    ("{2}", 0),
    ("a**", 2),
    ("a{2}{3}", 4),
    ("a{3,2}", 1),
    ("a*+", 2),
    ("a++", 2),
    ("a?+", 2),
    ("a{4294967296}", 2),
    ("[]", 0),
    ("[^]", 0),
    ("[]a]", 0),
    ("[z-a]", 1),
    ("[a-\\d]", 1),
    ("[a", 0),
    ("x[a-", 1),
    ("(a", 0),
    ("(a|b", 0),
    ("a)", 1),
    ("(a))", 3),
    ("\\", 0),
    ("a\\", 1),
    (r"\xZ1", 0),
    (r"\x4", 0),
    (r"\u12", 0),
    (r"\ud800", 0),
    (r"[\q]", 1),
];

#[test]
fn refused_constructs_report_their_offset() {
    for (source, at) in REFUSED {
        match Pattern::parse(source) {
            Ok(_) => panic!("{source:?} should be refused"),
            Err(e) => assert_eq!(e.at, *at, "{source:?}: {e}"),
        }
        assert!(!full_match(source, ""), "{source:?} must match nothing");
        assert!(!full_match(source, "a"), "{source:?} must match nothing");
    }
}

#[test]
fn offsets_are_bytes_not_characters() {
    let err = Pattern::parse("é(?=a)").unwrap_err();
    assert_eq!(err.at, 2);
}

#[test]
fn error_display_names_message_and_offset() {
    let err = PatternError {
        at: 3,
        message: "nothing to repeat".to_string(),
    };
    assert_eq!(err.to_string(), "nothing to repeat at offset 3");
    let parsed = Pattern::parse("ab*+").unwrap_err();
    assert!(parsed.to_string().ends_with("at offset 3"), "{parsed}");
    let boxed: Box<dyn std::error::Error> = Box::new(parsed);
    assert!(!boxed.to_string().is_empty());
}

#[test]
fn unparseable_pattern_matches_nothing() {
    assert!(!full_match("(", ""));
    assert!(!full_match("[", "["));
    assert!(!full_match(r"\1", "1"));
    assert!(full_match("a", "a"));
}

#[test]
fn empty_loops_terminate() {
    for pattern in [
        "(a*)*", "(a*)+", "(a?)*", "((a*)*)*", "(a*|b*)*", "(|a)*", "(a*){3,}", "(^)*",
    ] {
        let parsed = Pattern::parse(pattern).unwrap();
        let start = Instant::now();
        assert!(parsed.is_full_match(""), "{pattern}");
        assert!(parsed.is_full_match("aaaa") || pattern.contains('b') || pattern == "(^)*");
        assert!(!parsed.is_full_match("aaaac"), "{pattern}");
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "{pattern} took too long"
        );
    }
}

#[test]
fn pathological_patterns_give_up_instead_of_answering() {
    let start = Instant::now();
    let text = "a".repeat(64);
    for pattern in ["(a*)*b", "(a|a)*b", "(a+)+b", "((a*)*)*b"] {
        assert_eq!(outcome(pattern, &text), Outcome::GaveUp, "{pattern}");
        assert!(!full_match(pattern, &text), "{pattern}");
    }
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "budget did not stop the match"
    );
}

#[test]
fn a_give_up_is_neither_a_match_nor_a_mismatch() {
    assert_eq!(
        outcome("(a+)+b", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"),
        Outcome::Match
    );
    assert_eq!(outcome("(a+)+b", "bb"), Outcome::NoMatch);
    assert_eq!(outcome("(a+)+b", &"a".repeat(64)), Outcome::GaveUp);
    assert_eq!(outcome("(", "a"), Outcome::NoMatch);
}

#[test]
fn long_inputs_do_not_overflow_the_stack() {
    let text = "a".repeat(200_000);
    assert_eq!(outcome("a*", &text), Outcome::Match);
    assert_eq!(outcome(".*", &text), Outcome::Match);
    assert_eq!(outcome("[a-z]+", &text), Outcome::Match);
    assert_eq!(outcome("(a)*", &text), Outcome::Match);
    assert_eq!(outcome("(?:a|b)+", &text), Outcome::Match);
    assert_eq!(outcome("(ab)*", &"ab".repeat(100_000)), Outcome::Match);
    assert_eq!(outcome("(ab)*", &format!("{text}b")), Outcome::NoMatch);
    let words = "word ".repeat(40_000);
    assert_eq!(outcome(r"(\w+\s?)*", &words), Outcome::Match);
    assert_eq!(outcome(r"(\w+\s)*", &format!("{words}!")), Outcome::NoMatch);
    let deep = format!("{}a{}", "(".repeat(5_000), ")".repeat(5_000));
    assert!(Pattern::parse(&deep).is_err());
    assert!(!full_match(&deep, "a"));
}

#[test]
fn a_few_hundred_characters_match_a_repeated_group() {
    let sentence = "the quick brown fox jumps over the lazy dog ".repeat(10);
    assert_eq!(outcome(r"^(\w+\s?)*$", &sentence), Outcome::Match);
    assert_eq!(outcome("^(a)*$", &"a".repeat(500)), Outcome::Match);
}

#[test]
fn moderate_group_repeats_still_match() {
    assert!(full_match("(ab)*", &"ab".repeat(100)));
    assert!(full_match("(?:a|b)+", &"ab".repeat(100)));
}

#[test]
fn validate_reports_a_give_up_as_its_own_violation() {
    use metaobjects_codegen::emitted::validation::{self, RULE_REGEX};

    let mut out = Vec::new();
    validation::pattern(&mut out, "code", Some("bb"), "(a+)+b");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].rule, RULE_REGEX);
    assert_eq!(out[0].message, "'code' does not match required pattern");

    let mut out = Vec::new();
    validation::pattern(&mut out, "code", Some(&"a".repeat(64)), "(a+)+b");
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].rule, RULE_REGEX);
    assert_eq!(
        out[0].message,
        "'code' pattern could not be evaluated within limits"
    );

    let mut out = Vec::new();
    validation::pattern(&mut out, "code", Some("aab"), "(a+)+b");
    validation::pattern(&mut out, "code", None, "(a+)+b");
    assert!(out.is_empty());
}
