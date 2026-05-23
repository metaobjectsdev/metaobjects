// Object attribute schemas — attrs common to every object subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/object/object-schema.ts.

namespace MetaObjects.Core.Object;

/// <summary>Attribute schemas for the object concern.</summary>
public static class ObjectSchema
{
    /// <summary>
    /// Attrs common to every object subtype. None at the core level — a
    /// language-specific runtime-strategy enum does not belong in the
    /// cross-language metamodel core (ADR-0003 §4). Matches TS objectAttrs = [].
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> ObjectAttrs = [];
}
