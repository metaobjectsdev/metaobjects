// Payload-type + render-handle codegen for prompt construction (FR-004 Plan #3, B).
//
// Emits the TYPED PAYLOAD as an idiomatic C# record (no runtime ValueObject; the
// render engine consumes the record's properties, and the record type gives the
// caller-side compile-time guarantee) plus a typed render handle. Property names
// are kept as the exact metadata field names so the render engine resolves
// `{{field}}` against the record.
//
// Ported from typescript/packages/codegen-ts/src/payload-codegen.ts. The
// assembler (RDB materialization + host overlay) is out of scope — this only
// emits the contract.

using System.Text;
using MetaObjects.Meta;
using MetaObjects.Render;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen;

/// <summary>Emits typed payload records + render handles from view-object / template metadata.</summary>
public static class PayloadCodegen
{
    // Field subtype -> idiomatic C# scalar type. Mirrors the TS SCALAR map
    // (number split into int/long/double; dates are ISO strings on the wire).
    private static readonly IReadOnlyDictionary<string, string> ScalarType =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [FIELD_SUBTYPE_STRING]    = "string",
            [FIELD_SUBTYPE_CLASS]     = "string",
            [FIELD_SUBTYPE_INT]       = "int",
            [FIELD_SUBTYPE_SHORT]     = "int",
            [FIELD_SUBTYPE_BYTE]      = "int",
            [FIELD_SUBTYPE_LONG]      = "long",
            [FIELD_SUBTYPE_CURRENCY]  = "long",
            [FIELD_SUBTYPE_DOUBLE]    = "double",
            [FIELD_SUBTYPE_FLOAT]     = "double",
            [FIELD_SUBTYPE_DECIMAL]   = "double",
            [FIELD_SUBTYPE_BOOLEAN]   = "bool",
            [FIELD_SUBTYPE_DATE]      = "string",
            [FIELD_SUBTYPE_TIME]      = "string",
            [FIELD_SUBTYPE_TIMESTAMP] = "string",
        };

    private static MetaData? FindObject(MetaData root, string name) =>
        root.OwnChildren().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == name);

    private static bool IsArrayField(MetaData field) =>
        field.OwnAttr(RESERVED_KEY_IS_ARRAY) is true || field.IsArray;

    private static (string Type, string? RefVo) FieldType(MetaData field)
    {
        if (field.SubType == FIELD_SUBTYPE_OBJECT)
        {
            var refAttr = field.OwnAttr(FIELD_ATTR_OBJECT_REF);
            string refName = refAttr is string s ? s : "object";
            string? refVo = refAttr is string r ? r : null;
            return (IsArrayField(field) ? $"IReadOnlyList<{refName}>" : refName, refVo);
        }
        var scalar = ScalarType.GetValueOrDefault(field.SubType, "object");
        // Scalar array (e.g. `field.string` with isArray) -> a list of the scalar, mirroring the
        // object-array branch above and the TS payload-codegen reference. Without this a scalar
        // array would collapse to a single scalar (lossy).
        return (IsArrayField(field) ? $"IReadOnlyList<{scalar}>" : scalar, null);
    }

    private static void EmitRecord(MetaData root, string voName, HashSet<string> emitted, List<string> output)
    {
        if (!emitted.Add(voName)) return;
        var vo = FindObject(root, voName);
        if (vo is null) return;

        var lines = new List<string> { $"public sealed record {voName}", "{" };
        var refs = new List<string>();
        // Use Children() (effective) so inherited projection fields are included.
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            var (type, refVo) = FieldType(f);
            lines.Add($"    public required {type} {f.Name} {{ get; init; }}");
            if (refVo is not null) refs.Add(refVo);
        }
        lines.Add("}");
        output.Add(string.Join("\n", lines));

        foreach (var r in refs) EmitRecord(root, r, emitted, output);
    }

    /// <summary>
    /// Emit the payload record (+ nested element records) for an object.value view-object.
    /// </summary>
    public static string GeneratePayloadRecords(MetaData root, string voName)
    {
        var output = new List<string>();
        EmitRecord(root, voName, new HashSet<string>(StringComparer.Ordinal), output);
        return string.Join("\n\n", output) + "\n";
    }

    /// <summary>
    /// Derive the verify field tree (the input to <c>Verify.Check</c>) from an
    /// object.value view-object: scalars become leaves, object-ref fields recurse
    /// into nested element trees. This is the metadata→verify bridge a `meta verify`
    /// command uses to drift-check a template against its @payloadRef.
    /// </summary>
    public static IReadOnlyList<PayloadField> BuildPayloadFieldTree(MetaData root, string voName) =>
        BuildTree(root, voName, new HashSet<string>(StringComparer.Ordinal));

    private static IReadOnlyList<PayloadField> BuildTree(MetaData root, string voName, HashSet<string> visiting)
    {
        var vo = FindObject(root, voName);
        if (vo is null || !visiting.Add(voName)) return [];
        var fields = new List<PayloadField>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            if (f.SubType == FIELD_SUBTYPE_OBJECT && f.OwnAttr(FIELD_ATTR_OBJECT_REF) is string refName)
                fields.Add(new PayloadField(f.Name, BuildTree(root, refName, visiting)));
            else
                fields.Add(new PayloadField(f.Name));
        }
        visiting.Remove(voName);
        return fields;
    }

    private static string Pascal(string s) =>
        s.Length > 0 ? char.ToUpperInvariant(s[0]) + s[1..] : s;

    /// <summary>
    /// Emit a typed render handle binding a template's @textRef + @format and typing
    /// its payload to the @payloadRef record. The generated code's only MetaObjects
    /// dependency is MetaObjects.Render (framework philosophy: generated code is
    /// idiomatic and runtime-light).
    /// </summary>
    public static string GenerateRenderHandle(MetaData root, string templateName)
    {
        var tmpl = root.OwnChildren()
            .FirstOrDefault(c => c.Type == TYPE_TEMPLATE && c.Name == templateName)
            ?? throw new ArgumentException($"template \"{templateName}\" not found", nameof(templateName));

        var payloadRef = tmpl.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF) as string
            ?? throw new InvalidOperationException($"template \"{templateName}\" has no @payloadRef");
        var textRef = tmpl.OwnAttr(TEMPLATE_ATTR_TEXT_REF) as string ?? "";
        var format = tmpl.OwnAttr(TEMPLATE_ATTR_FORMAT) as string ?? "text";
        var fn = $"Render{Pascal(templateName)}";

        var sb = new StringBuilder();
        sb.AppendLine("using MetaObjects.Render;");
        sb.AppendLine();
        sb.AppendLine("public static class RenderHandles");
        sb.AppendLine("{");
        sb.AppendLine($"    public static string {fn}({payloadRef} payload, IProvider provider) =>");
        sb.AppendLine("        Renderer.Render(new RenderRequest");
        sb.AppendLine("        {");
        sb.AppendLine($"            Ref = {Quote(textRef)},");
        sb.AppendLine("            Payload = payload,");
        sb.AppendLine($"            Format = {Quote(format)},");
        sb.AppendLine("            Provider = provider,");
        sb.AppendLine("        });");
        sb.AppendLine("}");
        return sb.ToString();
    }

    private static string Quote(string s) => "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
}
