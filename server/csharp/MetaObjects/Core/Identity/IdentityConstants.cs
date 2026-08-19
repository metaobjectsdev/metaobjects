// Identity concern constants — identity subtypes, identity attr keys, and
// primary-key generation strategies.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/identity/identity-constants.ts.

namespace MetaObjects.Core.Identity;

/// <summary>
/// Identity concern constants — the identity subtypes (primary, secondary, reference — NO
/// base), the identity attr keys, and the primary-key value-generation strategies.
/// identity.secondary is always a UNIQUE constraint; non-unique indexes use index.lookup.
/// </summary>
public static class IdentityConstants
{
    public const string IDENTITY_SUBTYPE_PRIMARY   = "primary";
    public const string IDENTITY_SUBTYPE_SECONDARY = "secondary";
    /// <summary>A foreign-key reference: local @fields hold the FK pointing at @references (FR-003).</summary>
    public const string IDENTITY_SUBTYPE_REFERENCE = "reference";

    public static readonly string[] IDENTITY_SUBTYPES =
    [
        IDENTITY_SUBTYPE_PRIMARY,
        IDENTITY_SUBTYPE_SECONDARY,
        IDENTITY_SUBTYPE_REFERENCE,
    ];

    /// <summary>
    /// The identity subtypes that denote a UNIQUE key (#310).
    ///
    /// ADR-0040 put uniqueness in the TYPE: primary and secondary are both unique keys
    /// (secondary IS the unique alternate key — @unique was removed from it precisely
    /// because the subtype already says so), while reference is a foreign key and carries
    /// no uniqueness. Named here because more than one rule needs "is this a candidate
    /// key?", and answering it by listing subtypes at each site is how the sites drift.
    /// </summary>
    public static readonly string[] IDENTITY_UNIQUE_KEY_SUBTYPES =
    [
        IDENTITY_SUBTYPE_PRIMARY,
        IDENTITY_SUBTYPE_SECONDARY,
    ];

    // Identity attrs
    public const string IDENTITY_ATTR_FIELDS     = "fields";
    public const string IDENTITY_ATTR_GENERATION = "generation";
    // NOTE: IDENTITY_ATTR_UNIQUE ("unique") is intentionally ABSENT. identity.secondary
    // is always a unique constraint; non-unique indexes use index.lookup.

    // identity.reference attrs
    /// <summary>Target of the reference: bare entity (→ its primary identity) or dotted Entity.field[,field].</summary>
    public const string IDENTITY_REFERENCE_ATTR_REFERENCES = "references";
    /// <summary>Physical-enforcement flag. Default true → hard FK constraint; false → logical-only reference.</summary>
    public const string IDENTITY_REFERENCE_ATTR_ENFORCE    = "enforce";

    // Identity generation strategies (values for IDENTITY_ATTR_GENERATION)
    public const string GENERATION_INCREMENT = "increment";
    public const string GENERATION_UUID      = "uuid";
    public const string GENERATION_ASSIGNED  = "assigned";

    public static readonly string[] GENERATION_VALUES =
    [
        GENERATION_INCREMENT,
        GENERATION_UUID,
        GENERATION_ASSIGNED,
    ];
}
