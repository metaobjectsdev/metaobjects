//! The reply parser (FR-010, FR-011): tolerant extraction of a typed answer from a model's
//! dirty reply.
//!
//! A model asked for JSON or XML answers with fences, prose, comments, trailing commas,
//! cut-off values and synonyms. [`extract`] reads what it can, classifies every declared
//! field ([`FieldExtraction`]) and coerces each value to its kind, and never fails: a
//! caller decides from the report whether the answer is good enough
//! ([`ExtractionReport::fails_strict`]). The shared `fixtures/extract-conformance/` corpus
//! holds this module to the other ports.

pub(crate) mod coerce;
mod engine;
pub mod json_reader;
pub mod locate;
pub mod normalize;
pub mod strip;
mod types;
pub mod xml_reader;

pub use engine::extract;
pub use types::{
    Coercion, ExtractOptions, ExtractSchema, ExtractionOutcome, ExtractionReport, FieldExtraction,
    FieldKind, FieldSpec, Format, Normalizer, OnField, OnLocate, Tolerance,
};
