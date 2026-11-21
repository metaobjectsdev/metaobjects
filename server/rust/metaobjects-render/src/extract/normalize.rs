//! FR-011 enum-variant normalization, ASCII-only by design so it is byte-identical across
//! ports and immune to locale case-folding. Mirrors `normalize.py` and the TS, C# and Java
//! ports.

/// Exact match only.
pub const NONE: &str = "none";
/// ASCII upper-case, trim, and collapse runs of whitespace, `_` and `-` to one `_`.
pub const COLLAPSE: &str = "collapse";
/// ASCII upper-case and keep only `[A-Z0-9]`.
pub const STRIP: &str = "strip";
/// The mode when none is declared.
pub const DEFAULT: &str = STRIP;

/// The JS `\s` class plus `_` and `-`.
fn is_separator(c: char) -> bool {
    matches!(
        c,
        '_' | '-'
            | ' '
            | '\t'
            | '\n'
            | '\u{0B}'
            | '\u{0C}'
            | '\r'
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
            | '\u{2000}'..='\u{200A}'
    )
}

/// Normalize `s` under `mode`; an unknown mode is `strip`.
#[must_use]
pub fn normalize_enum(s: &str, mode: &str) -> String {
    if mode == NONE {
        return s.to_string();
    }
    let up = s.trim().to_ascii_uppercase();
    if mode == COLLAPSE {
        let mut out = String::with_capacity(up.len());
        let mut in_run = false;
        for c in up.chars() {
            if is_separator(c) {
                if !in_run {
                    out.push('_');
                    in_run = true;
                }
            } else {
                out.push(c);
                in_run = false;
            }
        }
        out
    } else {
        up.chars()
            .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes() {
        assert_eq!(normalize_enum(" in-progress ", STRIP), "INPROGRESS");
        assert_eq!(normalize_enum("in - progress", COLLAPSE), "IN_PROGRESS");
        assert_eq!(normalize_enum("x", NONE), "x");
        assert_eq!(normalize_enum("é-a", STRIP), "A");
    }
}
