// Shared field-kind mapping for the FR-010 codegen emitters (RecoverSchemaEmitter +
// OutputFormatSpecEmitter). Maps a metadata field subtype onto the render engine's
// FieldKind, the idiomatic nullable C# type used by the recover mirror record, and the
// RecoverMap accessor that reads it from the forgiving outcome map.
//
// Mirrors the Java SpringTypeMapper / RecoverSchemaEmitter instanceof order and the C#
// PayloadCodegen scalar map. Bounded scope (parity with Java/Kotlin): scalar / enum /
// scalar-array. Nested object + array-of-enum are deferred (see KNOWN_GAPS).

using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;

namespace MetaObjects.Codegen.Generators;

internal static class Fr010FieldMapping
{
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
        if (IsArray(field)) return "global::System.Collections.Generic.IReadOnlyList<string>?";
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
