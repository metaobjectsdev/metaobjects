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
/// </summary>
public static class OriginConstants
{
    public const string ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough";
    public const string ORIGIN_SUBTYPE_AGGREGATE   = "aggregate";

    public static readonly string[] ORIGIN_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        ORIGIN_SUBTYPE_PASSTHROUGH,
        ORIGIN_SUBTYPE_AGGREGATE,
    ];

    // passthrough attrs
    public const string ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
    public const string ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";

    // aggregate attrs
    public const string ORIGIN_AGGREGATE_ATTR_AGG = "agg";
    public const string ORIGIN_AGGREGATE_ATTR_OF  = "of";
    public const string ORIGIN_AGGREGATE_ATTR_VIA = "via";

    // aggregate function vocabulary
    public static readonly string[] AGGREGATE_FUNCTIONS = ["count", "sum", "avg", "min", "max"];
}
