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
            // Cross-field validators — entity-scoped, reference sibling fields by name.
            [ValidatorConstants.VALIDATOR_SUBTYPE_COMPARISON] =
            [
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_LEFT, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "Name of the left-hand field of the owning entity."),
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_OP, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, AllowedValues: ["gt", "gte", "lt", "lte", "ne", "eq"],
                    Description: "Relational operator: gt (>), gte (>=), lt (<), lte (<=), ne (<>), eq (=)."),
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_RIGHT, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "Name of the right-hand field of the owning entity."),
            ],
            [ValidatorConstants.VALIDATOR_SUBTYPE_REQUIRED_WHEN] =
            [
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_FIELD, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "Name of the field that becomes required when the condition holds."),
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_WHEN, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "Name of the gating field whose value triggers the requirement."),
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_EQUALS, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "The gating value; when @when equals this, @field must be present."),
            ],
            [ValidatorConstants.VALIDATOR_SUBTYPE_PRESENT_IFF] =
            [
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_FIELD, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "Name of the field whose presence is governed by the condition."),
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_WHEN, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "Name of the gating field."),
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_EQUALS, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, Description: "The gating value; @field is present exactly when @when equals this."),
            ],
            [ValidatorConstants.VALIDATOR_SUBTYPE_AT_LEAST_ONE] =
            [
                new AttrSchema(Name: ValidatorConstants.VALIDATOR_ATTR_FIELDS, ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
                    Required: true, IsArray: true, Description: "Names of the candidate fields; at least one must be present."),
            ],
        };
}
