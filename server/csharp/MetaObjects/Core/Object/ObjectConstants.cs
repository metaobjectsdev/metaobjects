// Object concern constants — object subtypes + object-level attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/object/object-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Core.Object;

/// <summary>
/// Object concern constants — the object subtypes (base, entity, value, projection).
/// </summary>
public static class ObjectConstants
{
    // -----------------------------------------------------------------------
    // Object subtypes
    //   - base   : abstract template (no runtime semantics)
    //   - entity : persistent record (typically has @primary identity)
    //   - value  : value-object (no identity; equality by content)
    //   - projection : derived read-only representation of entities (FR-024, ADR-0028)
    //
    // No object-level attrs: a Java-runtime materialization strategy enum has no
    // place in a cross-language metamodel core (ADR-0003 §4) and no conformance
    // fixture exercises one. Matches the realized TS object concern (objectAttrs = []).
    // -----------------------------------------------------------------------

    public const string OBJECT_SUBTYPE_ENTITY     = "entity";
    public const string OBJECT_SUBTYPE_VALUE      = "value";
    public const string OBJECT_SUBTYPE_PROJECTION = "projection";

    // -----------------------------------------------------------------------
    // FR-014 — TPH discriminator attrs (registered on every object subtype).
    // The cross-port registry vocabulary declares these even where a port's
    // discriminator VALIDATION pass has not yet shipped.
    // -----------------------------------------------------------------------

    /// <summary>
    /// FR-014: names the field on this entity (resolvable via extends:) that holds
    /// the subtype-discriminator value. Subtypes declare @discriminatorValue.
    /// </summary>
    public const string OBJECT_ATTR_DISCRIMINATOR = "discriminator";

    /// <summary>
    /// FR-014: on a subtype of a @discriminator-bearing entity — the value that
    /// identifies rows of this subtype in the shared discriminator field.
    /// </summary>
    public const string OBJECT_ATTR_DISCRIMINATOR_VALUE = "discriminatorValue";

    // -----------------------------------------------------------------------
    // #207 — projection row-scope @filter (view-level WHERE)
    // -----------------------------------------------------------------------

    /// <summary>
    /// #207: an optional row-scope predicate on an object.projection (an attr.filter
    /// object — the same subType origin.aggregate's @filter uses) selecting which rows
    /// the derived view returns; lowered to an outer SQL WHERE. Mirrors
    /// origin.aggregate's @filter placement (attr.filter subType), optional (min 0 /
    /// max 1). Mirrors TS OBJECT_PROJECTION_ATTR_FILTER.
    /// </summary>
    public const string OBJECT_PROJECTION_ATTR_FILTER = "filter";

    public static readonly string[] OBJECT_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        OBJECT_SUBTYPE_ENTITY,
        OBJECT_SUBTYPE_VALUE,
        OBJECT_SUBTYPE_PROJECTION,
    ];
}
