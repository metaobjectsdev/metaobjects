//! MetaObjects prompt rendering for Rust (FR-004).
//!
//! A `template.*` body is plain Mustache. [`render`] renders it over a JSON payload the
//! same way every MetaObjects port does: partials expanded ahead of time, every
//! `{{value}}` escaped for the template's format, derived `has<Field>` and `-last`
//! accessors on the payload, and a fail-closed `maxChars` budget. The engine underneath is
//! the `mustache-ng` crate; what is specific to MetaObjects sits here, on top of it. The
//! shared `fixtures/render-conformance/` corpus holds this crate to the other ports.
//!
//! [`extract`] is the other half of a prompt: the tolerant reply parser that reads a typed
//! answer back out of a model's reply, held to `fixtures/extract-conformance/`;
//! [`extract::extract_into`] reads it on into a generated type.
//! [`prompt`] writes the output-format fragment that asks for that answer.
//! [`verify`] checks a template against its payload's field tree: the build-time drift gate
//! of a generated render helper, and the same check again when the helper renders
//! ([`render_part`]). [`FilesystemProvider`] reads templates from a directory.

/// How a generated crate names this one in its `Cargo.toml`: this release's major and minor
/// version, so it resolves to this release or a later compatible one and never to an older
/// release that lacks what the generated code calls.
pub const REQUIREMENT: &str = concat!(
    env!("CARGO_PKG_VERSION_MAJOR"),
    ".",
    env!("CARGO_PKG_VERSION_MINOR")
);

pub mod accessors;
pub mod escapers;
pub mod extract;
pub mod filesystem;
pub mod prompt;
pub mod render;
pub mod tags;
pub mod verify;

pub use filesystem::FilesystemProvider;
pub use render::{
    Body, EmailDocument, InMemoryProvider, MAX_DEPTH, Part, Provider, RenderError, RenderRequest,
    render, render_part, render_serialize,
};
pub use verify::PayloadField;
