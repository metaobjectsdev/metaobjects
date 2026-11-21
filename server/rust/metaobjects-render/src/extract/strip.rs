//! Stage 1: remove markdown code-fence markers. Prose around the payload is left for
//! `locate`. Mirrors `strip.py`.

struct Fence {
    start: usize,
    end: usize,
    body_start: usize,
    body_end: usize,
}

/// An opening fence at `i`: three or more backticks, an optional language tag, then
/// whitespace that holds a line end. Returns `(run width, index just past the last line
/// end of that whitespace)`.
fn open_at(b: &[u8], i: usize) -> Option<(usize, usize)> {
    let mut j = i;
    while j < b.len() && b[j] == b'`' {
        j += 1;
    }
    let width = j - i;
    if width < 3 {
        return None;
    }
    while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b'-') {
        j += 1;
    }
    let mut last_nl = None;
    while j < b.len() && b[j].is_ascii_whitespace() {
        if b[j] == b'\n' {
            last_nl = Some(j);
        }
        j += 1;
    }
    last_nl.map(|nl| (width, nl + 1))
}

fn fences(raw: &str) -> Vec<Fence> {
    let b = raw.as_bytes();
    let mut out = Vec::new();
    let mut pos = 0;
    'search: while pos < b.len() {
        let mut i = pos;
        while i < b.len() {
            if b[i] == b'`'
                && let Some((width, body_start)) = open_at(b, i)
            {
                match find_close(raw, body_start, width) {
                    Some((body_end, end)) => {
                        out.push(Fence {
                            start: i,
                            end,
                            body_start,
                            body_end,
                        });
                        pos = end;
                    }
                    None => pos = body_start,
                }
                continue 'search;
            }
            i += 1;
        }
        break;
    }
    out
}

fn find_close(raw: &str, start: usize, width: usize) -> Option<(usize, usize)> {
    let b = raw.as_bytes();
    let mut ls = start;
    while ls <= b.len() {
        let mut i = ls;
        while i < b.len() && (b[i] == b' ' || b[i] == b'\t') && i - ls < 4 {
            i += 1;
        }
        let mut j = i;
        while j < b.len() && b[j] == b'`' {
            j += 1;
        }
        if j - i >= width {
            let mut k = j;
            while k < b.len() && (b[k] == b' ' || b[k] == b'\t') {
                k += 1;
            }
            if k >= b.len() || b[k] == b'\r' || b[k] == b'\n' {
                return Some((body_end(b, start, ls), j));
            }
        }
        match raw[ls..].find('\n') {
            Some(nl) => ls = ls + nl + 1,
            None => break,
        }
    }
    // No closing line: accept a final backtick run that ends the text on the payload's line.
    let tail = raw.trim_end().as_bytes();
    let mut k = tail.len();
    while k > start && tail[k - 1] == b'`' {
        k -= 1;
    }
    if tail.len() - k >= width && k > start {
        return Some((k, tail.len()));
    }
    None
}

fn body_end(b: &[u8], start: usize, line_start: usize) -> usize {
    let mut e = line_start;
    if e > start && b[e - 1] == b'\n' {
        e -= 1;
    }
    if e > start && b[e - 1] == b'\r' {
        e -= 1;
    }
    e
}

/// Strip the first code fence, splicing its body back in place; otherwise trim.
#[must_use]
pub fn strip(raw: Option<&str>) -> String {
    let Some(raw) = raw else {
        return String::new();
    };
    match fences(raw).first() {
        Some(f) => format!(
            "{}{}{}",
            &raw[..f.start],
            &raw[f.body_start..f.body_end],
            &raw[f.end..]
        )
        .trim()
        .to_string(),
        None => raw.trim().to_string(),
    }
}

/// The body of every fenced block, in order.
#[must_use]
pub fn fenced_bodies(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    fences(raw)
        .iter()
        .map(|f| raw[f.body_start..f.body_end].to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_a_fence() {
        assert_eq!(
            strip(Some("hi\n```json\n{\"a\":1}\n```\nbye")),
            "hi\n{\"a\":1}\nbye"
        );
        assert_eq!(fenced_bodies(Some("```\nx\n```")), vec!["x".to_string()]);
        assert_eq!(strip(Some("  plain  ")), "plain");
    }
}
