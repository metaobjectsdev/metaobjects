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
///   computed:    a row-level expression over the base entity's own fields
///   first:       one related row selected by an ordering, projecting a column
/// </summary>
public static class OriginConstants
{
    public const string ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough";
    public const string ORIGIN_SUBTYPE_AGGREGATE   = "aggregate";
    // FR-037 R2 — `collection` is RESERVED, NOT REGISTERED. It duplicated
    // `origin.aggregate @agg: collect` on a strictly smaller attr set (@via only),
    // and nothing dispatched on it: its last real consumer, the payload-VO typing
    // edge, was deleted in 0.20.16 (#270) for being actively wrong. Re-entry bar
    // (ADR-0007 Amendment 2): a member enters the registry only when a shipping
    // consumer dispatches on it. The designated re-entry shape is `@agg: collect`
    // with `@of` made OPTIONAL — filed as #335 — NOT a restored subtype.
    // #195 — computed: a row-level value from the base entity's own fields via a
    // structured @expr tree. first: the single related row picked by @orderBy
    // along @via, projecting @of (argmax-then-project).
    public const string ORIGIN_SUBTYPE_COMPUTED    = "computed";
    public const string ORIGIN_SUBTYPE_FIRST       = "first";

    public static readonly string[] ORIGIN_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        ORIGIN_SUBTYPE_PASSTHROUGH,
        ORIGIN_SUBTYPE_AGGREGATE,
        ORIGIN_SUBTYPE_COMPUTED,
        ORIGIN_SUBTYPE_FIRST,
    ];

    // #210 — the ASSEMBLY origins: they derive a value by rolling up, computing,
    // or collecting from a backing store, which is what an object.projection is
    // for. They are illegal on an object.value-hosted field
    // (ERR_SUBTYPE_RULE_VIOLATION); ORIGIN_SUBTYPE_PASSTHROUGH is NOT in this
    // set — on a value it is FR-015 parameter lineage, not an assembly path
    // (ADR-0028). Mirrors the TS ASSEMBLY_ORIGIN_SUBTYPES.
    public static readonly IReadOnlySet<string> ASSEMBLY_ORIGIN_SUBTYPES = new HashSet<string>
    {
        ORIGIN_SUBTYPE_AGGREGATE,
        ORIGIN_SUBTYPE_COMPUTED,
        ORIGIN_SUBTYPE_FIRST,
    };

    // passthrough attrs
    public const string ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
    public const string ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";
    // @convert (boolean): acknowledges a deliberate type change vs the @from source
    // (#185). Suppresses ERR_PASSTHROUGH_TYPE_MISMATCH. Acknowledgement only — it
    // does NOT generate a cast; real type-converting projections are origin.expression (#159).
    public const string ORIGIN_PASSTHROUGH_ATTR_CONVERT = "convert";

    // aggregate attrs
    public const string ORIGIN_AGGREGATE_ATTR_AGG = "agg";
    public const string ORIGIN_AGGREGATE_ATTR_OF  = "of";
    public const string ORIGIN_AGGREGATE_ATTR_VIA = "via";
    // @filter (attr.filter object): an optional PORTABLE structured predicate scoping
    // the aggregated rows (same shape as a preset filter). On @agg:any|all it is the
    // QUANTIFIED predicate (required there). Codegen renders it per target -- the
    // projection view emitter turns it into SQL FILTER (WHERE ...) / CASE WHEN.
    public const string ORIGIN_AGGREGATE_ATTR_FILTER = "filter";
    // #195 — shared origin attrs. @distinct (collect-only) applies set semantics;
    // @orderBy carries ordering keys ('field[:asc|desc]', nulls-last) used by
    // @agg:collect (element order) and required by origin.first (row selection).
    public const string ORIGIN_ATTR_DISTINCT  = "distinct";
    public const string ORIGIN_ATTR_ORDER_BY  = "orderBy";

    // computed attrs — @expr is the structured expression tree (attr.expression).
    public const string ORIGIN_COMPUTED_ATTR_EXPR = "expr";

    // first attrs — reuse the same physical names as aggregate (@of/@via/@filter)
    // plus the required @orderBy above.
    public const string ORIGIN_FIRST_ATTR_OF     = "of";
    public const string ORIGIN_FIRST_ATTR_VIA    = "via";
    public const string ORIGIN_FIRST_ATTR_FILTER = "filter";

    // aggregate function vocabulary.
    //
    // AGGREGATE_FUNCTIONS is the NUMERIC/ORDINAL reduce set — each maps directly to
    // a SQL aggregate over @of. The predicate quantifiers (any/all) and the array
    // rollup (collect) are distinct reducing behaviors; the full @agg vocabulary is
    // ORIGIN_AGG_VALUES.
    public const string AGGREGATE_FN_COUNT = "count";
    public const string AGGREGATE_FN_SUM   = "sum";
    public const string AGGREGATE_FN_AVG   = "avg";
    public const string AGGREGATE_FN_MIN   = "min";
    public const string AGGREGATE_FN_MAX   = "max";

    public static readonly string[] AGGREGATE_FUNCTIONS =
        [AGGREGATE_FN_COUNT, AGGREGATE_FN_SUM, AGGREGATE_FN_AVG, AGGREGATE_FN_MIN, AGGREGATE_FN_MAX];

    // #195 — the predicate-quantifier + array-rollup @agg values.
    public const string AGG_ANY     = "any";
    public const string AGG_ALL     = "all";
    public const string AGG_COLLECT = "collect";

    /// <summary>The full @agg attribute vocabulary (matches origin.json allowedValues).</summary>
    public static readonly string[] ORIGIN_AGG_VALUES =
        [AGGREGATE_FN_COUNT, AGGREGATE_FN_SUM, AGGREGATE_FN_AVG, AGGREGATE_FN_MIN, AGGREGATE_FN_MAX,
         AGG_ANY, AGG_ALL, AGG_COLLECT];
}
