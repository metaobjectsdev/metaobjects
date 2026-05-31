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

    /// <summary>
    /// The nullable C# type for a SINGLE scalar field subtype in a recover mirror
    /// (e.g. <c>int?</c> / <c>long?</c> / <c>double?</c> / <c>bool?</c> / <c>string?</c>). Enum is
    /// string-backed (<c>string?</c>). Shared by the self-contained mirror, the nested-aware
    /// (delegating) mirror, and the scalar-ARRAY element type so the three stay in lock-step with
    /// PayloadCodegen's strict scalar map.
    /// </summary>
    public static string ScalarMirrorType(string subType) => subType switch
    {
        FIELD_SUBTYPE_ENUM => "string?",
        _ => ScalarKind(subType) switch
        {
            "Int" => "int?",
            "Long" => "long?",
            "Double" => "double?",
            "Decimal" => "decimal?",
            "Boolean" => "bool?",
            _ => "string?",
        },
    };

    /// <summary>
    /// The nullable C# element type for a scalar ARRAY in a recover mirror. Kept in lock-step with
    /// the array reader (<see cref="RecoverMapCall"/>'s <c>As*List</c> switch): only int/long/double/bool
    /// have kind-typed list readers; everything else (enum, decimal, date/time, string) is string-backed
    /// via <c>AsStringList</c>. Deliberately distinct from <see cref="ScalarMirrorType"/> (single scalars),
    /// where a single decimal is <c>decimal?</c> via <c>AsDecimal</c> — there is no <c>AsDecimalList</c>
    /// (decimal is single-only, SP-A), so a decimal array degrades to string here rather than emitting
    /// a mirror/reader type mismatch.
    /// </summary>
    public static string ScalarArrayElementType(string subType) => ScalarKind(subType) switch
    {
        "Int" => "int?",
        "Long" => "long?",
        "Double" => "double?",
        "Boolean" => "bool?",
        _ => "string?",
    };

    /// <summary>The render-engine <c>FieldKind</c> member name for a scalar field subtype, or null if non-scalar.</summary>
    public static string? ScalarKind(string subType) => subType switch
    {
        FIELD_SUBTYPE_STRING or FIELD_SUBTYPE_CLASS or
        FIELD_SUBTYPE_DATE or FIELD_SUBTYPE_TIME or FIELD_SUBTYPE_TIMESTAMP => "String",
        FIELD_SUBTYPE_INT or FIELD_SUBTYPE_SHORT or FIELD_SUBTYPE_BYTE => "Int",
        FIELD_SUBTYPE_LONG or FIELD_SUBTYPE_CURRENCY => "Long",
        FIELD_SUBTYPE_DOUBLE or FIELD_SUBTYPE_FLOAT => "Double",
        FIELD_SUBTYPE_DECIMAL => "Decimal",
        FIELD_SUBTYPE_BOOLEAN => "Boolean",
        _ => null,
    };

    /// <summary>The nullable C# type for a field in the SELF-CONTAINED recover mirror record.</summary>
    public static string MirrorType(MetaData field)
    {
        // Object BEFORE array (the object-before-isArray fix): a nested-object field — whether
        // single OR array — is deferred to null in the self-contained path, so it must NOT be
        // typed as a string list (that would force RecoverMapCall down the AsStringList branch
        // and mismatch the nested-aware mirror the delegating path shares). The delegating path
        // overrides this with nested-mirror typing (RecoverDelegateEmitter.NestedMirrorRecords).
        if (field.SubType == FIELD_SUBTYPE_OBJECT) return "object?"; // nested deferred (self-contained)
        // Scalar ARRAY: kind-type the element so the mirror list matches what the kind-typed
        // RecoverMap.As*List reader actually produces (int?/long?/double?/bool?/string?). Nullable
        // element: a recovered array can carry null where individual items were lost. NOTE: this
        // uses ScalarArrayElementType (NOT ScalarMirrorType) — decimal/date/enum arrays are
        // string-backed here because there is no AsDecimalList reader (decimal is single-only,
        // SP-A); a single decimal stays decimal? via ScalarMirrorType below.
        if (IsArray(field))
            return $"global::System.Collections.Generic.IReadOnlyList<{ScalarArrayElementType(field.SubType)}>?";
        return ScalarMirrorType(field.SubType);
    }

    /// <summary>The <c>RecoverMap.As*</c> call that reads this field from the forgiving map <c>d</c>.</summary>
    public static string RecoverMapCall(MetaData field)
    {
        string name = field.Name;
        // Object BEFORE array (object-before-isArray): a nested object/array-of-objects defers to
        // null on the self-contained path (it cannot map a List<NestedRecovered> from a flat map).
        if (field.SubType == FIELD_SUBTYPE_OBJECT) return "null /* FR-010: nested recover deferred (self-contained) */";
        // Scalar ARRAY: read via the kind-typed RecoverMap.As*List so the produced element type
        // matches the kind-typed mirror list (an int[] reads via AsIntList, etc.). Enum arrays stay
        // string-backed (AsStringList) — they are string-typed in the mirror.
        if (IsArray(field) && field.SubType != FIELD_SUBTYPE_ENUM)
            return ScalarKind(field.SubType) switch
            {
                "Int" => $"RecoverMap.AsIntList(d, \"{name}\")",
                "Long" => $"RecoverMap.AsLongList(d, \"{name}\")",
                "Double" => $"RecoverMap.AsDoubleList(d, \"{name}\")",
                "Boolean" => $"RecoverMap.AsBoolList(d, \"{name}\")",
                _ => $"RecoverMap.AsStringList(d, \"{name}\")",
            };
        if (IsArray(field)) return $"RecoverMap.AsStringList(d, \"{name}\")";
        if (field.SubType == FIELD_SUBTYPE_ENUM) return $"RecoverMap.AsString(d, \"{name}\")";
        return ScalarKind(field.SubType) switch
        {
            "Int" => $"RecoverMap.AsInt(d, \"{name}\")",
            "Long" => $"RecoverMap.AsLong(d, \"{name}\")",
            "Double" => $"RecoverMap.AsDouble(d, \"{name}\")",
            "Decimal" => $"RecoverMap.AsDecimal(d, \"{name}\")",
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
