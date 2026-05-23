// MetaOrigin — concrete node class for type=origin nodes.
// MetaPassthroughOrigin and MetaAggregateOrigin are co-located subtype classes.
//
// Ported 1:1 from typescript/packages/metadata/src/meta/meta-origin.ts.

namespace MetaObjects.Meta;

/// <summary>
/// Concrete base node class for <c>origin.*</c> nodes (field-level provenance).
/// Extends <see cref="MetaData"/> directly: no model wrapper, no metaOf() indirection.
/// </summary>
public class MetaOrigin(TypeId typeId, string name) : MetaData(typeId, name) { }

/// <summary>
/// Passthrough origin — the field's value is sourced directly from a
/// cross-entity field reference (e.g. a projection that forwards <c>Program.title</c>).
/// </summary>
public class MetaPassthroughOrigin(TypeId typeId, string name) : MetaOrigin(typeId, name)
{
    /// <summary>
    /// The dotted-path cross-entity field reference this origin passes through
    /// (e.g. <c>"Program.title"</c>).
    /// </summary>
    public string? From
    {
        get
        {
            var v = OwnAttr(ORIGIN_PASSTHROUGH_ATTR_FROM);
            return v is string s ? s : null;
        }
    }

    /// <summary>Optional dotted relationship path used to reach the source entity (e.g. <c>"Program.weeks"</c>).</summary>
    public string? Via
    {
        get
        {
            var v = OwnAttr(ORIGIN_PASSTHROUGH_ATTR_VIA);
            return v is string s ? s : null;
        }
    }
}

/// <summary>
/// Aggregate origin — the field's value is computed by aggregating values
/// over a relationship path (count / sum / avg / min / max).
/// </summary>
public class MetaAggregateOrigin(TypeId typeId, string name) : MetaOrigin(typeId, name)
{
    /// <summary>The aggregate function (<c>count</c> | <c>sum</c> | <c>avg</c> | <c>min</c> | <c>max</c>).</summary>
    public string? Agg
    {
        get
        {
            var v = OwnAttr(ORIGIN_AGGREGATE_ATTR_AGG);
            return v is string s ? s : null;
        }
    }

    /// <summary>The dotted-path target of the aggregate (e.g. <c>"Week.id"</c>).</summary>
    public string? Of
    {
        get
        {
            var v = OwnAttr(ORIGIN_AGGREGATE_ATTR_OF);
            return v is string s ? s : null;
        }
    }

    /// <summary>The dotted relationship path the aggregate walks (e.g. <c>"Program.weeks"</c>).</summary>
    public string? Via
    {
        get
        {
            var v = OwnAttr(ORIGIN_AGGREGATE_ATTR_VIA);
            return v is string s ? s : null;
        }
    }
}

/// <summary>
/// Collection origin — the (array) field's value is a relationship-derived array
/// of nested view-objects (FR-004 R4). Carries <c>@via</c> (required): the dotted
/// relationship path the collection walks (e.g. <c>"Author.posts"</c>), or a
/// wildcard-prefixed selector for a package-spanning collection (e.g. <c>"*.User"</c>).
/// </summary>
public class MetaCollectionOrigin(TypeId typeId, string name) : MetaOrigin(typeId, name)
{
    /// <summary>The dotted relationship path (or wildcard selector) this collection is sourced from.</summary>
    public string? Via
    {
        get
        {
            var v = OwnAttr(ORIGIN_COLLECTION_ATTR_VIA);
            return v is string s ? s : null;
        }
    }
}
