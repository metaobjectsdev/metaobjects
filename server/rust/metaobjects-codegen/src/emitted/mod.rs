//! Source the generators write verbatim into generated crates.
//!
//! The three modules are real code here, compiled and tested with the engine (the shared
//! `decimal-wire` and `duration-wire` vectors and the validation corpus run against them
//! directly), and the `entity` generator emits the same bytes as `meta_support/src/`. The generated
//! crates therefore carry their wire types and validation checks as their own source and
//! depend on nothing from MetaObjects.
//!
//! They are laid out for the `rustfmt.toml` a generated crate carries, not for this
//! workspace's, so `cargo fmt` skips them here and the compile gate checks them there.

#[rustfmt::skip]
pub mod list_query;
#[rustfmt::skip]
pub mod pattern;
#[rustfmt::skip]
pub mod validation;
#[rustfmt::skip]
pub mod wire;

/// The text of `meta_http/src/list_query.rs`, the list-query parser of the `service-routes`
/// generator's crates.
pub const LIST_QUERY_RS: &str = include_str!("list_query.rs");
/// The text of `src/pattern.rs` in a generated crate.
pub const PATTERN_RS: &str = include_str!("pattern.rs");
/// The text of `src/validation.rs` in a generated crate.
pub const VALIDATION_RS: &str = include_str!("validation.rs");
/// The text of `src/wire.rs` in a generated crate.
pub const WIRE_RS: &str = include_str!("wire.rs");

// More files are fixed text a generator writes whole but are not compiled here: they are
// written for the dependencies of the crate they land in (`reqwest` for the transport), which
// this crate does not have. The compile gate builds them in a generated workspace.

/// The text of `meta_client/src/lib.rs`, the transport the `client` generator's crates share.
pub const CLIENT_TRANSPORT_RS: &str = include_str!("client_transport.rs");
/// The text of `meta_cli/src/lib.rs`, the helpers the `commands` generator's crates share.
pub const COMMAND_HELPERS_RS: &str = include_str!("command_helpers.rs");
/// The text of `meta_contract/src/lib.rs`, the wire error contract the `contract-types`
/// generator's crates share.
pub const CONTRACT_RS: &str = include_str!("contract.rs");
/// The text of `meta_store/src/lib.rs`, the data access the `repository` generator's crates
/// share (written for `sqlx`).
pub const STORE_RS: &str = include_str!("store.rs");
/// The text of `meta_http/src/lib.rs`, the REST mechanics the `service-routes` generator's
/// crates share (written for `axum`).
pub const HTTP_RS: &str = include_str!("http.rs");
/// The text of `meta_service/src/lib.rs`, the mechanics the `service` generator's crates share
/// (written for `sqlx`).
pub const SERVICE_RS: &str = include_str!("service.rs");
