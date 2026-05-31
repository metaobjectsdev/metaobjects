// Origin concern constants — field-level provenance subtypes + attr keys.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/origin/origin-constants.ts.

using MetaObjects.Shared;

namespace MetaObjects.Persistence.Origin;

/// <summary>
/// Origin concern constants — field-level provenance (Project E). Origin is a
/// child of `field`: it says "this field's value comes from there."
///   passthrough: from &lt;Entity.field&gt; [via &lt;relationship path&gt;]
///   aggregate:   &lt;agg&gt; of &lt;Entity.field&gt; via &lt;relationship path&gt;
///   collection:  a relationship-derived array of nested view-objects (FR-004 R4)
/// </summary>
public static class OriginConstants
{
    public const string ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough";
    public const string ORIGIN_SUBTYPE_AGGREGATE   = "aggregate";
    public const string ORIGIN_SUBTYPE_COLLECTION  = "collection";

    public static readonly string[] ORIGIN_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        ORIGIN_SUBTYPE_PASSTHROUGH,
        ORIGIN_SUBTYPE_AGGREGATE,
        ORIGIN_SUBTYPE_COLLECTION,
    ];

    // passthrough attrs
    public const string ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
    public const string ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";

    // aggregate attrs
    public const string ORIGIN_AGGREGATE_ATTR_AGG = "agg";
    public const string ORIGIN_AGGREGATE_ATTR_OF  = "of";
    public const string ORIGIN_AGGREGATE_ATTR_VIA = "via";

    // collection attrs — a relationship-derived array of nested view-objects.
    // @via is the dotted relationship path (or a wildcard selector like "*.User"
    // for a package-spanning collection).
    public const string ORIGIN_COLLECTION_ATTR_VIA = "via";

    // aggregate function vocabulary
    public const string AGGREGATE_FN_COUNT = "count";
    public const string AGGREGATE_FN_SUM   = "sum";
    public const string AGGREGATE_FN_AVG   = "avg";
    public const string AGGREGATE_FN_MIN   = "min";
    public const string AGGREGATE_FN_MAX   = "max";

    public static readonly string[] AGGREGATE_FUNCTIONS =
        [AGGREGATE_FN_COUNT, AGGREGATE_FN_SUM, AGGREGATE_FN_AVG, AGGREGATE_FN_MIN, AGGREGATE_FN_MAX];
}
