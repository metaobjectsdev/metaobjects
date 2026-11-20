// Attribute schemas for the declared API surface (operation.*, binding.rest).
//
// Colocated per ADR-0003. Mirrors the canonical spec/metamodel/api.json: DESCRIPTIONS are
// not hand-copied — they come from the shared JSON via Registry.ApplySpecDescriptions.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Api;

/// <summary>Attribute schemas for operation.* and binding.*.</summary>
public static class ApiSchema
{
    private static AttrSchema Str(string name, bool isArray = false, IReadOnlyList<object>? allowed = null) =>
        new(Name: name, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: false,
            AllowedValues: allowed, IsArray: isArray);

    private static AttrSchema Bool(string name) =>
        new(Name: name, ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN, Required: false);

    /// <summary>The attrs every operation shares (operation.base).</summary>
    public static readonly IReadOnlyList<AttrSchema> OperationBaseAttrs =
    [
        Str(ApiConstants.OPERATION_ATTR_INPUT_REF),
        Str(ApiConstants.OPERATION_ATTR_OUTPUT_REF),
        Str(ApiConstants.OPERATION_ATTR_OBJECT_REF),
        Str(ApiConstants.OPERATION_ATTR_PERMISSION),
        Bool(ApiConstants.OPERATION_ATTR_PUBLIC),
    ];

    public static readonly IReadOnlyList<AttrSchema> CommandAttrs =
    [
        .. OperationBaseAttrs,
        Str(ApiConstants.OPERATION_ATTR_TRANSITIONS, isArray: true),
        Str(ApiConstants.OPERATION_ATTR_ERRORS, isArray: true),
    ];

    public static readonly IReadOnlyList<AttrSchema> QueryAttrs =
    [
        .. OperationBaseAttrs,
        Bool(ApiConstants.OPERATION_ATTR_MANY),
    ];

    public static readonly IReadOnlyList<AttrSchema> RestBindingAttrs =
    [
        Str(ApiConstants.BINDING_ATTR_METHOD, allowed: [.. ApiConstants.HTTP_METHODS]),
        Str(ApiConstants.BINDING_ATTR_PATH),
    ];
}
