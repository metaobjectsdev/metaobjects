namespace MetaObjects.Render.Extract;

/// <summary>
/// Engine return value.
/// <see cref="Data"/> is a forgiving string-keyed map (values may be null where fields were lost/malformed).
/// A typed <see cref="ExtractionResult{T}"/> wraps this for generated strongly-typed callers.
/// </summary>
public sealed record ExtractionOutcome(
    IReadOnlyDictionary<string, object?> Data,
    ExtractionReport Report);
