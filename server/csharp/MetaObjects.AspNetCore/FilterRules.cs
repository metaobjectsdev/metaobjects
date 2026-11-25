// FilterRules — the per-field data a generated <Entity>FilterAllowlist carries, which the list
// query parser (ListQueryParser) reads to accept or refuse a filter, a sort and a search.
//
// The shape mirrors runtime-ts's FilterFieldRule / SortFieldRule
// (server/typescript/packages/runtime-ts/src/drizzle-fastify/filter-allowlist.ts), so the same
// metadata derives the same allowlist in both ports and the shared parse cases
// (fixtures/list-query-conformance/) hold both to it.

#nullable enable
using System.Collections.Generic;

namespace MetaObjects.AspNetCore;

/// <summary>The coarse kind of a filter value: how a query-string operand is typed.</summary>
public enum FilterValueKind
{
    /// <summary>Text, an enum member, a uuid, a duration: kept as the string sent.</summary>
    String,
    /// <summary>int, long, double, float, decimal, currency.</summary>
    Number,
    /// <summary><c>true</c>/<c>1</c>/<c>false</c>/<c>0</c>.</summary>
    Boolean,
    /// <summary>date, time, timestamp.</summary>
    Datetime,
}

/// <summary>
/// The exact wire formats a filter value is checked against, beyond <see cref="FilterValueKind"/>.
/// Each value IS the <c>field.*</c> subtype name whose wire encoding the value must match.
/// </summary>
public static class FilterValueFormats
{
    public const string Date = "date";
    public const string Time = "time";
    public const string Timestamp = "timestamp";
    public const string Uuid = "uuid";
    public const string Decimal = "decimal";
    public const string Duration = "duration";
}

/// <summary>One filterable field's rule: its operators, its value kind and the checks on its values.</summary>
public sealed class FilterFieldRule
{
    public FilterFieldRule(FilterValueKind kind, params string[] ops)
    {
        Kind = kind;
        Ops = ops;
    }

    /// <summary>The operators the field takes (its band, <c>QueryConstants.OpsForField</c>).</summary>
    public IReadOnlyList<string> Ops { get; }

    /// <summary>How an operand is typed.</summary>
    public FilterValueKind Kind { get; }

    /// <summary>One of <see cref="FilterValueFormats"/>, for date/time/timestamp/uuid/decimal/duration fields.</summary>
    public string? Format { get; init; }

    /// <summary>
    /// A <c>field.timestamp</c> that is an instant (not <c>@localTime</c>): a zoneless bound is read
    /// as UTC and a date alone as midnight UTC, the rule the write path stores such a value by.
    /// </summary>
    public bool Instant { get; init; }

    /// <summary>int, long, currency: a bound that is not a whole number is refused.</summary>
    public bool Integer { get; init; }

    /// <summary>The declared members of a <c>field.enum</c>; a value that is not one is refused.</summary>
    public IReadOnlyList<string>? EnumValues { get; init; }

    /// <summary>Whether a <c>like</c> pattern may start with <c>%</c>. Always false in generated rules.</summary>
    public bool LeadingWildcard { get; init; }
}

/// <summary>One sortable field's rule.</summary>
public sealed class SortFieldRule
{
    public SortFieldRule(string? defaultOrder = null, string? property = null)
    {
        DefaultOrder = defaultOrder;
        Property = property;
    }

    /// <summary>The DECLARED <c>@sortableDefaultOrder</c> (<c>asc</c>/<c>desc</c>), or null for none.</summary>
    public string? DefaultOrder { get; }

    /// <summary>The CLR property a generated route sorts on, or null when the caller resolves it.</summary>
    public string? Property { get; }
}
