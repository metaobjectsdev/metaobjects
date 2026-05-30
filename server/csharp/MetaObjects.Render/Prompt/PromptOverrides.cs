namespace MetaObjects.Render.Prompt;

/// <summary>
/// Render-time overrides of the metadata defaults. <see cref="Style"/> <c>null</c> keeps the spec's
/// style; the maps override <see cref="PromptField.Example"/>/<see cref="PromptField.Instruction"/>
/// per field name.
/// </summary>
public sealed record PromptOverrides
{
    public PromptStyle? Style { get; }
    public IReadOnlyDictionary<string, string> Examples { get; }
    public IReadOnlyDictionary<string, string> Instructions { get; }

    public PromptOverrides(
        PromptStyle? style,
        IReadOnlyDictionary<string, string>? examples,
        IReadOnlyDictionary<string, string>? instructions)
    {
        Style = style;
        Examples = examples is null
            ? EmptyMap
            : new Dictionary<string, string>(examples);
        Instructions = instructions is null
            ? EmptyMap
            : new Dictionary<string, string>(instructions);
    }

    private static readonly IReadOnlyDictionary<string, string> EmptyMap =
        new Dictionary<string, string>();

    /// <summary>No overrides — keep every metadata default.</summary>
    public static PromptOverrides None() => new(null, null, null);
}
