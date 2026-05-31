namespace MetaObjects.Render.Extract;

/// <summary>
/// One field's extract descriptor.
/// <see cref="EnumValues"/> and <see cref="EnumAlias"/> are non-null only for <see cref="FieldKind.Enum"/>.
/// <see cref="Min"/> / <see cref="Max"/> are non-null only for numeric range constraints.
/// <see cref="Nested"/> is non-null only for <see cref="FieldKind.Object"/>.
/// <see cref="CoerceDefault"/> / <see cref="DefaultValue"/> / <see cref="Normalize"/> are FR-011 enum
/// extract-hardening attrs (enum-only; <see cref="Normalize"/> defaults to <see cref="NormalizeMode.Strip"/>).
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
    ExtractSchema? Nested,
    string? CoerceDefault = null,
    string? DefaultValue = null,
    NormalizeMode Normalize = NormalizeMode.Strip)
{
    /// <summary>Build a plain scalar field (string / int / long / double / boolean).</summary>
    public static FieldSpec Scalar(string name, FieldKind kind, bool required) =>
        new(name, kind, required, false, null, null, null, null, null);

    /// <summary>
    /// Phase B (scalar array): a non-enum scalar field that is a list (<c>Array == true</c>).
    /// The engine reads a raw element list and coerces each element to <paramref name="kind"/>;
    /// a single-value <c>@default</c> does not apply to the element list. Mirrors
    /// <see cref="Scalar(string, FieldKind, bool)"/> but with <c>array = true</c>.
    /// </summary>
    public static FieldSpec ScalarArray(string name, FieldKind kind, bool required) =>
        new(name, kind, required, true, null, null, null, null, null);

    /// <summary>
    /// Phase B (generalized <c>@default</c>): a scalar field carrying an absent-fill
    /// <paramref name="defaultValue"/>. When the field is ABSENT from the model response,
    /// tolerant extract coerces this string to <paramref name="kind"/> via
    /// <see cref="Coerce.Scalar"/> and classifies the field <c>DEFAULTED</c> (which satisfies
    /// <c>required</c>). A null <paramref name="defaultValue"/> is the no-default case
    /// (identical to <see cref="Scalar(string, FieldKind, bool)"/>).
    /// </summary>
    public static FieldSpec Scalar(string name, FieldKind kind, bool required, string? defaultValue) =>
        new(name, kind, required, false, null, null, null, null, null, DefaultValue: defaultValue);

    /// <summary>
    /// Build an enum field with its allowed values and optional case/alias map.
    /// FR-011: optional <paramref name="coerceDefault"/> (present-but-uncoercible fallback member),
    /// <paramref name="normalize"/> mode (default <see cref="NormalizeMode.Strip"/>), and
    /// <paramref name="defaultValue"/> (absent-fill member).
    /// </summary>
    public static FieldSpec EnumField(
        string name,
        bool required,
        IReadOnlyList<string>? values,
        IReadOnlyDictionary<string, string>? aliases,
        string? coerceDefault = null,
        NormalizeMode normalize = NormalizeMode.Strip,
        string? defaultValue = null) =>
        new(name, FieldKind.Enum, required, false,
            values == null ? null : new List<string>(values).AsReadOnly(),
            aliases == null
                ? new Dictionary<string, string>()
                : new Dictionary<string, string>(aliases),
            null, null, null,
            CoerceDefault: coerceDefault,
            DefaultValue: defaultValue,
            Normalize: normalize);

    /// <summary>
    /// Phase B (array-of-enum): an enum field that is a <c>List&lt;enum&gt;</c> (<c>Array == true</c>).
    /// Each element is coerced through the SAME enum pipeline a scalar enum uses
    /// (exact → normalize → <c>@enumAlias</c> → <c>@coerceDefault</c> → MALFORMED), classified
    /// independently by indexed path (<c>tags[0]</c>, <c>tags[1]</c>, …). Mirrors
    /// <see cref="EnumField"/> but with <c>array = true</c>.
    /// </summary>
    public static FieldSpec EnumArray(
        string name,
        bool required,
        IReadOnlyList<string>? values,
        IReadOnlyDictionary<string, string>? aliases,
        string? coerceDefault = null,
        NormalizeMode normalize = NormalizeMode.Strip,
        string? defaultValue = null) =>
        new(name, FieldKind.Enum, required, true,
            values == null ? null : new List<string>(values).AsReadOnly(),
            aliases == null
                ? new Dictionary<string, string>()
                : new Dictionary<string, string>(aliases),
            null, null, null,
            CoerceDefault: coerceDefault,
            DefaultValue: defaultValue,
            Normalize: normalize);

    /// <summary>Build a numeric field with optional min/max range constraints.</summary>
    public static FieldSpec Range(string name, FieldKind kind, bool required, double? min, double? max) =>
        new(name, kind, required, false, null, null, min, max, null);

    /// <summary>Build a nested object field backed by a child <see cref="ExtractSchema"/>.</summary>
    public static FieldSpec Object(string name, bool required, bool array, ExtractSchema nested) =>
        new(name, FieldKind.Object, required, array, null, null, null, null, nested);
}
