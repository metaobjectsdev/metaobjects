// Validator attribute schemas — attrs per validator subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/validator/validator-schema.ts.

using MetaObjects.Core.Attr;
using MetaObjects.Shared;

namespace MetaObjects.Core.Validator;

/// <summary>Attribute schemas for the validator concern.</summary>
public static class ValidatorSchema
{
    // @min / @max shared by length, numeric, array, and the base validator.
    private static readonly IReadOnlyList<AttrSchema> MinMaxValidatorAttrs =
    [
        new AttrSchema(
            Name: ValidatorConstants.VALIDATOR_ATTR_MIN,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Minimum allowed value (length, numeric value, or array element count depending on the validator subtype)."),

        new AttrSchema(
            Name: ValidatorConstants.VALIDATOR_ATTR_MAX,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Maximum allowed value (length, numeric value, or array element count depending on the validator subtype)."),
    ];

    /// <summary>
    /// Attrs per validator subtype. required uses none; regex adds @pattern;
    /// length / numeric / array (and the base) use @min / @max.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> ValidatorAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [BaseTypes.SUBTYPE_BASE]                   = [.. MinMaxValidatorAttrs],
            [ValidatorConstants.VALIDATOR_SUBTYPE_REQUIRED] = [],
            [ValidatorConstants.VALIDATOR_SUBTYPE_LENGTH]   = [.. MinMaxValidatorAttrs],
            [ValidatorConstants.VALIDATOR_SUBTYPE_REGEX]    =
            [
                .. MinMaxValidatorAttrs,
                new AttrSchema(
                    Name: ValidatorConstants.VALIDATOR_ATTR_PATTERN,
                    ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: false,
                    Description: "Regular expression the value must match."),
            ],
            [ValidatorConstants.VALIDATOR_SUBTYPE_NUMERIC]  = [.. MinMaxValidatorAttrs],
            [ValidatorConstants.VALIDATOR_SUBTYPE_ARRAY]    = [.. MinMaxValidatorAttrs],
        };
}
