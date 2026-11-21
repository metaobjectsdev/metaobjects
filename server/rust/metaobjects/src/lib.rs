//! MetaObjects for Rust.
//!
//! The metamodel registry, the JSON and YAML loader, project and source
//! resolution (the `.metaobjects/config.json` reader, the library sources),
//! naming, and the canonical serializer. The
//! behaviour is defined by the shared conformance corpora that every port runs;
//! ADR-0065 records how this port differs from the other five.

pub mod collection;
pub mod config;
pub mod errors;
pub mod json;
pub mod library;
pub mod loader;
pub mod manifest;
pub mod naming;
pub mod node;
pub mod parser;
pub mod providers;
pub mod registry;
pub mod report_shape;
pub mod rules_check;
pub mod rules_names;
pub mod serializer;
pub mod source;
pub mod sources;
pub mod timing;
pub mod validate;
pub mod yaml;

pub use errors::MetaError;
pub use loader::{LoadResult, Loader};
pub use node::{Attr, Node, NodeId, Tree};
pub use providers::{Provider, compose_registry, core_providers, default_registry};
pub use registry::TypeRegistry;
