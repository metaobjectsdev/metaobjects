//! The walks the ADR-0067 layer generators share: the rules names a package declares, the
//! entities a store crate reads and writes, and the operations a service crate holds. They are
//! engine, not a generator's own module, so a generator owned through `cargo meta eject` calls
//! the same walk the shipped one does.

pub mod rules;
pub mod service;
pub mod store;
