// Object concern constants — object subtypes + object-level attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/object/object-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Core.Object;

/// <summary>
/// Object concern constants — the object subtypes (base, entity, value).
/// </summary>
public static class ObjectConstants
{
    // -----------------------------------------------------------------------
    // Object subtypes
    //   - base   : abstract template (no runtime semantics)
    //   - entity : persistent record (typically has @primary identity)
    //   - value  : value-object (no identity; equality by content)
    //
    // No object-level attrs: a Java-runtime materialization strategy enum has no
    // place in a cross-language metamodel core (ADR-0003 §4) and no conformance
    // fixture exercises one. Matches the realized TS object concern (objectAttrs = []).
    // -----------------------------------------------------------------------

    public const string OBJECT_SUBTYPE_ENTITY = "entity";
    public const string OBJECT_SUBTYPE_VALUE  = "value";

    public static readonly string[] OBJECT_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        OBJECT_SUBTYPE_ENTITY,
        OBJECT_SUBTYPE_VALUE,
    ];
}
