//! MetaObjects code generation for Rust (preview).
//!
//! The run engine ([`engine`]) loads a project, decides whether anything changed
//! ([`fingerprint`], ADR-0064), renders through [`generator::Generator`]s, and writes only the
//! files whose bytes changed, keeping one hash manifest ([`hashes`]) that it saves once per
//! run. Three generators ship, each writing one crate per metadata package (ADR-0065):
//! [`entity`] (serde structs, enums, value objects and the bodies a caller sends, with
//! `validate()`), [`client`] (a typed HTTP client for the REST API the model implies) and
//! [`commands`] (command-line commands over that client). [`eject`] copies one into the
//! project to own (ADR-0034), and [`plan`] is the read model all three share.

// The shipped generators name the engine by its crate name, never `crate::`, so the one text
// compiles here and as a project's owned copy (`cargo meta eject`).
extern crate self as metaobjects_codegen;

pub mod client;
pub mod commands;
pub mod eject;
pub mod emitted;
pub mod engine;
pub mod entity;
pub mod fingerprint;
pub mod generator;
pub mod hashes;
pub mod names;
pub mod plan;
pub mod project;
pub mod sha256;
pub mod writer;

pub use client::ClientGenerator;
pub use commands::CommandsGenerator;
pub use engine::{
    Change, ChangeKind, ExtraFile, FileCounts, Outcome, Refusal, RunError, RunOptions, RunReport,
    VerifyReport, run, verify,
};
pub use entity::EntityGenerator;
pub use generator::{EmittedFile, GenContext, GenError, Generator};

/// The generators `cargo meta gen` runs when the project owns none, in the order they run.
pub fn shipped_generators() -> Vec<Box<dyn Generator>> {
    vec![
        Box::new(EntityGenerator),
        Box::new(ClientGenerator),
        Box::new(CommandsGenerator),
    ]
}
