using MetaObjects.Render.Recover;

namespace MetaObjects.Render.Prompt;

/// <summary>
/// A complete output-format descriptor: the format, the root element/object name, the default
/// presentation style, and the ordered fields. Drives <see cref="OutputFormatRenderer"/>.
/// </summary>
/// <remarks>
/// Precondition: <see cref="RootName"/> must be identifier-safe (valid XML element name / JSON key).
/// The renderer does not escape it.
/// </remarks>
public sealed record OutputFormatSpec
{
    public Format Format { get; }
    public string RootName { get; }
    public PromptStyle Style { get; }
    public IReadOnlyList<PromptField> Fields { get; }

    public OutputFormatSpec(Format format, string rootName, PromptStyle style, IReadOnlyList<PromptField>? fields)
    {
        ArgumentNullException.ThrowIfNull(rootName);
        Format = format;
        RootName = rootName;
        Style = style;
        Fields = fields is null ? Array.Empty<PromptField>() : fields.ToArray();
    }
}
