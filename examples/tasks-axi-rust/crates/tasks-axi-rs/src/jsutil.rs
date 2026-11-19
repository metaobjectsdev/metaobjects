//! JavaScript string semantics the markdown backlog grammar leans on.

/// JavaScript's `\s` set (also what `String.prototype.trim` strips).
pub use tasks_axi_gen::cli::{is_js_space, js_trim};

/// `String.prototype.length`: the number of UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `String.prototype.slice(0, n)` for text a JavaScript program then writes to stdout as UTF-8.
/// A cut that falls between the halves of a surrogate pair leaves a lone high surrogate, which
/// the UTF-8 encoder writes as U+FFFD.
pub fn slice_utf16(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            if units < n {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        units += w;
    }
    out
}

/// `semanticLine`: a line without its one trailing carriage return.
pub fn semantic_line(line: &str) -> &str {
    line.strip_suffix('\r').unwrap_or(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_count_utf16_units() {
        assert_eq!(utf16_len("a\u{1F600}b"), 4);
    }

    #[test]
    fn a_cut_inside_a_surrogate_pair_leaves_the_replacement_character() {
        assert_eq!(slice_utf16("ab\u{1F600}c", 3), "ab\u{FFFD}");
        assert_eq!(slice_utf16("ab\u{1F600}c", 4), "ab\u{1F600}");
        assert_eq!(slice_utf16("abc", 10), "abc");
    }
}
