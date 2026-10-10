// Reporting concern constants (FR-044) — subtypes, attr keys and the closed sets the
// registry enforces through `allowedValues`.
//
// Colocated per ADR-0003. Mirrors
// server/typescript/packages/metadata/src/core/reporting/reporting-constants.ts.
//
// `dimension`, `measure` and `segment` are children of `object.entity` only (never
// root-level), and `object.report` (see ObjectConstants) references them by name. The
// type-name constants live in Shared/BaseTypes.cs beside every other base type.

using System.Text.RegularExpressions;

namespace MetaObjects.Core.Reporting;

/// <summary>
/// Reporting concern constants — the dimension / measure / segment subtypes, their attr
/// keys, the closed grain and aggregate sets, and the relative-date filter value.
/// </summary>
public static class ReportingConstants
{
    // -----------------------------------------------------------------------
    // Subtypes
    // -----------------------------------------------------------------------

    /// <summary>Groups by a column value as-is (no grain, no truncation).</summary>
    public const string DIMENSION_SUBTYPE_ATTRIBUTE = "attribute";

    /// <summary>Groups by a date/timestamp column truncated to a grain.</summary>
    public const string DIMENSION_SUBTYPE_TIME = "time";

    public static readonly string[] DIMENSION_SUBTYPES = [DIMENSION_SUBTYPE_ATTRIBUTE, DIMENSION_SUBTYPE_TIME];

    /// <summary>One aggregate over the declaring entity's own rows.</summary>
    public const string MEASURE_SUBTYPE_AGGREGATE = "aggregate";

    /// <summary>
    /// A quotient of two <c>measure.aggregate</c> siblings, <c>numerator / NULLIF(denominator, 0)</c>.
    /// <c>measure.derived</c> is deliberately NOT registered: it waits for FR-037 R5.
    /// </summary>
    public const string MEASURE_SUBTYPE_RATIO = "ratio";

    public static readonly string[] MEASURE_SUBTYPES = [MEASURE_SUBTYPE_AGGREGATE, MEASURE_SUBTYPE_RATIO];

    /// <summary>
    /// A named, reusable row filter. The only concrete segment subtype: every <c>*.base</c>
    /// in the registry is an abstract anchor, so authors write <c>segment.filter</c>.
    /// </summary>
    public const string SEGMENT_SUBTYPE_FILTER = "filter";

    public static readonly string[] SEGMENT_SUBTYPES = [SEGMENT_SUBTYPE_FILTER];

    // -----------------------------------------------------------------------
    // Attrs (on dimension / measure / segment nodes)
    // -----------------------------------------------------------------------

    /// <summary>Dotted <c>Entity.field</c> reference(s) naming the grouped / aggregated column(s).</summary>
    public const string REPORTING_ATTR_OF = "of";

    /// <summary>Optional dotted to-one relationship path from the owning entity to the <c>@of</c> entity.</summary>
    public const string REPORTING_ATTR_VIA = "via";

    /// <summary>The grains a <c>dimension.time</c> supports.</summary>
    public const string REPORTING_ATTR_GRAINS = "grains";

    /// <summary>The aggregate function of a <c>measure.aggregate</c>.</summary>
    public const string REPORTING_ATTR_AGG = "agg";

    /// <summary>Count distinct values (legal only with <c>@agg: count</c>).</summary>
    public const string REPORTING_ATTR_DISTINCT = "distinct";

    /// <summary>Row scope (an attr.filter) on a <c>measure.aggregate</c> or <c>segment.filter</c>.</summary>
    public const string REPORTING_ATTR_FILTER = "filter";

    /// <summary>Name of a segment declared on the same entity.</summary>
    public const string REPORTING_ATTR_SEGMENT = "segment";

    /// <summary><c>measure.ratio</c> operand names.</summary>
    public const string REPORTING_ATTR_NUMERATOR = "numerator";

    public const string REPORTING_ATTR_DENOMINATOR = "denominator";

    /// <summary>Integer a measure reads when it would otherwise be null (<c>measure.aggregate</c> / <c>measure.ratio</c>).</summary>
    public const string REPORTING_ATTR_DEFAULT = "default";

    // -----------------------------------------------------------------------
    // Closed sets — mirrored by `allowedValues` in spec/metamodel/reporting.json.
    // Order is part of the contract (it is the order the registry manifest records).
    // -----------------------------------------------------------------------

    /// <summary>Weeks start on Monday (ISO-8601) in every lowering.</summary>
    public const string GRAIN_HOUR = "hour";
    public const string GRAIN_DAY = "day";
    public const string GRAIN_WEEK = "week";
    public const string GRAIN_MONTH = "month";
    public const string GRAIN_QUARTER = "quarter";
    public const string GRAIN_YEAR = "year";

    public static readonly string[] TIME_GRAINS =
        [GRAIN_HOUR, GRAIN_DAY, GRAIN_WEEK, GRAIN_MONTH, GRAIN_QUARTER, GRAIN_YEAR];

    public const string AGG_COUNT = "count";
    public const string AGG_SUM = "sum";
    public const string AGG_AVG = "avg";
    public const string AGG_MIN = "min";
    public const string AGG_MAX = "max";

    public static readonly string[] MEASURE_AGGS = [AGG_COUNT, AGG_SUM, AGG_AVG, AGG_MIN, AGG_MAX];

    /// <summary>Separator in an <c>object.report</c> <c>@dimensions</c> item: <c>name</c> or <c>name:grain</c>.</summary>
    public const string REPORT_DIMENSION_GRAIN_SEPARATOR = ":";

    // -----------------------------------------------------------------------
    // Relative-date filter values (spec §4 R4; rules F1/F2)
    // -----------------------------------------------------------------------

    /// <summary>
    /// The single key of a relative-date filter value: <c>{ now: "&lt;ISO-8601 duration&gt;" }</c>
    /// means "the current time plus that duration", evaluated when the view is queried.
    /// Legal only in the <c>@filter</c> of a <c>segment</c>, <c>measure.aggregate</c> or
    /// <c>object.report</c>.
    /// </summary>
    public const string FILTER_RELATIVE_NOW = "now";

    /// <summary>
    /// A signed ISO-8601 duration (<c>-P7D</c>, <c>P1Y2M</c>, <c>-PT12H</c>). The lookaheads
    /// refuse the degenerate <c>P</c> and <c>PT</c> forms (a designator with no component).
    /// The TS reference pattern, translated for .NET semantics: <c>[0-9]</c> rather than
    /// <c>\d</c> (which matches every Unicode digit in .NET) and <c>\z</c> rather than
    /// <c>$</c> (which also matches before a trailing newline in .NET).
    /// </summary>
    public static readonly Regex ISO_DURATION_RE = new(
        @"^[+-]?P(?!\z)([0-9]+Y)?([0-9]+M)?([0-9]+W)?([0-9]+D)?(T(?=[0-9])([0-9]+H)?([0-9]+M)?([0-9]+S)?)?\z",
        RegexOptions.CultureInvariant);
}
