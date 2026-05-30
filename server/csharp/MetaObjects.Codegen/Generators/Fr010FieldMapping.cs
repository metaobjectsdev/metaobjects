// Shared field-kind mapping for the FR-010 codegen emitters (RecoverSchemaEmitter +
// OutputFormatSpecEmitter). Maps a metadata field subtype onto the render engine's
// FieldKind, the idiomatic nullable C# type used by the recover mirror record, and the
// RecoverMap accessor that reads it from the forgiving outcome map.
//
// Mirrors the Java SpringTypeMapper / RecoverSchemaEmitter instanceof order and the C#
// PayloadCodegen scalar map. Bounded scope (parity with Java/Kotlin): scalar / enum /
// scalar-array. Nested object + array-of-enum are deferred (see KNOWN_GAPS).

using System.Collections.Generic;
using System.Linq;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

internal static class Fr010FieldMapping
{
    /// <summary>The field children of a payload value-object, in declaration order.</summary>
    public static IEnumerable<MetaData> Fields(MetaData vo) =>
        vo.Children().Where(c => c.Type == TYPE_FIELD);

    /// <summary>The string members of an enum field's <c>@values</c> attr (empty when absent).</summary>
    public static IReadOnlyList<string> EnumValues(MetaData field) =>
        field.OwnAttr(FIELD_ATTR_VALUES) switch
        {
            IReadOnlyList<string> ss => ss,
            IReadOnlyList<object?> os => os.Select(o => o?.ToString() ?? "").ToList(),
            _ => new List<string>(),
        };

    /// <summary>
    /// Emit a C# <c>new Dictionary&lt;string, string&gt; { … }</c> literal for a properties-shaped
    /// attr (e.g. <c>@enumDoc</c> / <c>@enumAlias</c>), or <c>"null"</c> when absent/empty.
    /// Null values are dropped; keys are sorted ordinally for deterministic output (matches the
    /// canonical-serializer properties sort).
    /// </summary>
    public static string PropertiesMapLiteral(object? attr)
    {
        if (attr is not IReadOnlyDictionary<string, object?> d) return "null";
        var entries = d.Where(kv => kv.Value is not null)
            .OrderBy(kv => kv.Key, System.StringComparer.Ordinal)
            .Select(kv => $"[\"{CSharpStringLiteral(kv.Key)}\"] = \"{CSharpStringLiteral(kv.Value!.ToString()!)}\"")
            .ToList();
        if (entries.Count == 0) return "null";
        return "new Dictionary<string, string> { " + string.Join(", ", entries) + " }";
    }

    /// <summary>Emit a C# <c>new[] { "a", "b" }</c> string-array literal for the given members.</summary>
    public static string StringArrayLiteral(IEnumerable<string> values) =>
        "new[] { " + string.Join(", ", values.Select(v => $"\"{v}\"")) + " }";

    /// <summary>
    /// FR-011: the field's <c>@coerceDefault</c> member symbol (present-but-uncoercible enum fallback),
    /// or null when absent. Own-attr only — <c>@coerceDefault</c> is concrete, never inherited.
    /// </summary>
    public static string? CoerceDefault(MetaData field) =>
        field.OwnAttr(FIELD_ATTR_COERCE_DEFAULT) is string s && s.Length > 0 ? s : null;

    /// <summary>FR-011: the field's <c>@default</c> member symbol (absent-fill enum value), or null when absent.</summary>
    public static string? DefaultValue(MetaData field) =>
        field.OwnAttr(FIELD_ATTR_DEFAULT) is string s && s.Length > 0 ? s : null;

    /// <summary>
    /// FR-011: resolve the enum normalization mode for a field — field-level <c>@normalize</c>, else
    /// the owning <c>object.value</c>'s <c>@normalize</c> (the per-object default), else the global
    /// <see cref="FieldConstants.NORMALIZE_DEFAULT"/> ("strip"). <paramref name="ownerObject"/> may be
    /// null (resolution then skips the object tier). Mirrors the TS resolveNormalize.
    /// </summary>
    public static string ResolveNormalize(MetaData field, MetaData? ownerObject)
    {
        string? fieldMode = NormalizeAttrOf(field);
        if (fieldMode != null) return fieldMode;
        string? objMode = ownerObject == null ? null : NormalizeAttrOf(ownerObject);
        if (objMode != null) return objMode;
        return NORMALIZE_DEFAULT;
    }

    /// <summary>The <c>@normalize</c> attr of a node as a mode string, or null when absent.</summary>
    private static string? NormalizeAttrOf(MetaData node) =>
        node.OwnAttr(FIELD_ATTR_NORMALIZE) is string s && s.Length > 0 ? s : null;

    /// <summary>Map a <c>@normalize</c> mode string onto the render-engine <c>NormalizeMode</c> member name.</summary>
    public static string NormalizeModeMember(string mode) => mode switch
    {
        "none"     => "NormalizeMode.None",
        "collapse" => "NormalizeMode.Collapse",
        _          => "NormalizeMode.Strip",
    };

    /// <summary>The render-engine <c>FieldKind</c> member name for a scalar field subtype, or null if non-scalar.</summary>
    public static string? ScalarKind(string subType) => subType switch
    {
        FIELD_SUBTYPE_STRING or FIELD_SUBTYPE_CLASS or
        FIELD_SUBTYPE_DATE or FIELD_SUBTYPE_TIME or FIELD_SUBTYPE_TIMESTAMP => "String",
        FIELD_SUBTYPE_INT or FIELD_SUBTYPE_SHORT or FIELD_SUBTYPE_BYTE => "Int",
        FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_CURRENCY => "Long",
        FIELD_SUBTYPE_DOUBLE or FIELD_SUBTYPE_FLOAT or FIELD_SUBTYPE_DECIMAL => "Double",
        FIELD_SUBTYPE_BOOLEAN => "Boolean",
        _ => null,
    };

    /// <summary>The nullable C# type for a field in the recover mirror record.</summary>
    public static string MirrorType(MetaData field)
    {
        // Nullable element to match RecoverMap.AsStringList's IReadOnlyList<string?>? return —
        // a recovered array can contain null elements where individual items were lost.
        if (IsArray(field)) return "global::System.Collections.Generic.IReadOnlyList<string?>?";
        if (field.SubType == FIELD_SUBTYPE_OBJECT) return "object?"; // nested deferred
        if (field.SubType == FIELD_SUBTYPE_ENUM) return "string?";   // enum is string-backed
        return ScalarKind(field.SubType) switch
        {
            "Int" => "int?",
            "Long" => "long?",
            "Double" => "double?",
            "Boolean" => "bool?",
            _ => "string?",
        };
    }

    /// <summary>The <c>RecoverMap.As*</c> call that reads this field from the forgiving map <c>d</c>.</summary>
    public static string RecoverMapCall(MetaData field)
    {
        string name = field.Name;
        if (IsArray(field)) return $"RecoverMap.AsStringList(d, \"{name}\")";
        if (field.SubType == FIELD_SUBTYPE_OBJECT) return "null /* FR-010: nested recover deferred */";
        if (field.SubType == FIELD_SUBTYPE_ENUM) return $"RecoverMap.AsString(d, \"{name}\")";
        return ScalarKind(field.SubType) switch
        {
            "Int" => $"RecoverMap.AsInt(d, \"{name}\")",
            "Long" => $"RecoverMap.AsLong(d, \"{name}\")",
            "Double" => $"RecoverMap.AsDouble(d, \"{name}\")",
            "Boolean" => $"RecoverMap.AsBool(d, \"{name}\")",
            _ => $"RecoverMap.AsString(d, \"{name}\")",
        };
    }

    public static bool IsArray(MetaData field) =>
        field.OwnAttr(RESERVED_KEY_IS_ARRAY) is true || field.IsArray;

    public static bool IsRequired(MetaData field) =>
        field.OwnAttr(FIELD_ATTR_REQUIRED) is true ||
        (field.OwnAttr(FIELD_ATTR_REQUIRED) is string s && s.Equals("true", StringComparison.OrdinalIgnoreCase));

    /// <summary>Escape a value for embedding inside a C# double-quoted string literal.</summary>
    public static string CSharpStringLiteral(string value)
    {
        var sb = new System.Text.StringBuilder(value.Length + 4);
        foreach (char c in value)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\t': sb.Append("\\t"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
}
