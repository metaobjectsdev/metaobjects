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
    // Cross-field validators — entity-scoped, reference sibling fields by name.
    public const string VALIDATOR_SUBTYPE_COMPARISON    = "comparison";
    public const string VALIDATOR_SUBTYPE_REQUIRED_WHEN = "requiredWhen";
    public const string VALIDATOR_SUBTYPE_PRESENT_IFF   = "presentIff";
    public const string VALIDATOR_SUBTYPE_AT_LEAST_ONE  = "atLeastOne";

    public static readonly string[] VALIDATOR_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        VALIDATOR_SUBTYPE_REQUIRED,
        VALIDATOR_SUBTYPE_LENGTH,
        VALIDATOR_SUBTYPE_REGEX,
        VALIDATOR_SUBTYPE_NUMERIC,
        VALIDATOR_SUBTYPE_ARRAY,
        VALIDATOR_SUBTYPE_COMPARISON,
        VALIDATOR_SUBTYPE_REQUIRED_WHEN,
        VALIDATOR_SUBTYPE_PRESENT_IFF,
        VALIDATOR_SUBTYPE_AT_LEAST_ONE,
    ];

    // Validator attr keys (used by codegen-ts when reading validator children)
    public const string VALIDATOR_ATTR_PATTERN = "pattern";
    public const string VALIDATOR_ATTR_MIN     = "min";
    public const string VALIDATOR_ATTR_MAX     = "max";
    // Cross-field validator attrs (field references by name + operator/value).
    public const string VALIDATOR_ATTR_LEFT   = "left";
    public const string VALIDATOR_ATTR_OP     = "op";
    public const string VALIDATOR_ATTR_RIGHT  = "right";
    public const string VALIDATOR_ATTR_FIELD  = "field";
    public const string VALIDATOR_ATTR_WHEN   = "when";
    public const string VALIDATOR_ATTR_EQUALS = "equals";
    public const string VALIDATOR_ATTR_FIELDS = "fields";
}
