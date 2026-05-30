namespace MetaObjects.Render.Recover;

/// <summary>
/// Engine return value.
/// <see cref="Data"/> is a forgiving string-keyed map (values may be null where fields were lost/malformed).
/// A typed <see cref="RecoveryResult{T}"/> wraps this for generated strongly-typed callers.
/// </summary>
public sealed record RecoverOutcome(
    IReadOnlyDictionary<string, object?> Data,
    RecoveryReport Report);
