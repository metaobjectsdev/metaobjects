using System.Globalization;
using System.Text;
using MetaObjects.Render.Recover;

namespace MetaObjects.Render.Prompt;

/// <summary>
/// Renders an <see cref="OutputFormatSpec"/> into an output-format prompt fragment (FR-010 artifact 1)
/// — "produce your answer like this". Three comment-free styles × {XML, JSON}. Guidance is carried in
/// prose / inline placeholders / a filled skeleton, NEVER in comments (models ignore them).
/// </summary>
/// <remarks>
/// Ported from the Java reference (<c>com.metaobjects.render.prompt.OutputFormatRenderer</c>). The
/// rendered text is a cross-port invariant — kept byte-identical to Java/Kotlin.
/// </remarks>
public static class OutputFormatRenderer
{
    private static readonly HashSet<FieldKind> NumericKinds =
        [FieldKind.Int, FieldKind.Long, FieldKind.Double, FieldKind.Boolean];

    public static string Render(OutputFormatSpec spec, PromptOverrides overrides)
    {
        PromptStyle effectiveStyle = overrides.Style ?? spec.Style;
        return effectiveStyle switch
        {
            PromptStyle.ExampleOnly => RenderExampleOnly(spec, overrides),
            PromptStyle.Inline => RenderInline(spec, overrides),
            _ => RenderGuide(spec, overrides),
        };
    }

    // ---- INLINE ----------------------------------------------------------------

    private static string RenderInline(OutputFormatSpec spec, PromptOverrides overrides) =>
        spec.Format switch
        {
            Format.Xml => RenderXmlInline(spec, overrides),
            _ => RenderJsonInline(spec, overrides),
        };

    private static string RenderXmlInline(OutputFormatSpec spec, PromptOverrides overrides)
    {
        var sb = new StringBuilder();
        sb.Append('<').Append(spec.RootName).Append(">\n");
        foreach (PromptField field in spec.Fields)
        {
            string escaped = EscapeXml(InlineContent(field, overrides));
            sb.Append("  <").Append(field.Name).Append('>')
              .Append(escaped)
              .Append("</").Append(field.Name).Append(">\n");
        }
        sb.Append("</").Append(spec.RootName).Append('>');
        return sb.ToString();
    }

    private static string RenderJsonInline(OutputFormatSpec spec, PromptOverrides overrides)
    {
        var sb = new StringBuilder();
        sb.Append("{\n");
        for (int i = 0; i < spec.Fields.Count; i++)
        {
            PromptField field = spec.Fields[i];
            bool isLast = i == spec.Fields.Count - 1;
            sb.Append("  \"").Append(field.Name).Append("\": ");
            sb.Append('"').Append(EscapeJson(InlineContent(field, overrides))).Append('"');
            if (!isLast) sb.Append(',');
            sb.Append('\n');
        }
        sb.Append('}');
        return sb.ToString();
    }

    private static string InlineContent(PromptField field, PromptOverrides overrides)
    {
        if (field.Kind == FieldKind.Enum && field.EnumValues is { Count: > 0 } values)
            return string.Join(" | ", values);
        if (field.Kind == FieldKind.Boolean)
            return "true | false";
        string? instruction = ResolveInstruction(field, overrides);
        return instruction != null ? "{" + instruction + "}" : "{" + field.Name + "}";
    }

    /// <summary>Effective instruction: override first, then the field default, else <c>null</c>.</summary>
    private static string? ResolveInstruction(PromptField field, PromptOverrides overrides) =>
        overrides.Instructions.TryGetValue(field.Name, out string? ov) ? ov : field.Instruction;

    // ---- GUIDE -----------------------------------------------------------------

    private static string RenderGuide(OutputFormatSpec spec, PromptOverrides overrides)
    {
        var sb = new StringBuilder();
        sb.Append("Fill in each field as described below:\n");
        foreach (PromptField field in spec.Fields)
        {
            string req = field.Required ? "required" : "optional";
            sb.Append("- ").Append(field.Name).Append(" (").Append(req).Append(')');
            string? instruction = ResolveInstruction(field, overrides);
            if (instruction != null)
                sb.Append(": ").Append(instruction);
            sb.Append('\n');
            if (field.Kind == FieldKind.Enum && field.EnumValues is { Count: > 0 } values)
            {
                sb.Append("    one of ").Append(string.Join(", ", values)).Append('\n');
                if (field.EnumDoc is { } enumDoc)
                {
                    foreach (string val in values)
                    {
                        if (enumDoc.TryGetValue(val, out string? doc) && doc != null)
                            sb.Append("      ").Append(val).Append(" = ").Append(doc).Append('\n');
                    }
                }
            }
            string? eg = ExampleValueIfDeclared(field, overrides);
            if (eg != null)
                sb.Append("    e.g. ").Append(eg).Append('\n');
        }
        sb.Append("\nRespond exactly like this:\n");
        sb.Append(RenderExampleOnly(spec, overrides));
        return sb.ToString();
    }

    // ---- EXAMPLE-ONLY (also the skeleton appended by GUIDE) ---------------------

    internal static string RenderExampleOnly(OutputFormatSpec spec, PromptOverrides overrides) =>
        spec.Format switch
        {
            Format.Xml => RenderXmlSkeleton(spec, overrides),
            _ => RenderJsonSkeleton(spec, overrides),
        };

    private static string RenderXmlSkeleton(OutputFormatSpec spec, PromptOverrides overrides)
    {
        var sb = new StringBuilder();
        sb.Append('<').Append(spec.RootName).Append(">\n");
        foreach (PromptField field in spec.Fields)
        {
            string escaped = EscapeXml(ExampleValue(field, overrides));
            sb.Append("  <").Append(field.Name).Append('>')
              .Append(escaped)
              .Append("</").Append(field.Name).Append(">\n");
        }
        sb.Append("</").Append(spec.RootName).Append('>');
        return sb.ToString();
    }

    private static string RenderJsonSkeleton(OutputFormatSpec spec, PromptOverrides overrides)
    {
        var sb = new StringBuilder();
        sb.Append("{\n");
        for (int i = 0; i < spec.Fields.Count; i++)
        {
            PromptField field = spec.Fields[i];
            // NOTE: FieldKind.Object / nested fields are not expanded here — they render as a
            // "{fieldName}" placeholder. Nested-object expansion is a bounded deferral (see KNOWN_GAPS).
            string value = ExampleValue(field, overrides);
            bool isLast = i == spec.Fields.Count - 1;
            sb.Append("  \"").Append(field.Name).Append("\": ");
            if (IsNumericOrBoolean(field.Kind, value))
                sb.Append(value);
            else
                sb.Append('"').Append(EscapeJson(value)).Append('"');
            if (!isLast) sb.Append(',');
            sb.Append('\n');
        }
        sb.Append('}');
        return sb.ToString();
    }

    private static string? ExampleValueIfDeclared(PromptField field, PromptOverrides overrides) =>
        overrides.Examples.TryGetValue(field.Name, out string? ov) ? ov : field.Example;

    internal static string ExampleValue(PromptField field, PromptOverrides overrides)
    {
        if (overrides.Examples.TryGetValue(field.Name, out string? ov)) return ov;
        if (field.Example != null) return field.Example;
        if (field.Kind == FieldKind.Enum && field.EnumValues is { Count: > 0 } values)
            return values[0];
        return "{" + field.Name + "}";
    }

    private static bool IsNumericOrBoolean(FieldKind kind, string value)
    {
        if (!NumericKinds.Contains(kind)) return false;
        if (value is "true" or "false") return true;
        // Invariant culture + finite-only — matches the recover engine and keeps the emitted JSON
        // valid (NaN/Infinity fall through to a quoted string).
        return double.TryParse(value, NumberStyles.Float | NumberStyles.AllowLeadingSign,
                   CultureInfo.InvariantCulture, out double d)
               && double.IsFinite(d);
    }

    private static string EscapeXml(string s) => Escapers.For(Escapers.FORMAT_XML)(s);
    private static string EscapeJson(string s) => Escapers.For(Escapers.FORMAT_JSON)(s);
}
