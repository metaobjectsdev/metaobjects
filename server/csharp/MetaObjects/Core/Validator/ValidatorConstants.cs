// Validator concern constants — validator subtypes + validator attr keys.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/validator/validator-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Core.Validator;

/// <summary>
/// Validator concern constants — the 5 named validator subtypes (plus the
/// universal base) and the validator attr keys (@pattern / @min / @max).
/// </summary>
public static class ValidatorConstants
{
    public const string VALIDATOR_SUBTYPE_REQUIRED = "required";
    public const string VALIDATOR_SUBTYPE_LENGTH   = "length";
    public const string VALIDATOR_SUBTYPE_REGEX    = "regex";
    public const string VALIDATOR_SUBTYPE_NUMERIC  = "numeric";
    public const string VALIDATOR_SUBTYPE_ARRAY    = "array";

    public static readonly string[] VALIDATOR_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        VALIDATOR_SUBTYPE_REQUIRED,
        VALIDATOR_SUBTYPE_LENGTH,
        VALIDATOR_SUBTYPE_REGEX,
        VALIDATOR_SUBTYPE_NUMERIC,
        VALIDATOR_SUBTYPE_ARRAY,
    ];

    // Validator attr keys (used by codegen-ts when reading validator children)
    public const string VALIDATOR_ATTR_PATTERN = "pattern";
    public const string VALIDATOR_ATTR_MIN     = "min";
    public const string VALIDATOR_ATTR_MAX     = "max";
}
