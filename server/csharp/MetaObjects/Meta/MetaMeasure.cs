// MetaMeasure — concrete node class for type=measure nodes (FR-044).
//
// Ported 1:1 from
// server/typescript/packages/metadata/src/core/reporting/meta-measure.ts.

using MetaObjects.Core.Reporting;

namespace MetaObjects.Meta;

/// <summary>
/// Concrete node class for <c>measure.*</c> nodes. Extends <see cref="MetaData"/> directly.
/// </summary>
// ADR-0039: every getter below uses the RESOLVING Attr() accessor.
public class MetaMeasure(TypeId typeId, string name) : MetaData(typeId, name)
{
    /// <summary>True for <c>measure.ratio</c>; false for <c>measure.aggregate</c>.</summary>
    public bool IsRatio() => SubType == MEASURE_SUBTYPE_RATIO;

    /// <summary>The aggregate function (<c>measure.aggregate</c> only); null outside the closed set.</summary>
    public string? Agg() =>
        Attr(REPORTING_ATTR_AGG) is string s && MEASURE_AGGS.Contains(s) ? s : null;

    /// <summary>True when <c>@distinct</c> is set (legal only with <c>@agg: count</c>).</summary>
    public bool Distinct() => Attr(REPORTING_ATTR_DISTINCT) is true;

    /// <summary>
    /// The <c>Entity.field</c> references in <c>@of</c>: a bare string is one column, a list
    /// is the tuple form.
    /// </summary>
    public IReadOnlyList<string> OfColumns() => ReportingValues.StringList(Attr(REPORTING_ATTR_OF));

    /// <summary>Name of a segment declared on the same entity; combines with <c>@filter</c> by AND.</summary>
    public string? SegmentName() => Attr(REPORTING_ATTR_SEGMENT) as string;

    /// <summary>The canonical row-scope filter, when one is declared.</summary>
    public IReadOnlyDictionary<string, object?>? Filter() =>
        Attr(REPORTING_ATTR_FILTER) as IReadOnlyDictionary<string, object?>;

    /// <summary>
    /// <c>@default</c>: the integer this measure reads when it would otherwise be null (rules
    /// M7/M8 decide where it is legal). Null when none is declared or the value is not an
    /// integer. ADR-0039: resolving, so an inherited measure keeps it.
    /// </summary>
    public long? DefaultValue() => Attr(REPORTING_ATTR_DEFAULT) switch
    {
        long l => l,
        int i => i,
        // A JSON number written with a fraction part (`0.0`) parses as a double; TypeScript
        // reads the same text as the integer 0.
        double d when double.IsFinite(d) && d == Math.Floor(d) && Math.Abs(d) <= 9007199254740991d => (long)d,
        _ => null,
    };

    /// <summary>Name of the <c>measure.aggregate</c> sibling used as the numerator (<c>measure.ratio</c> only).</summary>
    public string? Numerator() => Attr(REPORTING_ATTR_NUMERATOR) as string;

    /// <summary>Name of the <c>measure.aggregate</c> sibling used as the denominator (<c>measure.ratio</c> only).</summary>
    public string? Denominator() => Attr(REPORTING_ATTR_DENOMINATOR) as string;
}
