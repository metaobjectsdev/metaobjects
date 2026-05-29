namespace MetaObjects.Render.Recover;

/// <summary>
/// Top-level recover descriptor.
/// <see cref="RootName"/> is the XML root element tag / logical JSON root name.
/// <see cref="Fields"/> is never null; a null argument is normalised to an empty list.
/// </summary>
public sealed record RecoverSchema
{
    public Format Format { get; init; }
    public string RootName { get; init; }
    public IReadOnlyList<FieldSpec> Fields { get; init; }

    public RecoverSchema(Format format, string rootName, IReadOnlyList<FieldSpec>? fields = null)
    {
        Format = format;
        RootName = rootName;
        Fields = fields ?? Array.Empty<FieldSpec>();
    }
}
