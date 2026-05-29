namespace MetaObjects.Render.Recover;

/// <summary>
/// Null-safe coercions from a <see cref="RecoverOutcome"/> data map onto typed record components.
/// Generated recover(…) calls use these helpers.
/// </summary>
public static class RecoverMap
{
    /// <summary>
    /// Returns the string value for key <paramref name="k"/>, coercing non-strings via
    /// <see cref="Convert.ToString(object)"/>. Returns <c>null</c> when the key is absent.
    /// </summary>
    public static string? AsString(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v == null ? null : (v is string s ? s : Convert.ToString(v));
    }

    /// <summary>
    /// Returns the value narrowed to <see cref="int"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a <see cref="IConvertible"/> number.
    /// </summary>
    public static int? AsInt(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v is IConvertible c ? (int?)Convert.ToInt32(c) : null;
    }

    /// <summary>
    /// Returns the value as <see cref="long"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a <see cref="IConvertible"/> number.
    /// </summary>
    public static long? AsLong(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v is IConvertible c ? (long?)Convert.ToInt64(c) : null;
    }

    /// <summary>
    /// Returns the value as <see cref="double"/> for key <paramref name="k"/>.
    /// Returns <c>null</c> when the key is absent or the value is not a <see cref="IConvertible"/> number.
    /// </summary>
    public static double? AsDouble(IReadOnlyDictionary<string, object?> d, string k)
    {
        if (!d.TryGetValue(k, out object? v)) return null;
        return v is IConvertible c ? (double?)Convert.ToDouble(c) : null;
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
            out_.Add(e == null ? null : Convert.ToString(e));
        return out_.AsReadOnly();
    }
}
