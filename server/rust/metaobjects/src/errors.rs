//! Error codes shared by every port, and the error type this crate returns.
//!
//! The codes are the cross-port contract in `fixtures/conformance/ERROR-CODES.json`;
//! a test in this module fails if one used here is missing from that file. The test
//! reads the byte-identical copy at `data/ERROR-CODES.json`, which the parity test holds
//! to the fixture.

use std::fmt;

use crate::source::ErrorSource;

pub const ERR_MALFORMED_JSON: &str = "ERR_MALFORMED_JSON";
pub const ERR_TOP_LEVEL_NOT_OBJECT: &str = "ERR_TOP_LEVEL_NOT_OBJECT";
pub const ERR_UNKNOWN_TYPE: &str = "ERR_UNKNOWN_TYPE";
pub const ERR_UNKNOWN_SUBTYPE: &str = "ERR_UNKNOWN_SUBTYPE";
pub const ERR_MISSING_SUBTYPE: &str = "ERR_MISSING_SUBTYPE";
pub const ERR_ABSTRACT_SUBTYPE_AUTHORED: &str = "ERR_ABSTRACT_SUBTYPE_AUTHORED";
pub const ERR_CHILD_NOT_OBJECT: &str = "ERR_CHILD_NOT_OBJECT";
pub const ERR_UNKNOWN_ATTR: &str = "ERR_UNKNOWN_ATTR";
pub const ERR_RESERVED_ATTR: &str = "ERR_RESERVED_ATTR";
pub const ERR_BAD_ATTR_VALUE: &str = "ERR_BAD_ATTR_VALUE";
pub const ERR_MISSING_REQUIRED_ATTR: &str = "ERR_MISSING_REQUIRED_ATTR";
pub const ERR_CHILD_NOT_ALLOWED: &str = "ERR_CHILD_NOT_ALLOWED";
pub const ERR_UNRESOLVED_SUPER: &str = "ERR_UNRESOLVED_SUPER";
pub const ERR_EXTENDS_TARGET_MISMATCH: &str = "ERR_EXTENDS_TARGET_MISMATCH";
pub const ERR_REGISTRY_SEALED: &str = "ERR_REGISTRY_SEALED";
pub const ERR_EXTEND_REQUIRED_ATTR: &str = "ERR_EXTEND_REQUIRED_ATTR";
pub const ERR_PROVIDER_ATTR_CONFLICT: &str = "ERR_PROVIDER_ATTR_CONFLICT";
pub const ERR_PROVIDER_ATTR_SHADOW: &str = "ERR_PROVIDER_ATTR_SHADOW";
pub const ERR_PROVIDER_DUPLICATE_ID: &str = "ERR_PROVIDER_DUPLICATE_ID";
pub const ERR_PROVIDER_MISSING_DEPENDENCY: &str = "ERR_PROVIDER_MISSING_DEPENDENCY";
pub const ERR_PROVIDER_DEPENDENCY_CYCLE: &str = "ERR_PROVIDER_DEPENDENCY_CYCLE";
pub const ERR_OVERLAY_NO_TARGET: &str = "ERR_OVERLAY_NO_TARGET";
pub const ERR_MERGE_CONFLICT: &str = "ERR_MERGE_CONFLICT";
pub const WARN_DUPLICATE_DECLARATION: &str = "WARN_DUPLICATE_DECLARATION";
/// The code of a warning that carries only a message: the string-list channel every
/// port's loader wraps at its boundary.
pub const WARN_LEGACY: &str = "WARN_LEGACY";

pub const ERR_MALFORMED_YAML: &str = "ERR_MALFORMED_YAML";
pub const ERR_YAML_COERCION: &str = "ERR_YAML_COERCION";
pub const ERR_SOURCE_UNRESOLVED: &str = "ERR_SOURCE_UNRESOLVED";
pub const ERR_SOURCE_KIND_UNSUPPORTED: &str = "ERR_SOURCE_KIND_UNSUPPORTED";
pub const ERR_COLLECTION_NOT_FOUND: &str = "ERR_COLLECTION_NOT_FOUND";
pub const ERR_COLLECTION_NAME_COLLISION: &str = "ERR_COLLECTION_NAME_COLLISION";
pub const ERR_UNKNOWN_LIBRARY: &str = "ERR_UNKNOWN_LIBRARY";
/// A `template.*` declared only in reference sources.
pub const ERR_REFERENCE_SOURCE_TEMPLATE: &str = "ERR_REFERENCE_SOURCE_TEMPLATE";

/// The code reported for a failure that carries none (a programming error in a
/// provider definition, say).
pub const ERR_UNKNOWN: &str = "ERR_UNKNOWN";

/// Every shared code this crate can report.
pub const ALL_CODES: &[&str] = &[
    ERR_MALFORMED_JSON,
    ERR_TOP_LEVEL_NOT_OBJECT,
    ERR_UNKNOWN_TYPE,
    ERR_UNKNOWN_SUBTYPE,
    ERR_MISSING_SUBTYPE,
    ERR_ABSTRACT_SUBTYPE_AUTHORED,
    ERR_CHILD_NOT_OBJECT,
    ERR_UNKNOWN_ATTR,
    ERR_RESERVED_ATTR,
    ERR_BAD_ATTR_VALUE,
    ERR_MISSING_REQUIRED_ATTR,
    ERR_CHILD_NOT_ALLOWED,
    ERR_UNRESOLVED_SUPER,
    ERR_EXTENDS_TARGET_MISMATCH,
    ERR_REGISTRY_SEALED,
    ERR_EXTEND_REQUIRED_ATTR,
    ERR_PROVIDER_ATTR_CONFLICT,
    ERR_PROVIDER_ATTR_SHADOW,
    ERR_PROVIDER_DUPLICATE_ID,
    ERR_PROVIDER_MISSING_DEPENDENCY,
    ERR_PROVIDER_DEPENDENCY_CYCLE,
    ERR_OVERLAY_NO_TARGET,
    ERR_MALFORMED_YAML,
    ERR_YAML_COERCION,
    ERR_SOURCE_UNRESOLVED,
    ERR_SOURCE_KIND_UNSUPPORTED,
    ERR_COLLECTION_NOT_FOUND,
    ERR_COLLECTION_NAME_COLLISION,
    ERR_UNKNOWN_LIBRARY,
    ERR_REFERENCE_SOURCE_TEMPLATE,
    ERR_UNKNOWN,
];

/// A failure with a shared error code, a message for people, and where it happened.
#[derive(Debug, Clone, PartialEq)]
pub struct MetaError {
    pub code: &'static str,
    pub message: String,
    /// Boxed so a `Result<_, MetaError>` stays small on the happy path.
    pub source: Box<ErrorSource>,
}

impl MetaError {
    /// An error raised while building the registry: it has no document location.
    pub fn code(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            source: Box::new(ErrorSource::Code),
        }
    }

    /// An `ERR_UNKNOWN` with no source: a registry or provider definition problem.
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::code(ERR_UNKNOWN, message)
    }

    /// An error located in a document.
    pub fn at(code: &'static str, message: impl Into<String>, source: ErrorSource) -> Self {
        Self {
            code,
            message: message.into(),
            source: Box::new(source),
        }
    }
}

impl fmt::Display for MetaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for MetaError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_in_the_shared_catalogue() {
        let raw = include_str!("../data/ERROR-CODES.json");
        let doc: serde_json::Value = serde_json::from_str(raw).unwrap();
        let codes = doc["codes"].as_object().unwrap();
        for code in ALL_CODES {
            assert!(
                codes.contains_key(*code),
                "{code} is not in ERROR-CODES.json"
            );
        }
    }
}
