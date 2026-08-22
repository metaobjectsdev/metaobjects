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
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true,
        IsArray: true,
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

    /// <summary>
    /// @fields on identity.secondary is OPTIONAL, unlike primary/reference (#342). The
    /// real rule is @fields XOR @expr — a unique index may key off a raw expression
    /// instead of columns — and an exclusive-or is not expressible as a per-attr
    /// Required flag, so ValidationPasses.ValidateIndexLookupFields enforces it
    /// (ERR_INVALID_INDEX). Required:true here fired first and made an expression
    /// index undeclarable.
    /// </summary>
    private static readonly AttrSchema SecondaryFieldsAttr = new AttrSchema(
        Name: IdentityConstants.IDENTITY_ATTR_FIELDS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        IsArray: true,
        Description: "The field name(s) composing this identity. Single-element for a simple unique index, multiple for a composite unique constraint. Required UNLESS @expr is present — a unique index keys off plain columns (@fields) or a key expression (@expr), never both; declaring both is ERR_INVALID_INDEX.");

    private static readonly IReadOnlyList<AttrSchema> SecondaryIdentityAttrs =
    [
        SecondaryFieldsAttr,
        // NOTE: @unique is REMOVED from identity.secondary. identity.secondary is
        // always a unique constraint by definition. Non-unique indexes are expressed
        // via index.lookup — the dedicated type for query-performance indexes.
    ];

    private static readonly IReadOnlyList<AttrSchema> ReferenceIdentityAttrs =
    [
        IdentityFieldsAttr,
        new AttrSchema(
            Name: IdentityConstants.IDENTITY_REFERENCE_ATTR_REFERENCES,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Target of the reference. Bare entity name resolves to that entity's primary identity; " +
                "dotted forms ('Program.id' or 'Program.a,b') target an explicit field set."),
        new AttrSchema(
            Name: IdentityConstants.IDENTITY_REFERENCE_ATTR_ENFORCE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true (default), the backend physically enforces the reference (SQL FK constraint). " +
                "Set false for a logical-only reference (navigation/typing/codegen)."),
    ];

    /// <summary>
    /// Attrs per identity subtype. primary adds @generation; secondary carries only
    /// @fields (always-unique constraint — non-unique indexes use index.lookup);
    /// reference adds @references (+ @enforce).
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> IdentityAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [IdentityConstants.IDENTITY_SUBTYPE_PRIMARY]   = [.. PrimaryIdentityAttrs],
            [IdentityConstants.IDENTITY_SUBTYPE_SECONDARY] = [.. SecondaryIdentityAttrs],
            [IdentityConstants.IDENTITY_SUBTYPE_REFERENCE] = [.. ReferenceIdentityAttrs],
        };
}
