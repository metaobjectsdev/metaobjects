//! MetaObjects code generation for Rust.
//!
//! The run engine ([`engine`]) loads a project, decides whether anything changed
//! ([`fingerprint`], ADR-0064), renders through [`generator::Generator`]s, and writes only the
//! files whose bytes changed, keeping one hash manifest ([`hashes`]) that it saves once per
//! run. Each shipped generator writes one crate per metadata package (ADR-0065): [`entity`]
//! (serde structs, enums, value objects and the bodies a caller sends, with `validate()`),
//! [`rules_names`] and [`contract_types`] (the rules layers 0 and 1, ADR-0067), [`client`] (a
//! typed HTTP client for the REST API the model implies), [`commands`] (command-line commands
//! over that client) and the prompt tier ([`render_helper`], [`output_parser`],
//! [`output_prompt`]). [`eject`] copies one into the project to own (ADR-0034), and [`plan`] is
//! the read model they share.

// The shipped generators name the engine by its crate name, never `crate::`, so the one text
// compiles here and as a project's owned copy (`cargo meta eject`).
extern crate self as metaobjects_codegen;

pub mod client;
pub mod commands;
pub mod contract_types;
pub mod eject;
pub mod emitted;
pub mod engine;
pub mod entity;
pub mod fingerprint;
pub mod generator;
pub mod generator_list;
pub mod hashes;
pub mod inbound;
pub mod names;
pub mod output_parser;
pub mod output_prompt;
pub mod plan;
pub mod project;
pub mod render_helper;
pub mod rules_names;
pub mod sha256;
pub mod writer;

pub use client::ClientGenerator;
pub use commands::CommandsGenerator;
pub use contract_types::ContractTypesGenerator;
pub use engine::{
    Change, ChangeKind, ExtraFile, FileCounts, Outcome, Refusal, RunError, RunOptions, RunReport,
    VerifyReport, run, verify,
};
pub use entity::EntityGenerator;
pub use generator::{EmittedFile, GenContext, GenError, Generator};
/// The prompt render crate the `render-helper` generator checks templates with, so an owned
/// copy of it names `metaobjects_codegen::render` and needs no dependency of its own.
pub use metaobjects_render as render;
pub use output_parser::OutputParserGenerator;
pub use output_prompt::OutputPromptGenerator;
pub use render_helper::{RenderHelperGenerator, TemplateCheck, check_templates};
pub use rules_names::RulesNamesGenerator;

/// The generators `cargo meta gen` runs when the project owns none, in the order they run.
pub fn shipped_generators() -> Vec<Box<dyn Generator>> {
    vec![
        Box::new(EntityGenerator),
        Box::new(RulesNamesGenerator),
        Box::new(ContractTypesGenerator),
        Box::new(ClientGenerator),
        Box::new(CommandsGenerator),
        Box::new(RenderHelperGenerator),
        Box::new(OutputParserGenerator),
        Box::new(OutputPromptGenerator),
    ]
}
