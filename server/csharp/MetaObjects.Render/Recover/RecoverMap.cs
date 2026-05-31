using System.Globalization;

namespace MetaObjects.Render.Recover;

/// <summary>
/// Null-safe coercions from a <see cref="RecoverOutcome"/> data map onto typed record components.
/// Generated recover(…) calls use these helpers.
/// </summary>
public static class RecoverMap
{
    /// <summary>
    /// Returns the string value for key <paramref name="k"/>, coercing non-strings via invariant-culture
    /// <see cref="Convert.ToString(object, IFormatProvider)"/>. Returns <c>null</c> when the key is absent.
    /// </summary>
    /// <remarks>
    /// Mirrors Java <c>String.valueOf</c>: locale-independent. The generated path only calls this on
    /// string-typed fields (value already a string), so the numeric fallback is defensive.
    /// </remarks>
    public static string? AsString(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v switch
        {
            null => null,
            string s => s,
            _ => Convert.ToString(v, CultureInfo.InvariantCulture),
        };
    }

    /// <summary>
    /// Returns the value narrowed to <see cref="int"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a number.
    /// </summary>
    /// <remarks>
    /// Mirrors Java <c>Number.intValue()</c>: gates on actual numeric types (never throws on a string/bool,
    /// unlike <see cref="Convert"/>) and truncates floating values toward zero.
    /// </remarks>
    public static int? AsInt(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v switch
        {
            long l => (int)l,
            int i => i,
            double db => (int)db,
            float f => (int)f,
            decimal m => (int)m,
            short s => s,
            byte b => b,
            _ => null,
        };
    }

    /// <summary>
    /// Returns the value as <see cref="long"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a number.
    /// </summary>
    /// <remarks>Mirrors Java <c>Number.longValue()</c>: numeric-typed, never throws, truncates toward zero.</remarks>
    public static long? AsLong(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v switch
        {
            long l => l,
            int i => i,
            double db => (long)db,
            float f => (long)f,
            decimal m => (long)m,
            short s => s,
            byte b => b,
            _ => null,
        };
    }

    /// <summary>
    /// Returns the value as <see cref="double"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a number.
    /// </summary>
    /// <remarks>Mirrors Java <c>Number.doubleValue()</c>: numeric-typed, never throws.</remarks>
    public static double? AsDouble(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v switch
        {
            long l => l,
            int i => i,
            double db => db,
            float f => f,
            decimal m => (double)m,
            short s => s,
            byte b => b,
            _ => null,
        };
    }

    /// <summary>
    /// Returns the value as <see cref="decimal"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a number.
    /// </summary>
    /// <remarks>
    /// The engine coerces a <see cref="FieldKind.Decimal"/> field to a boxed
    /// <see cref="decimal"/> (precision-exact). Integer kinds widen losslessly; a boxed
    /// <see cref="double"/>/<see cref="float"/> is converted (lossy by nature of the source),
    /// preserving the never-throws contract.
    /// </remarks>
    public static decimal? AsDecimal(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v switch
        {
            decimal m => m,
            long l => l,
            int i => i,
            short s => s,
            byte b => b,
            double db => (decimal)db,
            float f => (decimal)f,
            _ => null,
        };
    }

    /// <summary>
    /// Returns the value as <see cref="bool"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a <see cref="bool"/>.
    /// </summary>
    public static bool? AsBool(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v is bool b ? b : null;
    }

    /// <summary>
    /// Returns the value as a <see cref="IReadOnlyList{String}"/> for key <paramref name="k"/>,
    /// coercing each element to string. Returns <c>null</c> when the key is absent or the value
    /// is not a list.
    /// </summary>
    public static IReadOnlyList<string?>? AsStringList(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        if (v is not List<object?> list) return null;
        var out_ = new List<string?>(list.Count);
        foreach (object? e in list)
            out_.Add(e == null ? null : Convert.ToString(e, CultureInfo.InvariantCulture));
        return out_.AsReadOnly();
    }
}
