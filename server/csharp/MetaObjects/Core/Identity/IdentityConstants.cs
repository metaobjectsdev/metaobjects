// Identity concern constants — identity subtypes, identity attr keys, and
// primary-key generation strategies.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/identity/identity-constants.ts.

namespace MetaObjects.Core.Identity;

/// <summary>
/// Identity concern constants — the identity subtypes (primary, secondary — NO
/// base; Java doesn't register one), the identity attr keys, and the primary-key
/// value-generation strategies.
/// </summary>
public static class IdentityConstants
{
    public const string IDENTITY_SUBTYPE_PRIMARY   = "primary";
    public const string IDENTITY_SUBTYPE_SECONDARY = "secondary";

    public static readonly string[] IDENTITY_SUBTYPES =
    [
        IDENTITY_SUBTYPE_PRIMARY,
        IDENTITY_SUBTYPE_SECONDARY,
    ];

    // Identity attrs
    public const string IDENTITY_ATTR_FIELDS     = "fields";
    public const string IDENTITY_ATTR_GENERATION = "generation";
    /// <summary>On secondary identities: true → uniqueIndex; false/absent → index. Defaults to true for back-compat.</summary>
    public const string IDENTITY_ATTR_UNIQUE     = "unique";

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
