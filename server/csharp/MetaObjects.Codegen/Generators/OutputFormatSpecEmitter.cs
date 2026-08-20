// Turns a payload value-object + its template.output node into a C# source literal for an
// OutputFormatSpec — the artifact-1 prompt descriptor used by the FR-010 output-prompt codegen.
//
// Emits `new OutputFormatSpec(Format.X, "rootName", PromptStyle.X, new PromptField[] { … })`.
// Mirrors the Java OutputFormatSpecEmitter (adapted to C# syntax). Field-kind mapping is shared
// via Fr010FieldMapping. Bounded scope: scalar / enum. Nested object → FieldKind.Object placeholder.

using System.Linq;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

internal static class OutputFormatSpecEmitter
{
    /// <summary>
    /// Emit <c>new OutputFormatSpec(Format.X, "rootName", PromptStyle.X, new PromptField[] { … })</c>.
    /// </summary>
    public static string SpecLiteral(MetaData vo, MetaData template, string rootName)
    {
        string formatEnum = ResolveFormat(template);
        string styleEnum = ResolvePromptStyle(template);
        var fields = Fr010FieldMapping.Fields(vo).Select(PromptFieldLiteral);
        return $"new OutputFormatSpec({formatEnum}, \"{rootName}\", {styleEnum}, "
            + $"new PromptField[] {{ {string.Join(", ", fields)} }})";
    }

    // ADR-0039: resolving — @format may be inherited via an abstract template base.
    // ADR-0053: the fragment describes the REPLY, so its syntax is @responseFormat — NOT
    // @format, which is the syntax of the rendered prompt BODY. Reading @format here typed the
    // instruction "produce your answer like this" off the format of the question.
    private static string ResolveFormat(MetaData template) =>
        FindInbound.IsXml(FindInbound.ResponseFormatOf(template)) ? "Format.Xml" : "Format.Json";

    // ADR-0039: resolving — @promptStyle may be inherited via an abstract template base.
    private static string ResolvePromptStyle(MetaData template) =>
        (template.Attr(TEMPLATE_ATTR_PROMPT_STYLE) as string) switch
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
            string valuesLit = Fr010FieldMapping.StringArrayLiteral(Fr010FieldMapping.EnumValues(field));
            // ADR-0039: resolving — @enumDoc may be inherited via extends (TS reads field.attr).
            string enumDocLit = Fr010FieldMapping.PropertiesMapLiteral(field.Attr(FIELD_ATTR_ENUM_DOC));
            return $"new PromptField(\"{name}\", FieldKind.Enum, {req}, {array}, "
                + $"{valuesLit}, {enumDocLit}, {example}, {instruction}, null)";
        }

        string kind = Fr010FieldMapping.ScalarKind(field.SubType) ?? "String";
        return $"new PromptField(\"{name}\", FieldKind.{kind}, {req}, {array}, "
            + $"null, null, {example}, {instruction}, null)";
    }

    // ---- helpers ----

    // ADR-0039: resolving — @example/@instruction may be inherited via extends.
    private static string OptStringAttr(MetaData field, string attrName) =>
        field.Attr(attrName) is string v
            ? $"\"{Fr010FieldMapping.CSharpStringLiteral(v)}\""
            : "null";
}
