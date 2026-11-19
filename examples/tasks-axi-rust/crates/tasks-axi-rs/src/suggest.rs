//! Next-step suggestions: the model's hint templates, filtered and suffixed the way the Node tool
//! does it (a hint that cannot carry the active filters is dropped, never mis-stated).

use tasks_axi_gen::cli::{Globals, Hint, HintWhen};

/// What a command knows when it asks for hints.
pub struct HintContext<'a> {
    pub active: &'a [HintWhen],
    pub id: Option<&'a str>,
    /// The filter flags the invocation carried, in the order the Node tool lists them.
    pub filters: &'a [(&'static str, &'a str)],
    pub globals: Option<&'a Globals>,
}

/// `shellQuoteOneLine`: a value safe to paste after `--flag=`, or None when it cannot be quoted.
fn shell_quote(value: &str) -> Option<String> {
    if value.chars().any(|c| matches!(c, '\0' | '\r' | '\n' | '`')) {
        return None;
    }
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c));
    if plain {
        Some(value.to_string())
    } else {
        Some(format!("'{}'", value.replace('\'', "'\\''")))
    }
}

/// Insert `suffix` just before the closing backtick of the line's `tasks-axi` command.
fn append_suffix(line: &str, suffix: &str) -> Option<String> {
    let first = line.find('`')?;
    let second = first + 1 + line[first + 1..].find('`')?;
    let command = &line[first + 1..second];
    if command != "tasks-axi" && !command.starts_with("tasks-axi ") {
        return None;
    }
    Some(format!("{}{}{}", &line[..second], suffix, &line[second..]))
}

fn filter_suffix(filters: &[(&'static str, &str)], supported: &[&str]) -> Option<String> {
    if filters.iter().any(|(flag, _)| !supported.contains(flag)) {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for flag in supported {
        if let Some((_, value)) = filters.iter().find(|(f, _)| f == flag) {
            parts.push(format!("--{flag}={}", shell_quote(value)?));
        }
    }
    Some(if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    })
}

fn global_suffix(globals: Option<&Globals>) -> Option<String> {
    let Some(g) = globals else {
        return Some(String::new());
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(b) = &g.backend {
        parts.push(format!("--backend={}", shell_quote(b)?));
    }
    if let Some(f) = &g.file {
        parts.push(format!("--file={}", shell_quote(f)?));
    }
    Some(if parts.is_empty() {
        String::new()
    } else {
        format!(" {}", parts.join(" "))
    })
}

/// `withSuggestionGlobals`: carry `--backend` / `--file` into every suggested command.
pub fn with_globals(lines: Vec<String>, globals: Option<&Globals>) -> Vec<String> {
    match global_suffix(globals) {
        None => Vec::new(),
        Some(s) if s.is_empty() => lines,
        Some(s) => lines.iter().filter_map(|l| append_suffix(l, &s)).collect(),
    }
}

/// The suggestion lines for a command's hints.
pub fn suggestions(hints: &[Hint], ctx: &HintContext) -> Vec<String> {
    let lines: Vec<String> = hints
        .iter()
        .filter(|h| ctx.active.contains(&h.when))
        .filter_map(|h| {
            let mut line = h.line.to_string();
            if let Some(id) = ctx.id {
                line = line.replace("{id}", id);
            }
            if h.filters.is_empty() {
                return Some(line);
            }
            match filter_suffix(ctx.filters, h.filters)? {
                s if s.is_empty() => Some(line),
                s => append_suffix(&line, &s),
            }
        })
        .collect();
    with_globals(lines, ctx.globals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_matches_the_node_tool() {
        assert_eq!(shell_quote("plain-1.2/x").as_deref(), Some("plain-1.2/x"));
        assert_eq!(shell_quote("a b").as_deref(), Some("'a b'"));
        assert_eq!(shell_quote("it's").as_deref(), Some("'it'\\''s'"));
        assert_eq!(shell_quote("a`b"), None);
    }

    #[test]
    fn suffix_goes_inside_the_backticks() {
        assert_eq!(
            append_suffix("Run `tasks-axi ready` now", " --repo=x").as_deref(),
            Some("Run `tasks-axi ready --repo=x` now")
        );
        assert_eq!(append_suffix("Run `other` now", " --repo=x"), None);
    }
}
