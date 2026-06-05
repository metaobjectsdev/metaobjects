namespace MetaObjects.Render.Extract;

/// <summary>
/// Bounded runtime override surface (the "20%").
/// <see cref="Aliases"/> and <see cref="Normalizers"/> are MERGED with the schema's,
/// runtime winning on key conflict. <see cref="OnField"/> is the single bespoke-coercion hook.
/// </summary>
public sealed record ExtractOptions(
    Tolerance Tolerance,
    IReadOnlyDictionary<string, string> Aliases,
    IReadOnlyDictionary<string, Func<string, object?>> Normalizers,
    OnField? OnField,
    bool Rootless = false)
{
    /// <summary>Default options: Normal tolerance, no aliases, no normalizers, no hook, not rootless.</summary>
    public static ExtractOptions Defaults() =>
        new(
            Tolerance.Normal,
            new Dictionary<string, string>(),
            new Dictionary<string, Func<string, object?>>(),
            null);

    /// <summary>Return a copy with a different tolerance level.</summary>
    public ExtractOptions WithTolerance(Tolerance t) =>
        this with { Tolerance = t };

    /// <summary>
    /// XML only: parse a rootless flat element sequence directly (no wrapper root). Returns a copy
    /// with <see cref="Rootless"/> set. Mirrors Java <c>ExtractOptions.withRootless</c>.
    /// </summary>
    public ExtractOptions WithRootless(bool r) =>
        this with { Rootless = r };
}
