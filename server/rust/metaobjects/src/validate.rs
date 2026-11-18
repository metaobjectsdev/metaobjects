//! The validation passes, run in the order the TypeScript reference runs them.
//!
//! Each pass is one named function over the merged, super-resolved tree. Order is
//! part of the contract: the corpus compares error envelopes position by position, so
//! a pass added here goes where the reference runs it. Every pass is timed under its
//! own name (see [`crate::timing`]), so adding one shows in the benchmark table.

use crate::errors::MetaError;
use crate::node::{NodeId, Tree};
use crate::registry::TypeRegistry;
use crate::timing::{LoadTimings, PHASE_VALIDATE};

/// What a pass reads.
pub struct Ctx<'a> {
    pub tree: &'a Tree,
    pub root: NodeId,
    pub registry: &'a TypeRegistry,
    /// Strict mode, as the loader option of that name.
    pub strict: bool,
}

/// What a pass writes. Errors and warnings are separate channels, as in every port.
#[derive(Debug, Default)]
pub struct Findings {
    pub errors: Vec<MetaError>,
    pub warnings: Vec<MetaError>,
}

/// One validation pass.
pub type PassFn = fn(&Ctx<'_>, &mut Findings);

/// Every pass, in the reference's order, each under the name the benchmark prints.
pub const PASSES: &[(&str, PassFn)] = &[];

/// Run every pass, timing each under its own name and all of them under the
/// `validation` phase.
pub fn run(ctx: &Ctx<'_>, findings: &mut Findings, timings: &mut LoadTimings) {
    let start = std::time::Instant::now();
    for (name, pass) in PASSES {
        timings.pass(name, || pass(ctx, findings));
    }
    timings.add_phase(PHASE_VALIDATE, start.elapsed());
}
