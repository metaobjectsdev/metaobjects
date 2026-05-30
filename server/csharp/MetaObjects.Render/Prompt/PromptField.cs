using MetaObjects.Render.Recover;

namespace MetaObjects.Render.Prompt;

/// <summary>
/// One field of an output-format fragment. <see cref="EnumValues"/>/<see cref="EnumDoc"/> are
/// non-null only for <see cref="FieldKind.Enum"/>; <see cref="Nested"/> non-null only for
/// <see cref="FieldKind.Object"/>; <see cref="Example"/>/<see cref="Instruction"/> are nullable.
/// </summary>
/// <remarks>
/// Precondition: <see cref="Name"/> must be identifier-safe (valid XML element name / JSON key).
/// The renderer does not escape field names.
/// </remarks>
public sealed record PromptField(
    string Name,
    FieldKind Kind,
    bool Required,
    bool Array,
    IReadOnlyList<string>? EnumValues,
    IReadOnlyDictionary<string, string>? EnumDoc,
    string? Example,
    string? Instruction,
    OutputFormatSpec? Nested);
