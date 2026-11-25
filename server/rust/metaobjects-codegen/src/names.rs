//! Rust spellings of metadata names: types, fields, crates, modules and literals.
//!
//! Pure functions; nothing here reads a model.

/// Words that cannot be a plain identifier in edition 2021 or 2024 (strict, reserved and
/// the `gen` keyword the 2024 edition adds). `self`, `Self`, `super` and `crate` cannot be
/// raw identifiers either; [`field_ident`] and [`type_ident`] handle them separately.
const KEYWORDS: &[&str] = &[
    "abstract", "as", "async", "await", "become", "box", "break", "const", "continue", "do", "dyn",
    "else", "enum", "extern", "false", "final", "fn", "for", "gen", "if", "impl", "in", "let",
    "loop", "macro", "match", "mod", "move", "mut", "override", "priv", "pub", "ref", "return",
    "static", "struct", "trait", "true", "try", "type", "typeof", "unsafe", "unsized", "use",
    "virtual", "where", "while", "yield",
];

/// Keywords no `r#` prefix rescues.
const NO_RAW: &[&str] = &["self", "Self", "super", "crate"];

/// Std types a generated file names unqualified; an object with one of these names makes the
/// crate spell the std type by its full path instead (see `entity::Types`).
pub const PRELUDE_TYPES: &[&str] = &["String", "Vec", "Option", "Box"];

/// `user_profile`, `USER_PROFILE`, `userProfile`, `user-profile` become `UserProfile`;
/// `User` stays `User`; `ID` becomes `Id`. Splits on `_`, `-` and spaces only, so an
/// already-capitalised word such as `HTTPServer` keeps its spelling.
pub fn pascal(symbol: &str) -> String {
    let all_upper = symbol == symbol.to_uppercase() && symbol.chars().any(char::is_alphabetic);
    let mut out = String::with_capacity(symbol.len());
    for part in symbol.split(['_', '-', ' ']).filter(|p| !p.is_empty()) {
        let part = if all_upper {
            part.to_lowercase()
        } else {
            part.to_string()
        };
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

/// `userId` becomes `user_id`, `HTTPServer` becomes `http_server`, `address2Line` becomes
/// `address2_line`, `in-flight` becomes `in_flight`.
pub fn snake(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        if c == '-' || c == ' ' {
            out.push('_');
            continue;
        }
        if c.is_uppercase() && i > 0 {
            let prev = chars[i - 1];
            let next_is_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
            let boundary = prev.is_lowercase()
                || prev.is_ascii_digit()
                || (prev.is_uppercase() && next_is_lower);
            if boundary && !out.ends_with('_') {
                out.push('_');
            }
        }
        out.extend(c.to_lowercase());
    }
    out
}

fn is_ident_text(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c == '_' || c.is_alphabetic())
        && chars.all(|c| c == '_' || c.is_alphanumeric())
}

/// A field or module identifier for `name`: snake case, `r#`-escaped when it is a keyword,
/// suffixed with `_` when no escape exists, prefixed with `_` when it would start with a digit.
pub fn field_ident(name: &str) -> String {
    let mut s = snake(name);
    if !is_ident_text(&s) {
        s = s
            .chars()
            .map(|c| {
                if c == '_' || c.is_alphanumeric() {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        if s.chars().next().is_none_or(|c| c.is_ascii_digit()) {
            s.insert(0, '_');
        }
    }
    if NO_RAW.contains(&s.as_str()) {
        s.push('_');
    } else if KEYWORDS.contains(&s.as_str()) {
        s.insert_str(0, "r#");
    }
    s
}

/// The identifier of a generated type or enum variant: [`pascal`], with `Self` made
/// distinct and a leading digit guarded.
pub fn type_ident(name: &str) -> String {
    let mut s = pascal(name);
    if !is_ident_text(&s) {
        s = s
            .chars()
            .map(|c| {
                if c == '_' || c.is_alphanumeric() {
                    c
                } else {
                    '_'
                }
            })
            .collect();
    }
    if s.chars().next().is_none_or(|c| c.is_ascii_digit()) {
        s.insert(0, '_');
    }
    if s == "Self" {
        s.push('_');
    }
    s
}

/// The module (file) name of a generated type: its snake-case spelling, never raw.
pub fn module_name(type_name: &str) -> String {
    let m = snake(type_name);
    let m = field_ident(&m);
    match m.strip_prefix("r#") {
        Some(rest) => format!("{rest}_"),
        None => m,
    }
}

/// The crate (and directory) name of a metadata package: each `::` segment in snake case,
/// joined with `_`. `acme::billing::v2` becomes `acme_billing_v2`; the empty package becomes
/// `model`. A name that starts with a digit gets a `p_` prefix.
pub fn crate_name(package: &str) -> String {
    if package.is_empty() {
        return "model".to_string();
    }
    let mut out = String::new();
    for seg in package.split("::").filter(|s| !s.is_empty()) {
        if !out.is_empty() {
            out.push('_');
        }
        for c in snake(seg).chars() {
            out.push(if c == '_' || c.is_ascii_alphanumeric() {
                c
            } else {
                '_'
            });
        }
    }
    if out.is_empty() {
        return "model".to_string();
    }
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert_str(0, "p_");
    }
    out
}

/// A Rust string literal for `text`.
pub fn literal(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{{{:x}}}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pascal_keeps_capitalised_words_and_lowers_all_caps() {
        assert_eq!(pascal("User"), "User");
        assert_eq!(pascal("user_profile"), "UserProfile");
        assert_eq!(pascal("IN_FLIGHT"), "InFlight");
        assert_eq!(pascal("ID"), "Id");
        assert_eq!(pascal("HTTPServer"), "HTTPServer");
        assert_eq!(pascal("userProfile"), "UserProfile");
    }

    #[test]
    fn snake_splits_camel_acronyms_and_digits() {
        assert_eq!(snake("userId"), "user_id");
        assert_eq!(snake("HTTPServer"), "http_server");
        assert_eq!(snake("address2Line"), "address2_line");
        assert_eq!(snake("in-flight"), "in_flight");
        assert_eq!(snake("id"), "id");
        assert_eq!(snake("user_id"), "user_id");
    }

    #[test]
    fn identifiers_escape_keywords_and_unescapable_words() {
        assert_eq!(field_ident("type"), "r#type");
        assert_eq!(field_ident("gen"), "r#gen");
        assert_eq!(field_ident("self"), "self_");
        assert_eq!(field_ident("crate"), "crate_");
        assert_eq!(field_ident("userName"), "user_name");
        assert_eq!(field_ident("9lives"), "_9lives");
        assert_eq!(type_ident("self"), "Self_");
        assert_eq!(type_ident("order"), "Order");
        assert_eq!(module_name("Type"), "type_");
        assert_eq!(module_name("OrderLine"), "order_line");
    }

    #[test]
    fn crate_names_join_package_segments() {
        assert_eq!(crate_name("acme::billing::v2"), "acme_billing_v2");
        assert_eq!(crate_name("fitness"), "fitness");
        assert_eq!(crate_name(""), "model");
        assert_eq!(crate_name("2fa"), "p_2fa");
        assert_eq!(crate_name("AcmeShop"), "acme_shop");
    }

    #[test]
    fn literals_are_escaped() {
        assert_eq!(literal("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"");
    }
}
