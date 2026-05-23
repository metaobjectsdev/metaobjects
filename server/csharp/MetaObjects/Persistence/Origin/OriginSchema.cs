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
    ];

    private static readonly IReadOnlyList<AttrSchema> AggregateOriginAttrs =
    [
        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_AGG,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            AllowedValues: [.. OriginConstants.AGGREGATE_FUNCTIONS],
            Description: "Aggregate function applied over the relationship path: count, sum, avg, min, or max."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_OF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes')."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_VIA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts')."),
    ];

    /// <summary>
    /// Attrs per origin subtype. base has none; passthrough and aggregate carry
    /// their respective attrs.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> OriginAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [BaseTypes.SUBTYPE_BASE]                       = [],
            [OriginConstants.ORIGIN_SUBTYPE_PASSTHROUGH]   = [.. PassthroughOriginAttrs],
            [OriginConstants.ORIGIN_SUBTYPE_AGGREGATE]     = [.. AggregateOriginAttrs],
        };
}
