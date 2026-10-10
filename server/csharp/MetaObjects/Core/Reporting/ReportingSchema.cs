// Reporting attribute schemas — the per-subtype attr sets for dimension.*, measure.* and
// segment.*, plus the object.report attrs (FR-044).
//
// Colocated per ADR-0003. Mirrors the canonical spec/metamodel/reporting.json and the
// object.report block of spec/metamodel/object.json (which this port embeds + reads):
// DESCRIPTIONS are deliberately NOT hand-copied here — FR-033 sources every description
// from the shared JSON via Registry.ApplySpecDescriptions. Only the facets the manifest
// needs but the description pass does not carry (value type / array-ness / requiredness /
// allowedValues) are declared here.

using MetaObjects.Core.Attr;
using MetaObjects.Core.Object;

namespace MetaObjects.Core.Reporting;

/// <summary>Attribute schemas for the reporting concern.</summary>
public static class ReportingSchema
{
    private static AttrSchema Str(string name, bool required, bool isArray = false,
        IReadOnlyList<object>? allowedValues = null) =>
        new(Name: name, ValueType: AttrConstants.ATTR_SUBTYPE_STRING, Required: required,
            AllowedValues: allowedValues, IsArray: isArray);

    private static AttrSchema Filter(string name, bool required) =>
        new(Name: name, ValueType: AttrConstants.ATTR_SUBTYPE_FILTER, Required: required);

    /// <summary>@default on measure.aggregate and measure.ratio — an optional integer (FR-044 Table A).</summary>
    private static AttrSchema MeasureDefault() =>
        new(Name: ReportingConstants.REPORTING_ATTR_DEFAULT, ValueType: AttrConstants.ATTR_SUBTYPE_INT, Required: false);

    /// <summary>dimension.attribute — @of (required), @via (optional).</summary>
    private static readonly IReadOnlyList<AttrSchema> DimensionAttributeAttrs =
    [
        Str(ReportingConstants.REPORTING_ATTR_OF, required: true),
        Str(ReportingConstants.REPORTING_ATTR_VIA, required: false),
    ];

    /// <summary>dimension.time — @of, @via, and the closed @grains set (declaration order is the contract).</summary>
    private static readonly IReadOnlyList<AttrSchema> DimensionTimeAttrs =
    [
        Str(ReportingConstants.REPORTING_ATTR_OF, required: true),
        Str(ReportingConstants.REPORTING_ATTR_VIA, required: false),
        Str(ReportingConstants.REPORTING_ATTR_GRAINS, required: true, isArray: true,
            allowedValues: [.. ReportingConstants.TIME_GRAINS]),
    ];

    /// <summary>measure.aggregate — @agg (closed set), @of (isArray; a bare string is one column),
    /// @distinct, @filter, @segment, @default.</summary>
    private static readonly IReadOnlyList<AttrSchema> MeasureAggregateAttrs =
    [
        Str(ReportingConstants.REPORTING_ATTR_AGG, required: true,
            allowedValues: [.. ReportingConstants.MEASURE_AGGS]),
        Str(ReportingConstants.REPORTING_ATTR_OF, required: true, isArray: true),
        new(Name: ReportingConstants.REPORTING_ATTR_DISTINCT, ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false),
        Filter(ReportingConstants.REPORTING_ATTR_FILTER, required: false),
        Str(ReportingConstants.REPORTING_ATTR_SEGMENT, required: false),
        MeasureDefault(),
    ];

    /// <summary>measure.ratio — @numerator, @denominator (both required), @default.</summary>
    private static readonly IReadOnlyList<AttrSchema> MeasureRatioAttrs =
    [
        Str(ReportingConstants.REPORTING_ATTR_NUMERATOR, required: true),
        Str(ReportingConstants.REPORTING_ATTR_DENOMINATOR, required: true),
        MeasureDefault(),
    ];

    /// <summary>segment.filter — the required @filter.</summary>
    private static readonly IReadOnlyList<AttrSchema> SegmentFilterAttrs =
    [
        Filter(ReportingConstants.REPORTING_ATTR_FILTER, required: true),
    ];

    /// <summary>Attrs per dimension subtype.</summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> DimensionAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [ReportingConstants.DIMENSION_SUBTYPE_ATTRIBUTE] = DimensionAttributeAttrs,
            [ReportingConstants.DIMENSION_SUBTYPE_TIME] = DimensionTimeAttrs,
        };

    /// <summary>Attrs per measure subtype.</summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> MeasureAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [ReportingConstants.MEASURE_SUBTYPE_AGGREGATE] = MeasureAggregateAttrs,
            [ReportingConstants.MEASURE_SUBTYPE_RATIO] = MeasureRatioAttrs,
        };

    /// <summary>Attrs per segment subtype.</summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> SegmentAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [ReportingConstants.SEGMENT_SUBTYPE_FILTER] = SegmentFilterAttrs,
        };

    /// <summary>object.report — @from, @dimensions, @measures, @segment, @filter, @spine.</summary>
    public static readonly IReadOnlyList<AttrSchema> ReportAttrs =
    [
        Str(ObjectConstants.OBJECT_REPORT_ATTR_FROM, required: true),
        Str(ObjectConstants.OBJECT_REPORT_ATTR_DIMENSIONS, required: false, isArray: true),
        Str(ObjectConstants.OBJECT_REPORT_ATTR_MEASURES, required: true, isArray: true),
        Str(ObjectConstants.OBJECT_REPORT_ATTR_SEGMENT, required: false),
        Filter(ObjectConstants.OBJECT_REPORT_ATTR_FILTER, required: false),
        Str(ObjectConstants.OBJECT_REPORT_ATTR_SPINE, required: false),
    ];
}
