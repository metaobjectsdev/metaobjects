//! MetaObjects prompt rendering for Rust (FR-004).
//!
//! A `template.*` body is plain Mustache. [`render`] renders it over a JSON payload the
//! same way every MetaObjects port does: partials expanded ahead of time, every
//! `{{value}}` escaped for the template's format, derived `has<Field>` and `-last`
//! accessors on the payload, a fail-closed `maxChars` budget, and a variable missing from
//! the payload refused rather than rendered empty (`ERR_VAR_NOT_ON_PAYLOAD`). The engine underneath is
//! the `mustache-ng` crate; what is specific to MetaObjects sits here, on top of it. The
//! shared `fixtures/render-conformance/` corpus holds this crate to the other ports.
//!
//! [`extract`] is the other half of a prompt: the tolerant reply parser that reads a typed
//! answer back out of a model's reply, held to `fixtures/extract-conformance/`.
//! [`prompt`] writes the output-format fragment that asks for that answer.

pub mod accessors;
pub mod escapers;
pub mod extract;
pub mod presence;
pub mod prompt;
pub mod render;
pub mod tags;

pub use render::{
    Body, InMemoryProvider, MAX_DEPTH, Provider, RenderError, RenderRequest, render,
    render_serialize,
};
