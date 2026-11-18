import type { Ir } from "../ir.js";
import { GENERATED_BANNER, lit } from "../names.js";

export function emitErrors(ir: Ir): string {
  const e = ir.errors;
  return `${GENERATED_BANNER}
//! Error codes with their exit codes, and the structured error every command fails with.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
${e.map((c) => `${c.variant},`).join("\n")}
}

impl ErrorCode {
    pub const ALL: [ErrorCode; ${e.length}] = [${e.map((c) => `ErrorCode::${c.variant}`).join(", ")}];

    /// The code as printed after \`code:\`.
    pub const fn as_str(self) -> &'static str {
        match self {
${e.map((c) => `ErrorCode::${c.variant} => ${lit(c.name)},`).join("\n")}
        }
    }

    /// The process exit status the code maps to.
    pub const fn exit_code(self) -> i32 {
        match self {
${e.map((c) => `ErrorCode::${c.variant} => ${c.exit},`).join("\n")}
        }
    }
}

/// A command failure: a message, a code, and next-step suggestions.
#[derive(Debug, Clone, PartialEq)]
pub struct AxiError {
    pub message: String,
    pub code: ErrorCode,
    pub suggestions: Vec<String>,
}

impl AxiError {
    pub fn new(message: impl Into<String>, code: ErrorCode, suggestions: Vec<String>) -> AxiError {
        AxiError {
            message: message.into(),
            code,
            suggestions,
        }
    }

    pub fn validation(message: impl Into<String>, suggestions: Vec<String>) -> AxiError {
        AxiError::new(message, ErrorCode::ValidationError, suggestions)
    }

    pub fn exit_code(&self) -> i32 {
        self.code.exit_code()
    }
}
`;
}
