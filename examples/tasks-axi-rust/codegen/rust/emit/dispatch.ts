import type { Ir } from "../ir.js";
import { GENERATED_BANNER, pascal, snake } from "../names.js";

export function emitDispatch(ir: Ir): string {
  const cmds = ir.cli.commands;
  const argTypes = cmds.map((c) => `${pascal(c.name)}Args`);
  return `${GENERATED_BANNER}
//! The handlers trait the hand-written side implements, and the dispatcher that drives it.

use crate::cli::{
    self, parse_globals, CommandName, Globals, ${argTypes.join(", ")}, BIN, NOUN, REFUSAL_HOME, REFUSAL_MESSAGE,
    REFUSAL_SUGGESTION, REFUSED, TOP_HELP, VERSION,
};
use crate::errors::{AxiError, ErrorCode};

/// What a run produced. \`Output\` and \`Failure\` are rendered by the caller (an output gets a
/// trailing newline); \`Verbatim\` is printed exactly as given.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Output(String),
    Verbatim(String),
    Failure(AxiError),
}

/// One method per implemented command. The dispatcher cannot call a command this trait lacks,
/// and the hand-written side cannot lose one without failing to compile.
pub trait Handlers {
    /// Resolve the backlog context (config, backend, file) once the global flags are read.
    fn resolve_context(&mut self, globals: &Globals) -> Result<(), AxiError>;
${cmds.map((c) => `    fn ${snake(c.name)}(&mut self, args: ${pascal(c.name)}Args) -> Result<String, AxiError>;`).join("\n")}
}

fn refusal(command: &str) -> AxiError {
    AxiError::new(
        REFUSAL_MESSAGE.replace("{command}", command),
        ErrorCode::Unsupported,
        vec![REFUSAL_SUGGESTION.to_string()],
    )
}

/// Run one invocation: \`argv\` excludes the program name.
pub fn run<H: Handlers>(argv: &[String], handlers: &mut H) -> Outcome {
    match run_inner(argv, handlers) {
        Ok(outcome) => outcome,
        Err(e) => Outcome::Failure(e),
    }
}

fn run_inner<H: Handlers>(argv: &[String], handlers: &mut H) -> Result<Outcome, AxiError> {
    // The noun is optional: \`tasks-axi task show x\` is \`tasks-axi show x\`.
    let argv: &[String] = if argv.first().map(String::as_str) == Some(NOUN) { &argv[1..] } else { argv };

    if argv.len() == 1 && argv[0] == "--help" {
        return Ok(Outcome::Verbatim(format!("{TOP_HELP}\\n")));
    }
    if argv.len() == 1 && matches!(argv[0].as_str(), "-v" | "-V" | "--version") {
        return Ok(Outcome::Verbatim(format!("{VERSION}\\n")));
    }
    let Some(command) = argv.first() else {
        return Err(refusal(REFUSAL_HOME));
    };
    if command.starts_with('-') {
        return Err(AxiError::validation(
            "Flags must come after the command",
            vec![
                format!("Run \`{BIN} <command> [args] [flags]\`"),
                format!("Move \`{command}\` after the command instead of before it"),
            ],
        ));
    }
    let args = &argv[1..];
    let implemented = CommandName::from_word(command);
    let refused = REFUSED.contains(&command.as_str());
    if args.iter().any(|a| a == "--help") {
        if let Some(name) = implemented {
            return Ok(Outcome::Verbatim(name.help().to_string()));
        }
    }
    if refused {
        return Err(refusal(command));
    }
    let Some(name) = implemented else {
        return Err(AxiError::validation(
            format!("Unknown command: {command}"),
            vec!["Run \`--help\` to see available commands".to_string()],
        ));
    };

    let (globals, rest) = parse_globals(args)?;
    handlers.resolve_context(&globals)?;
    let output = match name {
${cmds
  .map(
    (c) =>
      `        CommandName::${pascal(c.name)} => handlers.${snake(c.name)}(cli::parse_${snake(c.name)}(&rest)?)?,`,
  )
  .join("\n")}
    };
    Ok(Outcome::Output(output))
}
`;
}
