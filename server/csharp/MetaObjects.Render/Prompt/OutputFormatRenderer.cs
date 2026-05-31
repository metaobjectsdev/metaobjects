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
/// rendered text is a cross-port invariant — kept byte-identical to TS/Java/Kotlin. Nested OBJECT
/// fields (and arrays of objects/scalars) recurse, with a depth + reference-identity cycle guard (FR-012).
/// </remarks>
public static class OutputFormatRenderer
{
    private static readonly HashSet<FieldKind> NumericKinds =
        [FieldKind.Int, FieldKind.Long, FieldKind.Double, FieldKind.Decimal, FieldKind.Boolean];

    private const string Indent = "  ";
    private const int MaxNestDepth = 8;

    /// <summary>Skeleton render mode: filled example values vs inline {placeholder} content.</summary>
    private enum SkelMode { Example, Inline }

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
        spec.Format == Format.Xml
            ? RenderXmlSkeleton(spec, overrides, SkelMode.Inline)
            : RenderJsonSkeleton(spec, overrides, SkelMode.Inline);

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
        var path = NewIdentitySet();
        path.Add(spec);
        GuideFields(spec, overrides, "", path, 0, sb);
        sb.Append("\nRespond exactly like this:\n");
        sb.Append(RenderExampleOnly(spec, overrides));
        return sb.ToString();
    }

    private static void GuideFields(OutputFormatSpec spec, PromptOverrides overrides, string prefix,
        HashSet<OutputFormatSpec> path, int depth, StringBuilder sb)
    {
        foreach (PromptField field in spec.Fields)
        {
            string displayName = prefix + field.Name;
            GuideEntry(field, overrides, displayName, sb);
            if (CanExpand(field, path, depth))
            {
                OutputFormatSpec nested = field.Nested!;
                string childPrefix = field.Array ? displayName + "[]." : displayName + ".";
                path.Add(nested);
                GuideFields(nested, overrides, childPrefix, path, depth + 1, sb);
                path.Remove(nested);
            }
        }
    }

    private static void GuideEntry(PromptField field, PromptOverrides overrides, string displayName, StringBuilder sb)
    {
        string req = field.Required ? "required" : "optional";
        sb.Append("- ").Append(displayName).Append(" (").Append(req).Append(')');
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

    // ---- EXAMPLE-ONLY (also the skeleton appended by GUIDE) ---------------------

    internal static string RenderExampleOnly(OutputFormatSpec spec, PromptOverrides overrides) =>
        spec.Format == Format.Xml
            ? RenderXmlSkeleton(spec, overrides, SkelMode.Example)
            : RenderJsonSkeleton(spec, overrides, SkelMode.Example);

    // ---- JSON skeleton (recursive) ----------------------------------------------

    private static string RenderJsonSkeleton(OutputFormatSpec spec, PromptOverrides overrides, SkelMode mode)
    {
        var path = NewIdentitySet();
        path.Add(spec);
        return JsonObject(spec, overrides, "", mode, path, 0);
    }

    private static string JsonObject(OutputFormatSpec spec, PromptOverrides overrides, string braceIndent,
        SkelMode mode, HashSet<OutputFormatSpec> path, int depth)
    {
        IReadOnlyList<PromptField> fields = spec.Fields;
        if (fields.Count == 0) return "{\n" + braceIndent + "}";
        string fieldIndent = braceIndent + Indent;
        var sb = new StringBuilder();
        sb.Append("{\n");
        for (int i = 0; i < fields.Count; i++)
        {
            PromptField field = fields[i];
            sb.Append(fieldIndent).Append('"').Append(field.Name).Append("\": ")
              .Append(JsonValue(field, overrides, fieldIndent, mode, path, depth));
            if (i < fields.Count - 1) sb.Append(',');
            sb.Append('\n');
        }
        sb.Append(braceIndent).Append('}');
        return sb.ToString();
    }

    private static string JsonValue(PromptField field, PromptOverrides overrides, string indent,
        SkelMode mode, HashSet<OutputFormatSpec> path, int depth)
    {
        if (field.Array) return JsonArray(field, overrides, indent, mode, path, depth);
        if (field.Kind == FieldKind.Object) return JsonObjectField(field, overrides, indent, mode, path, depth);
        return JsonLeaf(field, overrides, mode);
    }

    private static string JsonLeaf(PromptField field, PromptOverrides overrides, SkelMode mode)
    {
        if (mode == SkelMode.Inline)
            return "\"" + EscapeJson(InlineContent(field, overrides)) + "\"";
        string value = ExampleValue(field, overrides);
        return IsNumericOrBoolean(field.Kind, value)
            ? value
            : "\"" + EscapeJson(value) + "\"";
    }

    private static bool CanExpand(PromptField field, HashSet<OutputFormatSpec> path, int depth) =>
        field.Kind == FieldKind.Object && field.Nested != null
        && depth < MaxNestDepth && !path.Contains(field.Nested);

    private static string JsonObjectField(PromptField field, PromptOverrides overrides, string indent,
        SkelMode mode, HashSet<OutputFormatSpec> path, int depth)
    {
        if (!CanExpand(field, path, depth)) return JsonLeaf(field, overrides, mode);
        OutputFormatSpec nested = field.Nested!;
        path.Add(nested);
        string output = JsonObject(nested, overrides, indent, mode, path, depth + 1);
        path.Remove(nested);
        return output;
    }

    private static string JsonArray(PromptField field, PromptOverrides overrides, string indent,
        SkelMode mode, HashSet<OutputFormatSpec> path, int depth)
    {
        string elemIndent = indent + Indent;
        string elem;
        if (CanExpand(field, path, depth))
        {
            OutputFormatSpec nested = field.Nested!;
            path.Add(nested);
            elem = JsonObject(nested, overrides, elemIndent, mode, path, depth + 1);
            path.Remove(nested);
        }
        else
        {
            elem = JsonLeaf(field, overrides, mode);
        }
        return "[\n" + elemIndent + elem + "\n" + indent + "]";
    }

    // ---- XML skeleton (recursive) -----------------------------------------------

    private static string RenderXmlSkeleton(OutputFormatSpec spec, PromptOverrides overrides, SkelMode mode)
    {
        var path = NewIdentitySet();
        path.Add(spec);
        return "<" + spec.RootName + ">\n"
            + XmlBody(spec, overrides, Indent, mode, path, 0)
            + "</" + spec.RootName + ">";
    }

    private static string XmlBody(OutputFormatSpec spec, PromptOverrides overrides, string indent,
        SkelMode mode, HashSet<OutputFormatSpec> path, int depth)
    {
        var sb = new StringBuilder();
        foreach (PromptField field in spec.Fields)
            sb.Append(XmlField(field, overrides, indent, mode, path, depth));
        return sb.ToString();
    }

    private static string XmlField(PromptField field, PromptOverrides overrides, string indent,
        SkelMode mode, HashSet<OutputFormatSpec> path, int depth)
    {
        if (CanExpand(field, path, depth))
        {
            OutputFormatSpec nested = field.Nested!;
            path.Add(nested);
            string body = XmlBody(nested, overrides, indent + Indent, mode, path, depth + 1);
            path.Remove(nested);
            return indent + "<" + field.Name + ">\n" + body + indent + "</" + field.Name + ">\n";
        }
        string content = mode == SkelMode.Inline ? InlineContent(field, overrides) : ExampleValue(field, overrides);
        return indent + "<" + field.Name + ">" + EscapeXml(content) + "</" + field.Name + ">\n";
    }

    // Reference-identity cycle guard: OutputFormatSpec is a record (value equality), so a default
    // HashSet would mis-detect two structurally-equal sibling specs as a cycle. Seed with the root.
    private static HashSet<OutputFormatSpec> NewIdentitySet() =>
        new(ReferenceEqualityComparer.Instance);

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
