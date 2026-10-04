// Free accessors over an `object.report` node (FR-044). Used by the Plan 2 lowering and
// by the loader's report validation, so the `name:grain` parse and the derived-field-name
// rule have exactly one definition.
//
// Ported 1:1 from
// server/typescript/packages/metadata/src/core/reporting/report-accessors.ts.

using MetaObjects.Meta;

namespace MetaObjects.Core.Reporting;

/// <summary>One <c>@dimensions</c> item of a report: <c>name</c> or <c>name:grain</c>.</summary>
public sealed record ReportDimensionItem(string Name, string? Grain = null);

/// <summary>Value helpers shared by the reporting node classes and accessors.</summary>
internal static class ReportingValues
{
    /// <summary>
    /// A string-list attr value: a list keeps its string elements, a bare string is a
    /// one-element list, anything else is empty. Mirrors the TS <c>stringList</c> helper.
    /// </summary>
    public static IReadOnlyList<string> StringList(object? v) => v switch
    {
        string s => new[] { s },
        IEnumerable<object?> items => items.OfType<string>().ToList().AsReadOnly(),
        _ => Array.Empty<string>(),
    };
}

/// <summary>Accessors over an <c>object.report</c> node.</summary>
// ADR-0039: every read below uses the RESOLVING Attr() accessor — a report that `extends`
// an abstract report inherits its @from / @dimensions / @measures.
public static class ReportAccessors
{
    /// <summary>The <c>@from</c> entity name of a report.</summary>
    public static string? ReportFrom(MetaData obj) => obj.Attr(OBJECT_REPORT_ATTR_FROM) as string;

    /// <summary>The <c>@dimensions</c> items, each <c>name</c> or <c>name:grain</c> (split at the first <c>:</c>).</summary>
    public static IReadOnlyList<ReportDimensionItem> ReportDimensionItems(MetaData obj) =>
        ReportingValues.StringList(obj.Attr(OBJECT_REPORT_ATTR_DIMENSIONS))
            .Select(raw =>
            {
                int i = raw.IndexOf(REPORT_DIMENSION_GRAIN_SEPARATOR, StringComparison.Ordinal);
                return i == -1
                    ? new ReportDimensionItem(raw)
                    : new ReportDimensionItem(raw[..i], raw[(i + REPORT_DIMENSION_GRAIN_SEPARATOR.Length)..]);
            })
            .ToList()
            .AsReadOnly();

    /// <summary>The <c>@measures</c> names.</summary>
    public static IReadOnlyList<string> ReportMeasureNames(MetaData obj) =>
        ReportingValues.StringList(obj.Attr(OBJECT_REPORT_ATTR_MEASURES));

    /// <summary>
    /// The derived report field for a dimension item: <c>name</c> (attribute) or
    /// <c>name</c> + Capitalized(grain) (time), e.g. <c>purchasedAt:day</c> → <c>purchasedAtDay</c>.
    /// </summary>
    public static string ReportDerivedFieldName(ReportDimensionItem item)
    {
        if (string.IsNullOrEmpty(item.Grain)) return item.Name;
        return item.Name + char.ToUpperInvariant(item.Grain[0]) + item.Grain[1..];
    }
}
