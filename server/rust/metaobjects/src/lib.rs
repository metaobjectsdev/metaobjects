//! MetaObjects for Rust (preview).
//!
//! The metamodel registry, the JSON loader and the canonical serializer. The
//! behaviour is defined by the shared conformance corpora that every port runs;
//! ADR-0063 records how this port differs from the other five.

pub mod errors;
pub mod json;
pub mod loader;
pub mod manifest;
pub mod node;
pub mod parser;
pub mod providers;
pub mod registry;
pub mod serializer;
pub mod source;

pub use errors::MetaError;
pub use loader::{LoadResult, Loader};
pub use node::{Attr, Node, NodeId, Tree};
pub use providers::{Provider, compose_registry, core_providers, default_registry};
pub use registry::TypeRegistry;
