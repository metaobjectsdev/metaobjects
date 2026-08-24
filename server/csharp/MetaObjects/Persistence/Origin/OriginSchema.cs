// Origin attribute schemas — attrs per origin subtype.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/origin/origin-schema.ts.

using MetaObjects.Core.Attr;
using MetaObjects.Shared;

namespace MetaObjects.Persistence.Origin;

/// <summary>Attribute schemas for the origin concern.</summary>
public static class OriginSchema
{
    private static readonly IReadOnlyList<AttrSchema> PassthroughOriginAttrs =
    [
        new AttrSchema(
            Name: OriginConstants.ORIGIN_PASSTHROUGH_ATTR_FROM,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted Entity.field reference identifying the source value this projection field passes through (e.g. 'Program.title')."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_PASSTHROUGH_ATTR_VIA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Optional dotted relationship path used to reach the source entity (e.g. 'Program.weeks')."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_PASSTHROUGH_ATTR_CONVERT,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "Acknowledges that this field's declared type deliberately differs from its @from source field's type (#185). Absent/false (the default), a passthrough is type-preserving — a differing field.<subType> or array-ness fails with ERR_PASSTHROUGH_TYPE_MISMATCH. Set true to opt out. This is an acknowledgement only: it does NOT generate a cast — the value flows through unchanged and the consumer owns any coercion. Real type-converting projections are origin.expression's job (#159)."),
    ];

    private static readonly IReadOnlyList<AttrSchema> AggregateOriginAttrs =
    [
        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_AGG,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            // #195 — the full @agg vocabulary (numeric reduces + any/all quantifiers + collect).
            AllowedValues: [.. OriginConstants.ORIGIN_AGG_VALUES],
            Description: "The reducing function applied over the related row-set: count/sum/avg/min/max, any/all (predicate quantifiers over @filter), or collect (array rollup — of the @of column, or of the carrying field.object's declared @objectRef value object when @of is omitted)."),

        // #195 — @of relaxed to optional (any/all forbid it, the rest require it);
        // presence is enforced per-@agg in the origin-path validation pass.
        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_OF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes'). Required for count/sum/avg/min/max; OPTIONAL for collect, where absent means a whole-object rollup of the field's declared @objectRef value object; forbidden for any/all."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_VIA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029)."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_FILTER,
            ValueType: AttrConstants.ATTR_SUBTYPE_FILTER,
            Required: false,
            Description: "Optional structured predicate scoping which related rows the aggregate spans (required for any/all)."),

        // #195 — @distinct (collect set-semantics) + @orderBy (element order).
        new AttrSchema(
            Name: OriginConstants.ORIGIN_ATTR_DISTINCT,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "Set (collect-only) to dedupe collected values (set semantics). Not supported on a whole-object collect (@of omitted): it is a guaranteed no-op whenever the value object carries the primary key."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_ATTR_ORDER_BY,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            IsArray: true,
            Description: "Ordering keys as 'field[:asc|desc]' over the related entity's fields; nulls sort last. On @agg:collect sets element order (non-distinct only)."),
    ];

    // #195 — computed: a row-level value via a structured @expr tree (attr.expression).
    private static readonly IReadOnlyList<AttrSchema> ComputedOriginAttrs =
    [
        new AttrSchema(
            Name: OriginConstants.ORIGIN_COMPUTED_ATTR_EXPR,
            ValueType: AttrConstants.ATTR_SUBTYPE_EXPRESSION,
            Required: true,
            Description: "The structured expression tree computing this field's value from the base entity's own fields. Its inferred root type must equal the field's declared subType (ERR_COMPUTED_TYPE_MISMATCH)."),
    ];

    // #195 — first: the single related row picked by @orderBy along @via, projecting @of.
    private static readonly IReadOnlyList<AttrSchema> FirstOriginAttrs =
    [
        new AttrSchema(
            Name: OriginConstants.ORIGIN_FIRST_ATTR_OF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted Entity.field reference identifying the column projected from the selected row (e.g. 'ChildA.label'). Type-preserving (#185 doctrine)."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_FIRST_ATTR_VIA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Dotted relationship path from the base entity to the related rows (e.g. 'Parent.childAs'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029)."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_ATTR_ORDER_BY,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            IsArray: true,
            Description: "Ordering keys as 'field[:asc|desc]' over the related entity's fields; nulls sort last. Selects the single row; the related PK ascending is appended as the deterministic tie-breaker."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_FIRST_ATTR_FILTER,
            ValueType: AttrConstants.ATTR_SUBTYPE_FILTER,
            Required: false,
            Description: "Optional structured predicate scoping which related rows are eligible for selection."),
    ];

    /// <summary>
    /// Attrs per origin subtype. base has none; passthrough, aggregate,
    /// computed (#195), and first (#195) carry their respective attrs.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> OriginAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [BaseTypes.SUBTYPE_BASE]                       = [],
            [OriginConstants.ORIGIN_SUBTYPE_PASSTHROUGH]   = [.. PassthroughOriginAttrs],
            [OriginConstants.ORIGIN_SUBTYPE_AGGREGATE]     = [.. AggregateOriginAttrs],
            [OriginConstants.ORIGIN_SUBTYPE_COMPUTED]      = [.. ComputedOriginAttrs],
            [OriginConstants.ORIGIN_SUBTYPE_FIRST]         = [.. FirstOriginAttrs],
        };
}
