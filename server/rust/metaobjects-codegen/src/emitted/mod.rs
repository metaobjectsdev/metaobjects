//! Source the `entity` generator writes verbatim into the generated support crate.
//!
//! The three modules are real code here, compiled and tested with the engine (the shared
//! `decimal-wire` and `duration-wire` vectors and the validation corpus run against them
//! directly), and the generator emits the same bytes as `meta_support/src/`. The generated
//! crates therefore carry their wire types and validation checks as their own source and
//! depend on nothing from MetaObjects.
//!
//! They are laid out for the `rustfmt.toml` a generated crate carries, not for this
//! workspace's, so `cargo fmt` skips them here and the compile gate checks them there.

#[rustfmt::skip]
pub mod pattern;
#[rustfmt::skip]
pub mod validation;
#[rustfmt::skip]
pub mod wire;

/// The text of `src/pattern.rs` in a generated crate.
pub const PATTERN_RS: &str = include_str!("pattern.rs");
/// The text of `src/validation.rs` in a generated crate.
pub const VALIDATION_RS: &str = include_str!("validation.rs");
/// The text of `src/wire.rs` in a generated crate.
pub const WIRE_RS: &str = include_str!("wire.rs");
