// FilterValueFormat — the well-formedness checks for filter values, keyed by the wire format a
// field's values take (docs/features/api-contract.md, "Type encodings"), and the UTC spelling of
// a timestamp bound. The list query parser runs these before a value reaches SQL, so a malformed
// value is a 400 naming the format rather than a driver error or a silent empty result.
//
// A port of runtime-ts's filter-value-format.ts; the `expected` strings are the cross-port wire
// text and must stay byte-identical to it.

#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace MetaObjects.AspNetCore;

/// <summary>Format checks, their <c>expected</c> text, and the UTC normalization of timestamp bounds.</summary>
public static class FilterValueFormat
{
    private static readonly Regex DateRe = new(@"^(\d{4})-(\d{2})-(\d{2})$", RegexOptions.CultureInvariant);
    private static readonly Regex TimeRe = new(@"^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$", RegexOptions.CultureInvariant);
    // Date, then optionally a `T`/space time, then optionally `Z` or a ±HH[:]MM offset.
    private static readonly Regex TimestampRe = new(
        @"^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?)(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex UuidRe = new(@"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex TimestampPartsRe = new(
        @"^(\d{4}-\d{2}-\d{2})(?:[Tt ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-]\d{2}):?(\d{2})?)?)?$",
        RegexOptions.CultureInvariant);
    private static readonly Regex CanonicalUtcRe = new(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$", RegexOptions.CultureInvariant);
    private static readonly Regex SpaceForPlusOffsetRe = new(
        @"^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)? \d{2}(?::?\d{2})?$", RegexOptions.CultureInvariant);

    /// <summary>The <c>expected</c> member of the <c>invalid_filter_value</c> body, per format.</summary>
    public static readonly IReadOnlyDictionary<string, string> Expected = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [FilterValueFormats.Date] = "date (YYYY-MM-DD)",
        [FilterValueFormats.Time] = "time (HH:MM[:SS[.fff]])",
        [FilterValueFormats.Timestamp] = "timestamp (YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM])",
        [FilterValueFormats.Uuid] = "uuid (8-4-4-4-12 hex)",
        [FilterValueFormats.Decimal] = "decimal number (digits, optional fraction, optional exponent)",
        [FilterValueFormats.Duration] = "duration (ISO 8601, e.g. PT1H30M; no years or months)",
    };

    /// <summary><c>expected</c> for a temporal rule that does not say which temporal format it is.</summary>
    public const string AnyTemporalExpected = "date, time or timestamp (ISO 8601)";

    /// <summary>The <c>hint</c> for a timestamp bound that fails only because its <c>+</c> offset was not encoded.</summary>
    public const string PlusOffsetHint =
        "a \"+\" in a query string decodes to a space: URL-encode the offset's \"+\" as %2B, or use Z for UTC";

    /// <summary>Whether <paramref name="s"/> is a value of <paramref name="format"/>.</summary>
    public static bool Matches(string format, string s) => format switch
    {
        FilterValueFormats.Date => IsCalendarDate(s),
        FilterValueFormats.Time => TimeRe.IsMatch(s),
        FilterValueFormats.Timestamp => IsTimestamp(s),
        FilterValueFormats.Uuid => UuidRe.IsMatch(s),
        FilterValueFormats.Decimal => DecimalWire.TryParse(s, out _),
        FilterValueFormats.Duration => DurationWire.TryParse(s, out _),
        _ => throw new ArgumentException("unknown filter value format: " + format, nameof(format)),
    };

    /// <summary>For a datetime rule with no format: any of date, time or timestamp.</summary>
    public static bool MatchesAnyTemporal(string s) => IsCalendarDate(s) || TimeRe.IsMatch(s) || IsTimestamp(s);

    /// <summary>A timestamp bound whose <c>+</c> offset arrived as a space (an unencoded <c>+</c>).</summary>
    public static bool LooksLikeUnencodedPlusOffset(string s) => SpaceForPlusOffsetRe.IsMatch(s);

    /// <summary>A zoned timestamp bound in UTC; a naive or date-only one unchanged (a wall clock).</summary>
    public static string UtcIfZoned(string s) => UtcIso(s, zonelessIsUtc: false);

    /// <summary>
    /// A <c>field.timestamp</c> instant bound in UTC: a zoned value at its instant, a zoneless one
    /// read as UTC, a date alone as midnight UTC.
    /// </summary>
    public static string UtcInstant(string s) => UtcIso(s, zonelessIsUtc: true);

    private static bool IsCalendarDate(string s)
    {
        var m = DateRe.Match(s);
        if (!m.Success) return false;
        int y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        int mo = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        int d = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
        return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= DateTime.DaysInMonth(y, mo);
    }

    private static bool IsTimestamp(string s)
    {
        var m = TimestampRe.Match(s);
        return m.Success && IsCalendarDate(m.Groups[1].Value);
    }

    // The canonical UTC spelling `YYYY-MM-DDTHH:MM:SS[.fff]Z`: millisecond resolution, no trailing
    // zeros, no fraction when it is zero. A value already spelled that way is returned as sent.
    private static string UtcIso(string s, bool zonelessIsUtc)
    {
        if (CanonicalUtcRe.IsMatch(s)) return s;
        var m = TimestampPartsRe.Match(s);
        if (!m.Success) return s;
        var date = m.Groups[1].Value;
        var hm = m.Groups[2].Success ? m.Groups[2].Value : "00:00";
        var sec = m.Groups[3].Success ? m.Groups[3].Value : "00";
        var frac = m.Groups[4].Success ? m.Groups[4].Value : "";
        bool zoned = m.Groups[5].Success || m.Groups[6].Success;
        if (!zoned && !zonelessIsUtc) return s;
        var ms = (frac.Length > 3 ? frac.Substring(0, 3) : frac).PadRight(3, '0');
        var offset = m.Groups[6].Success ? $"{m.Groups[6].Value}:{(m.Groups[7].Success ? m.Groups[7].Value : "00")}" : "+00:00";
        if (!DateTimeOffset.TryParseExact($"{date}T{hm}:{sec}.{ms}{offset}", "yyyy-MM-dd'T'HH:mm:ss.fffzzz",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var instant))
            return s;
        var utc = instant.UtcDateTime;
        var text = utc.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);
        if (utc.Millisecond != 0)
            text += "." + utc.Millisecond.ToString("000", CultureInfo.InvariantCulture).TrimEnd('0');
        return text + "Z";
    }
}
