namespace MetaObjects.Render.Prompt;

/// <summary>
/// How the output-format fragment teaches the model (FR-010 artifact 1). Guidance is NEVER
/// carried in comments — models ignore them. Default is <see cref="Guide"/>.
/// </summary>
public enum PromptStyle
{
    /// <summary>Prose field list ("Fill in each field…") followed by an example skeleton.</summary>
    Guide,

    /// <summary>A single skeleton whose field values are inline placeholders / enum choices.</summary>
    Inline,

    /// <summary>Just a filled example skeleton, nothing else.</summary>
    ExampleOnly,
}

/// <summary>Parsing of the wire vocabulary (<c>guide|inline|exampleOnly</c>) onto <see cref="PromptStyle"/>.</summary>
public static class PromptStyles
{
    /// <summary>
    /// Maps the <c>@promptStyle</c> attribute string to a <see cref="PromptStyle"/>.
    /// Null or any unrecognized value falls back to <see cref="PromptStyle.Guide"/> (matches Java).
    /// </summary>
    public static PromptStyle From(string? s) => s switch
    {
        "inline" => PromptStyle.Inline,
        "exampleOnly" => PromptStyle.ExampleOnly,
        _ => PromptStyle.Guide,
    };
}
