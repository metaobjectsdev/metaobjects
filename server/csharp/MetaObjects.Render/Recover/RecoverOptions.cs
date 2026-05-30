namespace MetaObjects.Render.Recover;

/// <summary>
/// Bounded runtime override surface (the "20%").
/// <see cref="Aliases"/> and <see cref="Normalizers"/> are MERGED with the schema's,
/// runtime winning on key conflict. <see cref="OnField"/> is the single bespoke-coercion hook.
/// </summary>
public sealed record RecoverOptions(
    Tolerance Tolerance,
    IReadOnlyDictionary<string, string> Aliases,
    IReadOnlyDictionary<string, Func<string, object?>> Normalizers,
    OnField? OnField)
{
    /// <summary>Default options: Normal tolerance, no aliases, no normalizers, no hook.</summary>
    public static RecoverOptions Defaults() =>
        new(
            Tolerance.Normal,
            new Dictionary<string, string>(),
            new Dictionary<string, Func<string, object?>>(),
            null);

    /// <summary>Return a copy with a different tolerance level.</summary>
    public RecoverOptions WithTolerance(Tolerance t) =>
        this with { Tolerance = t };
}
