// Identity attribute schemas — @fields (required) + per-subtype attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/identity/identity-schema.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Identity;

/// <summary>Attribute schemas for the identity concern.</summary>
public static class IdentitySchema
{
    /// <summary>@fields is required on identity.primary / identity.secondary.</summary>
    public static readonly AttrSchema IdentityFieldsAttr = new AttrSchema(
        Name: IdentityConstants.IDENTITY_ATTR_FIELDS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY,
        Required: true,
        Description: "The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite.");

    private static readonly IReadOnlyList<AttrSchema> PrimaryIdentityAttrs =
    [
        IdentityFieldsAttr,
        new AttrSchema(
            Name: IdentityConstants.IDENTITY_ATTR_GENERATION,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. IdentityConstants.GENERATION_VALUES],
            Description: "Primary-key value generation strategy: 'increment' (auto-increment), 'uuid', or 'assigned' (caller-supplied)."),
    ];

    private static readonly IReadOnlyList<AttrSchema> SecondaryIdentityAttrs =
    [
        IdentityFieldsAttr,
        new AttrSchema(
            Name: IdentityConstants.IDENTITY_ATTR_UNIQUE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true (default), the secondary identity is a UNIQUE index; false makes it a plain (non-unique) index."),
    ];

    /// <summary>
    /// Attrs per identity subtype. primary adds @generation; secondary adds @unique.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> IdentityAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [IdentityConstants.IDENTITY_SUBTYPE_PRIMARY]   = [.. PrimaryIdentityAttrs],
            [IdentityConstants.IDENTITY_SUBTYPE_SECONDARY] = [.. SecondaryIdentityAttrs],
        };
}
