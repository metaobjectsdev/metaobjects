// Base type vocabulary — the registered base types + universal/metadata subtypes.
//
// Colocated per ADR-0003 (metamodel constants live with the concern that owns
// them; no god constants file). Mirrors typescript/packages/metadata/src/shared/base-types.ts.
// SCREAMING_SNAKE names are intentional: cross-language grep parity with TS + Java.

namespace MetaObjects.Shared;

/// <summary>
/// Base type discriminators — the registered base types (Java metaobjects-core
/// vocabulary) plus the universal/metadata subtypes. Wire-format identifiers; do not rename.
/// </summary>
public static class BaseTypes
{
    // -----------------------------------------------------------------------
    // Base type names
    // -----------------------------------------------------------------------

    public const string TYPE_METADATA     = "metadata";
    public const string TYPE_OBJECT       = "object";
    public const string TYPE_FIELD        = "field";
    public const string TYPE_ATTR         = "attr";
    public const string TYPE_VALIDATOR    = "validator";
    public const string TYPE_VIEW         = "view";
    public const string TYPE_IDENTITY     = "identity";
    public const string TYPE_RELATIONSHIP = "relationship";
    public const string TYPE_LAYOUT       = "layout";
    public const string TYPE_SOURCE       = "source";
    public const string TYPE_ORIGIN       = "origin";

    public static readonly string[] BASE_TYPES =
    [
        TYPE_METADATA,
        TYPE_OBJECT,
        TYPE_FIELD,
        TYPE_ATTR,
        TYPE_VALIDATOR,
        TYPE_VIEW,
        TYPE_IDENTITY,
        TYPE_RELATIONSHIP,
        TYPE_LAYOUT,
        TYPE_SOURCE,
        TYPE_ORIGIN,
    ];

    // -----------------------------------------------------------------------
    // Universal subtype
    // -----------------------------------------------------------------------

    /// <summary>The universal subtype name (every base type may register a <c>.base</c> subtype).</summary>
    public const string SUBTYPE_BASE = "base";

    // -----------------------------------------------------------------------
    // Metadata subtypes (1)
    // -----------------------------------------------------------------------

    /// <summary>
    /// The metadata document root subtype. The root node is <c>metadata.root</c> in the
    /// canonical format. (Distinct from the universal SUBTYPE_BASE — the redesigned
    /// format spec confirms the root subtype is <c>root</c>, not <c>base</c>.)
    /// </summary>
    public const string SUBTYPE_ROOT = "root";

    public static readonly string[] METADATA_SUBTYPES = [SUBTYPE_ROOT];
}
