//! The validation passes, run in the order the TypeScript reference runs them.
//!
//! Each pass is one named function over the merged, super-resolved tree. Order is
//! part of the contract: the corpus compares error envelopes position by position, so
//! a pass added here goes where the reference runs it. Every pass is timed under its
//! own name (see [`crate::timing`]), so adding one shows in the benchmark table.

pub mod attrs;
pub mod field;
pub mod field_expr;
pub mod field_policy;
pub mod origin;
pub mod persistence;
pub mod prompt;
pub mod refs;
pub mod relationships;
pub mod reporting;
pub mod rules;
pub mod structure;
pub mod util;

use crate::errors::MetaError;
use crate::naming::NamingCtx;
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
    /// The root's objects by resolution key, built once per load.
    pub objects: &'a util::ObjectIndex,
    /// The project's physical naming and the registry its names resolve in.
    pub naming: NamingCtx<'a>,
}

/// The part of [`Ctx`] that reading a loaded model needs: its tree and its objects by key.
/// The `verify` rules gate runs after the load, when no registry is at hand, and reads
/// through this.
#[derive(Clone, Copy)]
pub struct Env<'a> {
    pub tree: &'a Tree,
    pub objects: &'a util::ObjectIndex,
}

impl<'a> Ctx<'a> {
    pub fn env(&self) -> Env<'a> {
        Env {
            tree: self.tree,
            objects: self.objects,
        }
    }
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
///
/// The order below is `MetaDataLoader.load` in the TypeScript reference
/// (`loader/meta-data-loader.ts`). A pass joins the list at its place in that
/// order. Every reference pass has a Rust port; the table lists them in the order
/// they run:
///
/// ```text
///  validateSubtypeRules (errors + warnings)   validateMaxOccurs
///  validateIdentityPassthrough                validateDataGridSortFields
///  validateFilterableHasIndex (warning)       validateExtenderSubtypeScope (warning)
///  validateFilterableHasSupportedOps          validateSortableHasSupportedSubtype
///  validateOriginPaths                        validateDerivedFieldProvidability
///  validateDataGridFilterValues               validateProjectionFilter
///  validateOriginSegmentsAndCorrelation       validateProjectionUnionAndGrain
///  validateDerivedCycles                      validateReporting
///  validateRules                              validateRelationships
///  validateOneSideReferenceResolution         validateM2MJunctionPairing
///  validateIndexLookupFields                  validateColumnNameCollisions
///  validateRetiredRequirementLinks            runRegisteredValidation
///  validateTemplatePayloadRefs                validateAttrSchema (errors + warnings)
///  validateFieldObjectStorage                 validateFieldMap
///  validateEnumMaxLength                      validateIdentitySequence
///  validateCrossFieldValidators               validateDbCheck
///  validateSourceRoles                        validateSourceEscapes
///  validateSourcePhysicalNames                validateFieldMutability
///  validateEnumNormalizeAmbiguity (warning)   validateEnumNormalizeCollision
///  validateSourceParameterRef                 validateDiscriminator
///  validateFieldDefaults
/// ```
pub const PASSES: &[(&str, PassFn)] = &[
    ("subtype rules", structure::subtype_rules),
    ("max occurs", structure::max_occurs),
    ("identity passthrough", structure::identity_passthrough),
    (
        "data grid sort fields",
        persistence::validate_data_grid_sort_fields,
    ),
    (
        "filterable has index",
        persistence::validate_filterable_has_index,
    ),
    (
        "extender subtype scope",
        origin::validate_extender_subtype_scope,
    ),
    (
        "filterable supported ops",
        persistence::validate_filterable_has_supported_ops,
    ),
    (
        "sortable supported subtype",
        persistence::validate_sortable_has_supported_subtype,
    ),
    ("origin paths", origin::validate_origin_paths),
    (
        "derived field providability",
        origin::validate_derived_field_providability,
    ),
    (
        "data grid filter values",
        persistence::validate_data_grid_filter_values,
    ),
    ("projection filter", origin::validate_projection_filter),
    (
        "origin segments and correlation",
        origin::validate_origin_segments_and_correlation,
    ),
    (
        "projection union and grain",
        origin::validate_projection_union_and_grain,
    ),
    ("derived cycles", origin::validate_derived_cycles),
    ("reporting", reporting::validate_reporting),
    ("rules", rules::validate_rules),
    ("relationships", relationships::validate_relationships),
    (
        "one-side reference resolution",
        relationships::validate_one_side_reference_resolution,
    ),
    (
        "m2m junction pairing",
        relationships::validate_m2m_junction_pairing,
    ),
    (
        "index lookup fields",
        persistence::validate_index_lookup_fields,
    ),
    (
        "column name collisions",
        persistence::validate_column_name_collisions,
    ),
    (
        "retired requirement links",
        prompt::validate_retired_requirement_links,
    ),
    ("registered validation", refs::registered_validation),
    (
        "template payload refs",
        prompt::validate_template_payload_refs,
    ),
    ("attr schema", attrs::attr_schema),
    ("field object storage", field::validate_field_object_storage),
    ("field map", field::validate_field_map),
    ("enum max length", field::validate_enum_max_length),
    ("identity sequence", structure::identity_sequence),
    (
        "cross-field validators",
        field_expr::validate_cross_field_validators,
    ),
    ("db check", field_expr::validate_db_check),
    ("source roles", persistence::validate_source_roles),
    ("source escapes", persistence::validate_source_escapes),
    (
        "source physical names",
        persistence::validate_source_physical_names,
    ),
    ("field mutability", field_policy::validate_field_mutability),
    (
        "enum normalize ambiguity",
        field_policy::validate_enum_normalize_ambiguity,
    ),
    (
        "enum normalize collision",
        field_policy::validate_enum_normalize_collision,
    ),
    (
        "source parameter ref",
        persistence::validate_source_parameter_ref,
    ),
    ("discriminator", structure::discriminator),
    ("field defaults", field::validate_field_defaults),
];

/// Run every pass, timing each under its own name and all of them under the
/// `validation` phase.
pub fn run(ctx: &Ctx<'_>, findings: &mut Findings, timings: &mut LoadTimings) {
    let start = std::time::Instant::now();
    for (name, pass) in PASSES {
        timings.pass(name, || pass(ctx, findings));
    }
    timings.add_phase(PHASE_VALIDATE, start.elapsed());
}
