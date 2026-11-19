//! Backend and path resolution: `--file` / `--backend`, the environment, `.tasks.toml` in the
//! working directory and `~/.tasks-axi/config.toml`, in the Node tool's precedence order.

use crate::jsutil::js_trim;
use jsre::Regex;
use std::io::ErrorKind;
use std::path::Path;
use tasks_axi_gen::cli::Globals;
use tasks_axi_gen::errors::{AxiError, ErrorCode};

const DEFAULT_KEEP: f64 = 10.0;
const PATH_CANDIDATES: [&str; 2] = ["backlog.md", "data/backlog.md"];

/// What the process environment contributes.
pub struct Env {
    pub cwd: String,
    pub home: Option<String>,
    pub file: Option<String>,
    pub backend: Option<String>,
}

impl Env {
    pub fn from_process() -> Env {
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "/".to_string());
        Env {
            cwd,
            home: std::env::var_os("HOME").map(|h| h.to_string_lossy().into_owned()),
            file: std::env::var_os("TASKS_AXI_FILE").map(|v| v.to_string_lossy().into_owned()),
            backend: std::env::var_os("TASKS_AXI_BACKEND")
                .map(|v| v.to_string_lossy().into_owned()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub backend: String,
    pub path: String,
    pub archive_path: Option<String>,
}

#[derive(Default)]
struct Toml {
    backend: Option<String>,
    path: Option<String>,
    archive: Option<String>,
    done_keep: Option<f64>,
}

fn validation(message: &str, suggestions: &[&str]) -> AxiError {
    AxiError::validation(message, suggestions.iter().map(|s| s.to_string()).collect())
}

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

fn strip_toml_comment(raw: &str) -> &str {
    let mut quote: Option<char> = None;
    for (i, ch) in raw.char_indices() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch == '#' {
            return &raw[..i];
        }
    }
    raw
}

#[derive(Clone, Copy, PartialEq)]
enum Table {
    Root,
    Markdown,
    Unsupported,
}

enum Value {
    Text(String),
    Number(f64),
}

fn parse_value(raw: &str, source: &str, int_re: &Regex) -> Result<Value, AxiError> {
    let trimmed = js_trim(raw);
    if trimmed.starts_with('"') || trimmed.starts_with('\'') {
        let quote = trimmed.chars().next().unwrap_or('"');
        // `trimmed.length === 1` counts UTF-16 units; a lone quote is one.
        if !trimmed.ends_with(quote) || trimmed.chars().count() == 1 {
            return Err(AxiError::validation(
                format!("{source} has an unterminated quoted value"),
                vec![],
            ));
        }
        let inner = &trimmed[quote.len_utf8()..trimmed.len() - quote.len_utf8()];
        return Ok(Value::Text(inner.to_string()));
    }
    if int_re.find_at(&chars(trimmed), 0).is_some() {
        return Ok(Value::Number(
            trimmed.parse::<f64>().unwrap_or(f64::INFINITY),
        ));
    }
    Err(AxiError::validation(
        format!("{source} has an invalid value"),
        vec![],
    ))
}

fn require_string(value: Value, source: &str) -> Result<String, AxiError> {
    match value {
        Value::Text(s) => Ok(s),
        Value::Number(_) => Err(AxiError::validation(
            format!("{source} must be a quoted string"),
            vec![],
        )),
    }
}

/// The tiny TOML subset the config needs: a root `backend` and a `[markdown]` table.
fn parse_config_toml(src: &str) -> Result<Toml, AxiError> {
    let section_re = Regex::new(r"^\[([^\]]+)\]$").map_err(internal)?;
    let kv_re = Regex::new(r"^([A-Za-z0-9_]+)\s*=\s*(.*)$").map_err(internal)?;
    let int_re = Regex::new(r"^-?\d+$").map_err(internal)?;
    let mut config = Toml::default();
    let mut table = Table::Root;
    for raw_line in src.split('\n') {
        let line = js_trim(strip_toml_comment(raw_line));
        if line.is_empty() {
            continue;
        }
        let line_chars = chars(line);
        if let Some(g) = section_re.captures_str(&line_chars, 0) {
            let name = g[1].as_deref().unwrap_or("");
            table = if js_trim(name) == "markdown" {
                Table::Markdown
            } else {
                Table::Unsupported
            };
            continue;
        }
        if table == Table::Unsupported {
            continue;
        }
        let Some(kv) = kv_re.captures_str(&line_chars, 0) else {
            return Err(validation(
                "Invalid config line: expected `key = value`",
                &["Use `key = value` assignments in .tasks.toml"],
            ));
        };
        let key = kv[1].as_deref().unwrap_or("");
        let value_raw = kv[2].as_deref().unwrap_or("");
        let source = match (table, key) {
            (Table::Root, "backend") => "backend".to_string(),
            (Table::Markdown, "path" | "archive" | "done_keep") => format!("markdown.{key}"),
            _ => continue,
        };
        let value = parse_value(value_raw, &source, &int_re)?;
        if table == Table::Root {
            config.backend = Some(require_string(value, &source)?);
            continue;
        }
        match key {
            "path" => config.path = Some(require_string(value, &source)?),
            "archive" => config.archive = Some(require_string(value, &source)?),
            _ => match value {
                Value::Number(n) => config.done_keep = Some(n),
                Value::Text(_) => {
                    return Err(validation(
                        "markdown.done_keep must be an integer",
                        &["Set `[markdown] done_keep = 10` in .tasks.toml"],
                    ))
                }
            },
        }
    }
    Ok(config)
}

fn internal(e: String) -> AxiError {
    AxiError::new(e, ErrorCode::Unknown, vec![])
}

/// A file's text, `None` when it does not exist; other failures surface as `UNKNOWN`, the way an
/// unhandled Node error would.
pub fn read_file_safe(path: &str) -> Result<Option<String>, AxiError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AxiError::new(
            io_message(&e, path),
            ErrorCode::Unknown,
            vec![],
        )),
    }
}

/// Node's `errno` message shapes for the failures a backlog read can hit.
fn io_message(e: &std::io::Error, path: &str) -> String {
    match e.raw_os_error() {
        Some(21) => "EISDIR: illegal operation on a directory, read".to_string(),
        Some(13) => format!("EACCES: permission denied, open '{path}'"),
        _ => e.to_string(),
    }
}

fn load_toml(path: &str) -> Result<Toml, AxiError> {
    match read_file_safe(path)? {
        Some(src) if !src.is_empty() => parse_config_toml(&src),
        _ => Ok(Toml::default()),
    }
}

/// `path.resolve(cwd, p)` for a POSIX path.
pub fn resolve(cwd: &str, p: &str) -> String {
    let joined = if p.starts_with('/') {
        p.to_string()
    } else {
        format!("{cwd}/{p}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

fn dirname(abs: &str) -> &str {
    match abs.rfind('/') {
        Some(0) | None => "/",
        Some(i) => &abs[..i],
    }
}

fn validate_path_value(value: Option<String>, source: &str) -> Result<Option<String>, AxiError> {
    match value {
        Some(v) if js_trim(&v).is_empty() => Err(validation(
            &format!("{source} must not be empty"),
            &["Set it to a backlog path or remove the empty override"],
        )),
        other => Ok(other),
    }
}

fn is_safe_non_negative(n: f64) -> bool {
    (0.0..=9_007_199_254_740_991.0).contains(&n)
}

/// Resolve the backlog context. `globals` are the `--backend` / `--file` flags.
pub fn resolve_config(globals: &Globals, env: &Env) -> Result<Config, AxiError> {
    let home_toml = match &env.home {
        Some(home) => {
            let p = if home.is_empty() {
                ".tasks-axi/config.toml".to_string()
            } else {
                format!("{home}/.tasks-axi/config.toml")
            };
            load_toml(&p)?
        }
        None => Toml::default(),
    };
    let project_toml = load_toml(&resolve(&env.cwd, ".tasks.toml"))?;

    let explicit_path = match (&globals.file, &env.file) {
        (Some(f), _) => validate_path_value(Some(f.clone()), "--file")?,
        (None, Some(f)) => validate_path_value(Some(f.clone()), "TASKS_AXI_FILE")?,
        (None, None) => None,
    };
    let toml_path = if explicit_path.is_some() {
        None
    } else if project_toml.path.is_some() {
        validate_path_value(project_toml.path.clone(), "markdown.path")?
    } else {
        validate_path_value(home_toml.path.clone(), "markdown.path")?
    };

    let backend = globals
        .backend
        .clone()
        .or_else(|| env.backend.clone())
        .or_else(|| project_toml.backend.clone())
        .or_else(|| home_toml.backend.clone())
        .unwrap_or_else(|| "markdown".to_string());

    let chosen = explicit_path.or(toml_path);
    let path = match chosen {
        Some(c) => resolve(&env.cwd, &c),
        None => PATH_CANDIDATES
            .iter()
            .map(|c| resolve(&env.cwd, c))
            .find(|full| Path::new(full).exists())
            .unwrap_or_else(|| resolve(&env.cwd, PATH_CANDIDATES[0])),
    };

    let archive = if project_toml.archive.is_some() {
        validate_path_value(project_toml.archive.clone(), "markdown.archive")?
    } else {
        validate_path_value(home_toml.archive.clone(), "markdown.archive")?
    };

    let keep = project_toml
        .done_keep
        .or(home_toml.done_keep)
        .unwrap_or(DEFAULT_KEEP);
    if !is_safe_non_negative(keep) {
        return Err(validation(
            "markdown.done_keep must be a non-negative integer",
            &["Set `[markdown] done_keep = 10` in .tasks.toml"],
        ));
    }

    Ok(Config {
        backend,
        path,
        archive_path: archive
            .filter(|a| !a.is_empty())
            .map(|a| resolve(&env.cwd, &a)),
    })
}

/// The store's constructor checks: neither archive may be the active backlog.
pub fn check_archives(config: &Config) -> Result<(), AxiError> {
    let dir = dirname(&config.path);
    let archive = config
        .archive_path
        .clone()
        .unwrap_or_else(|| format!("{dir}/done-archive.md"));
    if resolve("/", &archive) == resolve("/", &config.path) {
        return Err(AxiError::validation(
            "Archive path must not be the active backlog path",
            vec![],
        ));
    }
    if resolve("/", &format!("{dir}/note-archive.md")) == resolve("/", &config.path) {
        return Err(AxiError::validation(
            "Note archive path must not be the active backlog path",
            vec![],
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_normalises_like_posix_path_resolve() {
        assert_eq!(resolve("/a/b", "c"), "/a/b/c");
        assert_eq!(resolve("/a/b", "../c/./d/"), "/a/c/d");
        assert_eq!(resolve("/a/b", "/x//y"), "/x/y");
        assert_eq!(resolve("/a", "../../.."), "/");
    }

    #[test]
    fn toml_reads_root_and_markdown_tables() {
        let t = parse_config_toml("backend = \"markdown\" # c\n[markdown]\npath = 'x.md'\ndone_keep = 3\n[other]\nz = 1\n").unwrap();
        assert_eq!(t.backend.as_deref(), Some("markdown"));
        assert_eq!(t.path.as_deref(), Some("x.md"));
        assert_eq!(t.done_keep, Some(3.0));
    }

    #[test]
    fn toml_rejects_a_line_that_is_not_an_assignment() {
        assert!(parse_config_toml("nonsense").is_err());
    }
}
