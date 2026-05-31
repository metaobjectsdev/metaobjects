namespace MetaObjects.Render.Extract;

/// <summary>
/// A recorded normalization/coercion event.
/// <paramref name="Kind"/> is a classification label, e.g. "alias", "clamp", "case", "runtime-alias-override".
/// <paramref name="From"/> and <paramref name="To"/> may be null when the transformation has no readable before/after value.
/// </summary>
public sealed record Coercion(string FieldPath, string? From, string? To, string Kind);
