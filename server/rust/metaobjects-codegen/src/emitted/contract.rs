//! The wire error contract every generated route and the enforcing shell answer with
//! (docs/features/api-contract.md, ADR-0066 §6): the fixed codes, their HTTP statuses and the
//! error bodies. The `contract-types` generator's crates name an operation's errors through it.

use serde::{Deserialize, Serialize};

/// A fixed wire error code: the five the enforcing shell answers with on its own, then the
/// six the REST contract's transport does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    Forbidden,
    InvalidTransition,
    TransitionConditionFailed,
    StateManaged,
    Validation,
    InvalidJson,
    InvalidId,
    MethodNotAllowed,
    ConstraintViolation,
    Internal,
}

impl ErrorCode {
    /// The codes the enforcing shell answers with on its own (ADR-0066 §6).
    pub const SHELL: &[ErrorCode] = &[
        ErrorCode::NotFound,
        ErrorCode::Forbidden,
        ErrorCode::InvalidTransition,
        ErrorCode::TransitionConditionFailed,
        ErrorCode::StateManaged,
    ];

    /// The codes the REST contract's transport answers with.
    pub const CONTRACT: &[ErrorCode] = &[
        ErrorCode::Validation,
        ErrorCode::InvalidJson,
        ErrorCode::InvalidId,
        ErrorCode::MethodNotAllowed,
        ErrorCode::ConstraintViolation,
        ErrorCode::Internal,
    ];

    /// Its wire code.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            ErrorCode::NotFound => "not_found",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::InvalidTransition => "invalid_transition",
            ErrorCode::TransitionConditionFailed => "transition_condition_failed",
            ErrorCode::StateManaged => "state_managed",
            ErrorCode::Validation => "validation",
            ErrorCode::InvalidJson => "invalid_json",
            ErrorCode::InvalidId => "invalid_id",
            ErrorCode::MethodNotAllowed => "method_not_allowed",
            ErrorCode::ConstraintViolation => "constraint_violation",
            ErrorCode::Internal => "internal",
        }
    }

    /// Its HTTP status. `None` for `constraint_violation`, which has none of its own: it is
    /// [`ConstraintKind::status`] of the constraint the database refused.
    #[must_use]
    pub const fn status(self) -> Option<u16> {
        match self {
            ErrorCode::NotFound => Some(404),
            ErrorCode::Forbidden => Some(403),
            ErrorCode::InvalidTransition
            | ErrorCode::TransitionConditionFailed
            | ErrorCode::StateManaged => Some(409),
            ErrorCode::Validation | ErrorCode::InvalidJson | ErrorCode::InvalidId => Some(400),
            ErrorCode::MethodNotAllowed => Some(405),
            ErrorCode::ConstraintViolation => None,
            ErrorCode::Internal => Some(500),
        }
    }
}

/// An operation's error code: a fixed one, or one of the business errors its body declares
/// (`@errors`). On the wire both are the bare code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OperationCode<B> {
    Fixed(ErrorCode),
    Business(B),
}

/// The business errors of an operation that declares none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum NoBusinessError {}

/// Every error body: a short code, and a human message that is not part of the contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody<C = ErrorCode> {
    pub error: C,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// One step of a path into a request body: a member name or an array index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PathSegment {
    Index(u64),
    Key(String),
}

/// One problem with a request body. A client treats a `code` it does not know as `custom`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub code: String,
    pub path: Vec<PathSegment>,
    pub message: String,
}

/// 400: the body failed its schema. Every issue is listed, not the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationErrorBody {
    /// Always [`ErrorCode::Validation`].
    pub error: ErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub issues: Vec<ValidationIssue>,
}

/// The kind of constraint the database refused a write on. The body never names the SQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintKind {
    Unique,
    ForeignKey,
    Check,
    NotNull,
}

impl ConstraintKind {
    /// The HTTP status a refusal on this kind of constraint answers with.
    #[must_use]
    pub const fn status(self) -> u16 {
        match self {
            ConstraintKind::Unique | ConstraintKind::ForeignKey => 409,
            ConstraintKind::Check | ConstraintKind::NotNull => 400,
        }
    }
}

/// 409 (`unique`, `foreign_key`) or 400 (`check`, `not_null`): the database refused the write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConstraintViolationBody {
    /// Always [`ErrorCode::ConstraintViolation`].
    pub error: ErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub constraint: ConstraintKind,
}
