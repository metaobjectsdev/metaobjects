// Object attribute schemas — attrs common to every object subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/object/object-schema.ts.

using MetaObjects.Core.Attr;

namespace MetaObjects.Core.Object;

/// <summary>Attribute schemas for the object concern.</summary>
public static class ObjectSchema
{
    /// <summary>
    /// Attrs common to every object subtype. FR-014 TPH discriminator attrs
    /// (@discriminator on the base/root; @discriminatorValue on subtypes) — the
    /// cross-port registry vocabulary. Matches TS objectAttrs.
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> ObjectAttrs =
    [
        new AttrSchema(
            Name: ObjectConstants.OBJECT_ATTR_DISCRIMINATOR,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description:
                "FR-014: names the field on this entity (resolvable via extends:) that " +
                "holds the subtype-discriminator value. Subtypes of this entity declare " +
                "@discriminatorValue to bind their rows to a discriminator value. The " +
                "discriminator field itself is an ordinary field declaration (typically " +
                "field.enum or field.int / field.string)."),

        new AttrSchema(
            Name: ObjectConstants.OBJECT_ATTR_DISCRIMINATOR_VALUE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description:
                "FR-014: on a subtype of an entity with @discriminator — the value that " +
                "identifies rows of this subtype in the shared discriminator field. Wire " +
                "form is always a string; the underlying field's subtype (enum / int / " +
                "string) controls codegen + storage coercion. Required on every concrete " +
                "subtype of a discriminated entity."),
    ];

    /// <summary>
    /// #207 — the optional row-scope @filter on an object.projection (a portable
    /// attr.filter object, the same subType origin.aggregate's @filter uses). Selects
    /// which rows the derived view returns; lowered to an outer SQL WHERE. Registered
    /// ONLY on object.projection (see CoreTypes); the description is single-sourced
    /// from spec/metamodel/object.json via ApplySpecDescriptions, so this text is a
    /// fallback that already matches the canonical.
    /// </summary>
    public static readonly AttrSchema ProjectionFilterAttr =
        new AttrSchema(
            Name: ObjectConstants.OBJECT_PROJECTION_ATTR_FILTER,
            ValueType: AttrConstants.ATTR_SUBTYPE_FILTER,
            Required: false,
            Description:
                "Optional row-scope predicate (a portable attr.filter object: " +
                "eq/ne/gt/gte/lt/lte/like/in/isNull with and/or, desugared to " +
                "{ field: { op: value } } at parse time) selecting which rows the view " +
                "returns — lowered to an outer SQL WHERE. Resolves against the " +
                "projection's own declared fields; an aggregate-derived field is not " +
                "addressable (fail-closed).");
}
