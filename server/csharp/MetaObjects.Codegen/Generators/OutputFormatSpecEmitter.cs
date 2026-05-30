// Turns a payload value-object + its template.output node into a C# source literal for an
// OutputFormatSpec — the artifact-1 prompt descriptor used by the FR-010 output-prompt codegen.
//
// Emits `new OutputFormatSpec(Format.X, "rootName", PromptStyle.X, new PromptField[] { … })`.
// Mirrors the Java OutputFormatSpecEmitter (adapted to C# syntax). Field-kind mapping is shared
// via Fr010FieldMapping. Bounded scope: scalar / enum. Nested object → FieldKind.Object placeholder.

using System.Collections.Generic;
using System.Linq;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

internal static class OutputFormatSpecEmitter
{
    private static IEnumerable<MetaData> Fields(MetaData vo) =>
        vo.Children().Where(c => c.Type == TYPE_FIELD);

    /// <summary>
    /// Emit <c>new OutputFormatSpec(Format.X, "rootName", PromptStyle.X, new PromptField[] { … })</c>.
    /// </summary>
    public static string SpecLiteral(MetaData vo, MetaData template, string rootName)
    {
        string formatEnum = ResolveFormat(template);
        string styleEnum = ResolvePromptStyle(template);
        var fields = Fields(vo).Select(PromptFieldLiteral);
        return $"new OutputFormatSpec({formatEnum}, \"{rootName}\", {styleEnum}, "
            + $"new PromptField[] {{ {string.Join(", ", fields)} }})";
    }

    private static string ResolveFormat(MetaData template) =>
        template.OwnAttr(TEMPLATE_ATTR_FORMAT) is string f && f.Equals("xml", System.StringComparison.OrdinalIgnoreCase)
            ? "Format.Xml" : "Format.Json";

    private static string ResolvePromptStyle(MetaData template) =>
        (template.OwnAttr(TEMPLATE_ATTR_PROMPT_STYLE) as string) switch
        {
            PROMPT_STYLE_INLINE => "PromptStyle.Inline",
            PROMPT_STYLE_EXAMPLE_ONLY => "PromptStyle.ExampleOnly",
            _ => "PromptStyle.Guide",
        };

    private static string PromptFieldLiteral(MetaData field)
    {
        string name = field.Name;
        string req = Fr010FieldMapping.IsRequired(field) ? "true" : "false";
        string array = Fr010FieldMapping.IsArray(field) ? "true" : "false";

        if (field.SubType == FIELD_SUBTYPE_OBJECT)
            return $"new PromptField(\"{name}\", FieldKind.Object, {req}, {array}, null, null, null, null, null) /* FR-010: nested prompt deferred */";

        string example = OptStringAttr(field, FIELD_ATTR_EXAMPLE);
        string instruction = OptStringAttr(field, FIELD_ATTR_INSTRUCTION);

        if (field.SubType == FIELD_SUBTYPE_ENUM)
        {
            string valuesLit = "new[] { " + string.Join(", ", EnumValues(field).Select(v => $"\"{v}\"")) + " }";
            string enumDocLit = EnumDocLiteral(field);
            return $"new PromptField(\"{name}\", FieldKind.Enum, {req}, {array}, "
                + $"{valuesLit}, {enumDocLit}, {example}, {instruction}, null)";
        }

        string kind = Fr010FieldMapping.ScalarKind(field.SubType) ?? "String";
        return $"new PromptField(\"{name}\", FieldKind.{kind}, {req}, {array}, "
            + $"null, null, {example}, {instruction}, null)";
    }

    // ---- helpers ----

    private static string OptStringAttr(MetaData field, string attrName) =>
        field.OwnAttr(attrName) is string v
            ? $"\"{Fr010FieldMapping.CSharpStringLiteral(v)}\""
            : "null";

    private static IReadOnlyList<string> EnumValues(MetaData field) =>
        field.OwnAttr(FIELD_ATTR_VALUES) switch
        {
            IReadOnlyList<string> ss => ss,
            IReadOnlyList<object?> os => os.Select(o => o?.ToString() ?? "").ToList(),
            _ => new List<string>(),
        };

    private static string EnumDocLiteral(MetaData field)
    {
        if (field.OwnAttr(FIELD_ATTR_ENUM_DOC) is not IReadOnlyDictionary<string, object?> d || d.Count == 0)
            return "null";
        var entries = d.Where(kv => kv.Value is not null)
            .OrderBy(kv => kv.Key, System.StringComparer.Ordinal)
            .Select(kv => $"[\"{Fr010FieldMapping.CSharpStringLiteral(kv.Key)}\"] = "
                + $"\"{Fr010FieldMapping.CSharpStringLiteral(kv.Value!.ToString()!)}\"");
        return "new Dictionary<string, string> { " + string.Join(", ", entries) + " }";
    }
}
