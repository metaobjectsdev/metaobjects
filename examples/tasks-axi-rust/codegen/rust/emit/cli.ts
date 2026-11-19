import type { CommandIr, FlagIr, Ir } from "../ir.js";
import { extraConstName } from "./rows.js";
import { GENERATED_BANNER, ident, lit, pascal, snake } from "../names.js";

const upper = (s: string): string => snake(s).toUpperCase();

/** The flag-reading runtime. Model-independent, so it is emitted verbatim: the generated crate
 *  carries it, the drift gate covers it, and a native generator copies it as a unit. */
const RUNTIME = `
/// JavaScript's \`\\s\` set, which \`String.prototype.trim\` also uses.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\\t' | '\\n'
            | '\\u{b}'
            | '\\u{c}'
            | '\\r'
            | ' '
            | '\\u{a0}'
            | '\\u{1680}'
            | '\\u{2000}'..='\\u{200a}'
            | '\\u{2028}'
            | '\\u{2029}'
            | '\\u{202f}'
            | '\\u{205f}'
            | '\\u{3000}'
            | '\\u{feff}'
    )
}

/// \`String.prototype.trim\`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn require_flag_value(args: &[String], index: usize, flag: &str) -> Result<String, AxiError> {
    match args.get(index + 1) {
        Some(v) if !v.starts_with("--") => Ok(v.clone()),
        _ => Err(AxiError::validation(
            format!("{flag} requires a value"),
            vec![format!("Pass {flag}=... if the value begins with --")],
        )),
    }
}

/// \`--flag value\` or \`--flag=value\`: the first occurrence, removed from \`args\`.
fn take_flag(args: &mut Vec<String>, flag: &str) -> Result<Option<String>, AxiError> {
    let equals = format!("{flag}=");
    for i in 0..args.len() {
        if args[i] == flag {
            let value = require_flag_value(args, i, flag)?;
            args.drain(i..i + 2);
            return Ok(Some(value));
        }
        if let Some(value) = args[i].strip_prefix(equals.as_str()) {
            let value = value.to_string();
            args.remove(i);
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn take_bool_flag(args: &mut Vec<String>, flag: &str) -> bool {
    match args.iter().position(|a| a == flag) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

fn require_non_empty_flag_value(flag: &str, value: Option<String>) -> Result<Option<String>, AxiError> {
    match value {
        Some(v) if js_trim(&v).is_empty() => Err(AxiError::validation(
            format!("{flag} requires a value"),
            vec![format!("Pass {flag}=... with a non-empty value")],
        )),
        other => Ok(other),
    }
}

fn require_non_empty_single_line(flag: &str, value: Option<String>) -> Result<Option<String>, AxiError> {
    match require_non_empty_flag_value(flag, value)? {
        Some(v) if v.contains(['\\r', '\\n']) => Err(AxiError::validation(
            format!("{flag} must be a single line"),
            vec![format!("Pass {flag}=... without line breaks")],
        )),
        other => Ok(other),
    }
}

fn parse_optional_uint(flag: &str, raw: Option<String>) -> Result<Option<u64>, AxiError> {
    let Some(raw) = raw else { return Ok(None) };
    let bad = || AxiError::validation(format!("{flag} must be a non-negative integer"), vec![]);
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad());
    }
    match raw.parse::<u64>() {
        Ok(n) if n <= MAX_SAFE_INTEGER => Ok(Some(n)),
        _ => Err(bad()),
    }
}

fn parse_columns(flag: &str, raw: Option<String>, available: &[Column]) -> Result<Vec<Column>, AxiError> {
    let Some(raw) = raw else { return Ok(Vec::new()) };
    let mut requested: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let name = js_trim(part);
        if !name.is_empty() && !requested.iter().any(|r| r == name) {
            requested.push(name.to_string());
        }
    }
    let unknown: Vec<&str> = requested
        .iter()
        .map(String::as_str)
        .filter(|n| !available.iter().any(|c| c.name() == *n))
        .collect();
    if !unknown.is_empty() {
        let mut names: Vec<&str> = available.iter().map(|c| c.name()).collect();
        names.sort_unstable();
        let _ = flag;
        return Err(AxiError::validation(
            format!("Unknown field(s): {}. Available: {}", unknown.join(", "), names.join(", ")),
            vec![],
        ));
    }
    Ok(requested.iter().filter_map(|n| Column::parse(n)).collect())
}

fn require_no_unknown_flags(args: &[String]) -> Result<(), AxiError> {
    match args.iter().find(|a| a.starts_with('-')) {
        Some(unknown) => Err(AxiError::validation(
            format!("Unknown flag: {unknown}"),
            vec!["Run the command with --help to see supported flags".to_string()],
        )),
        None => Ok(()),
    }
}

fn require_positionals(args: &[String], min: usize, max: usize, usage: &str) -> Result<Vec<String>, AxiError> {
    require_no_unknown_flags(args)?;
    let positionals: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if positionals.len() >= min && positionals.len() <= max {
        return Ok(positionals);
    }
    let expected = if min == max {
        if min == 0 {
            "no positional arguments".to_string()
        } else {
            format!("{min} positional argument{}", if min == 1 { "" } else { "s" })
        }
    } else {
        format!("{min}-{max} positional arguments")
    };
    Err(AxiError::validation(
        format!("Expected {expected}, got {}", positionals.len()),
        vec![usage.to_string()],
    ))
}

/// A task id: slug-shaped, \`^[A-Za-z0-9][A-Za-z0-9._-]*$\`.
pub fn is_task_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn require_id(raw: &str, label: &str) -> Result<String, AxiError> {
    if js_trim(raw).is_empty() {
        return Err(AxiError::validation(
            format!("Missing {label}"),
            vec![format!("Pass the task {label}, e.g. \`{BIN} show <id>\`")],
        ));
    }
    if !is_task_id(raw) {
        return Err(AxiError::validation(
            format!("Invalid id \\"{raw}\\" - ids must be slug-shaped (letters, digits, \\"._-\\") with no spaces"),
            vec!["Use a slug like \`homemux-h7\`, or pass --mint to generate one".to_string()],
        ));
    }
    Ok(raw.to_string())
}
`;

function argType(f: FlagIr): string {
  switch (f.flag.kind) {
    case "bool":
      return "bool";
    case "line":
      return "Option<String>";
    case "uint":
      return "Option<u64>";
    case "enum":
      return `Option<${f.flag.enum}>`;
    case "columns":
      return "Vec<Column>";
  }
}

function takeExpr(ir: Ir, f: FlagIr): string {
  const flag = lit(`--${f.name}`);
  switch (f.flag.kind) {
    case "bool":
      return `take_bool_flag(&mut args, ${flag})`;
    case "line":
      return `require_non_empty_single_line(${flag}, take_flag(&mut args, ${flag})?)?`;
    case "uint":
      return `parse_optional_uint(${flag}, take_flag(&mut args, ${flag})?)?`;
    case "enum": {
      const e = ir.enums.find((x) => x.name === (f.flag as { enum: string }).enum)!;
      const msg = `--${f.name} must be one of ${e.members.map((m) => m.wire).join(", ")}`;
      return `match take_flag(&mut args, ${flag})? {
            None => None,
            Some(raw) => Some(${e.name}::parse(&raw).ok_or_else(|| AxiError::validation(${lit(msg)}, Vec::new()))?),
        }`;
    }
    case "columns":
      return `parse_columns(${flag}, take_flag(&mut args, ${flag})?, &${extraConstName(f.flag.base)})?`;
  }
}

function commandBlock(ir: Ir, c: CommandIr): string {
  const N = upper(c.name);
  const P = pascal(c.name);
  const idField = c.positionals.idType ? [`pub ${ident(c.positionals.names[0] as string)}: String,`] : [];
  const fields = [...idField, ...c.flags.map((f) => `pub ${ident(f.name)}: ${argType(f)},`)];
  const idInit = c.positionals.idType
    ? `\n    let ${ident(c.positionals.names[0] as string)} = require_id(&positionals[0], ${lit(c.positionals.names[0] as string)})?;`
    : "";
  const inits = [...(c.positionals.idType ? [ident(c.positionals.names[0] as string)] : []), ...c.flags.map((f) => ident(f.name))].join(", ");
  const whenName = { always: "Always", empty: "Empty", nonEmpty: "NonEmpty", blocked: "Blocked" } as const;
  return `
pub const ${N}_HELP: &str = ${lit(c.help)};
pub const ${N}_USAGE: &str = ${lit(c.usage)};

pub const ${N}_HINTS: &[Hint] = &[
${c.hints
  .map(
    (h) =>
      `Hint { when: HintWhen::${whenName[h.when]}, line: ${lit(h.line)}, filters: &[${h.filters.map(lit).join(", ")}] },`,
  )
  .join("\n")}
];

pub const ${N}_OUTPUTS: &[OutputSpec] = &[
${c.outputs
  .map(
    (o) =>
      `OutputSpec { label: ${lit(o.label)}, columns: &[${o.columns.map((n) => `Column::${pascal(n)}`).join(", ")}] },`,
  )
  .join("\n")}
];

#[derive(Debug, Clone, PartialEq)]
pub struct ${P}Args {
${fields.join("\n")}
}

/// Read \`${c.name}\`'s arguments (global flags already removed), flag by flag in the order the
/// model lists them, then the positionals.
pub fn parse_${snake(c.name)}(raw: &[String]) -> Result<${P}Args, AxiError> {
    let mut args: Vec<String> = raw.to_vec();
${c.flags.map((f) => `    let ${ident(f.name)} = ${takeExpr(ir, f)};`).join("\n")}
    let positionals = require_positionals(&args, ${c.positionals.min}, ${c.positionals.max}, ${N}_USAGE)?;${idInit}
    let _ = &positionals;
    Ok(${P}Args { ${inits} })
}
`;
}

export function emitCli(ir: Ir): string {
  const cli = ir.cli;
  const enumsUsed = [...new Set(cli.commands.flatMap((c) => c.flags.flatMap((f) => (f.flag.kind === "enum" ? [f.flag.enum] : []))))];
  const extraConsts = [
    ...new Set(cli.commands.flatMap((c) => c.flags.flatMap((f) => (f.flag.kind === "columns" ? [extraConstName(f.flag.base)] : [])))),
  ];
  const names = cli.commands.map((c) => pascal(c.name));
  const words = cli.commands.flatMap((c) => [c.name, ...c.aliases].map((w) => [w, pascal(c.name)] as const));

  return `${GENERATED_BANNER}
//! The command surface: help text, argument parsing, hints and output column lists.

use crate::enums::{${enumsUsed.join(", ")}};
use crate::errors::AxiError;
use crate::rows::{${["Column", ...extraConsts].join(", ")}};

pub const BIN: &str = ${lit(cli.bin)};
pub const VERSION: &str = ${lit(cli.version)};
pub const NOUN: &str = ${lit(cli.noun)};
pub const TOP_HELP: &str = ${lit(cli.topHelp)};

/// Commands the real tool has and this one refuses.
pub const REFUSED: [&str; ${cli.refused.length}] = [${cli.refused.map(lit).join(", ")}];
pub const REFUSAL_MESSAGE: &str = ${lit(cli.refusal.message)};
pub const REFUSAL_SUGGESTION: &str = ${lit(cli.refusal.suggestion)};
pub const REFUSAL_HOME: &str = ${lit(cli.refusal.home)};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HintWhen {
    Always,
    Empty,
    NonEmpty,
    Blocked,
}

/// A next-step suggestion: a template with \`{id}\` and a list of filter flags it may carry.
#[derive(Debug, Clone, Copy)]
pub struct Hint {
    pub when: HintWhen,
    pub line: &'static str,
    pub filters: &'static [&'static str],
}

/// One printed group: its label and the columns it prints.
#[derive(Debug, Clone, Copy)]
pub struct OutputSpec {
    pub label: &'static str,
    pub columns: &'static [Column],
}

/// Flags every implemented command accepts, read before the command's own.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Globals {
${cli.globalFlags.map((f) => `pub ${ident(f.name)}: Option<String>,`).join("\n")}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandName {
${names.map((n) => `${n},`).join("\n")}
}

impl CommandName {
    /// The implemented command a word names (its name or an alias).
    pub fn from_word(word: &str) -> Option<CommandName> {
        match word {
${words.map(([w, v]) => `${lit(w)} => Some(CommandName::${v}),`).join("\n")}
            _ => None,
        }
    }

    pub const fn help(self) -> &'static str {
        match self {
${cli.commands.map((c) => `CommandName::${pascal(c.name)} => ${upper(c.name)}_HELP,`).join("\n")}
        }
    }
}

/// Remove the global flags from \`args\`; the rest is the command's own.
pub fn parse_globals(args: &[String]) -> Result<(Globals, Vec<String>), AxiError> {
    let mut globals = Globals::default();
    let mut stripped: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
${cli.globalFlags
  .map((f) => {
    const flag = lit(`--${f.name}`);
    return `        if arg == ${flag} {
            let value = require_flag_value(args, i, ${flag})?;
            globals.${ident(f.name)} = require_non_empty_single_line(${flag}, Some(value))?;
            i += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix(${lit(`--${f.name}=`)}) {
            globals.${ident(f.name)} = require_non_empty_single_line(${flag}, Some(value.to_string()))?;
            i += 1;
            continue;
        }`;
  })
  .join("\n")}
        stripped.push(args[i].clone());
        i += 1;
    }
    Ok((globals, stripped))
}
${cli.commands.map((c) => commandBlock(ir, c)).join("")}${RUNTIME}`;
}
