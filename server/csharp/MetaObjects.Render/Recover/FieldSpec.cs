namespace MetaObjects.Render.Recover;

/// <summary>
/// One field's recover descriptor.
/// <see cref="EnumValues"/> and <see cref="EnumAlias"/> are non-null only for <see cref="FieldKind.Enum"/>.
/// <see cref="Min"/> / <see cref="Max"/> are non-null only for numeric range constraints.
/// <see cref="Nested"/> is non-null only for <see cref="FieldKind.Object"/>.
/// </summary>
public sealed record FieldSpec(
    string Name,
    FieldKind Kind,
    bool Required,
    bool Array,
    IReadOnlyList<string>? EnumValues,
    IReadOnlyDictionary<string, string>? EnumAlias,
    double? Min,
    double? Max,
    RecoverSchema? Nested)
{
    /// <summary>Build a plain scalar field (string / int / long / double / boolean).</summary>
    public static FieldSpec Scalar(string name, FieldKind kind, bool required) =>
        new(name, kind, required, false, null, null, null, null, null);

    /// <summary>Build an enum field with its allowed values and optional case/alias map.</summary>
    public static FieldSpec EnumField(
        string name,
        bool required,
        IReadOnlyList<string>? values,
        IReadOnlyDictionary<string, string>? aliases) =>
        new(name, FieldKind.Enum, required, false,
            values == null ? null : new List<string>(values).AsReadOnly(),
            aliases == null
                ? new Dictionary<string, string>()
                : new Dictionary<string, string>(aliases),
            null, null, null);

    /// <summary>Build a numeric field with optional min/max range constraints.</summary>
    public static FieldSpec Range(string name, FieldKind kind, bool required, double? min, double? max) =>
        new(name, kind, required, false, null, null, min, max, null);

    /// <summary>Build a nested object field backed by a child <see cref="RecoverSchema"/>.</summary>
    public static FieldSpec Object(string name, bool required, bool array, RecoverSchema nested) =>
        new(name, FieldKind.Object, required, array, null, null, null, null, nested);
}
