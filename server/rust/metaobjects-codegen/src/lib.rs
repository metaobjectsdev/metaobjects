//! MetaObjects code generation for Rust (preview).
//!
//! The run engine ([`engine`]) loads a project, decides whether anything changed
//! ([`fingerprint`], ADR-0064), renders through [`generator::Generator`]s, and writes only the
//! files whose bytes changed, keeping one hash manifest ([`hashes`]) that it saves once per
//! run. [`entity`] is the first generator: serde structs, enums and value objects, one crate
//! per metadata package (ADR-0065).

pub mod engine;
pub mod entity;
pub mod fingerprint;
pub mod generator;
pub mod hashes;
pub mod names;
pub mod project;
pub mod sha256;

pub use engine::{FileCounts, Outcome, RunError, RunOptions, RunReport, run};
pub use entity::EntityGenerator;
pub use generator::{EmittedFile, GenContext, GenError, Generator};
