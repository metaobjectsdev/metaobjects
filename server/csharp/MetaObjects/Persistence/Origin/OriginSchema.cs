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
            Required: false,
            Description: "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029)."),

        new AttrSchema(
            Name: OriginConstants.ORIGIN_AGGREGATE_ATTR_FILTER,
            ValueType: AttrConstants.ATTR_SUBTYPE_FILTER,
            Required: false,
            Description: "Optional structured predicate scoping which related rows the aggregate spans. A portable attr.filter object (eq/ne/in/isNull with and/or), desugared to canonical { field: { op: value } } at parse time; codegen renders it per target (e.g. SQL FILTER (WHERE ...) or SQLite CASE WHEN for a relational view)."),
    ];

    private static readonly IReadOnlyList<AttrSchema> CollectionOriginAttrs =
    [
        new AttrSchema(
            Name: OriginConstants.ORIGIN_COLLECTION_ATTR_VIA,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted relationship path the collection walks to produce an array of nested view-objects (e.g. 'Author.posts'), or a wildcard selector for a package-spanning collection (e.g. '*.User')."),
    ];

    /// <summary>
    /// Attrs per origin subtype. base has none; passthrough, aggregate, and
    /// collection carry their respective attrs.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> OriginAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [BaseTypes.SUBTYPE_BASE]                       = [],
            [OriginConstants.ORIGIN_SUBTYPE_PASSTHROUGH]   = [.. PassthroughOriginAttrs],
            [OriginConstants.ORIGIN_SUBTYPE_AGGREGATE]     = [.. AggregateOriginAttrs],
            [OriginConstants.ORIGIN_SUBTYPE_COLLECTION]    = [.. CollectionOriginAttrs],
        };
}
