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
            [FIELD_SUBTYPE_INT]       = "int",
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
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        // Record emission resolves the payload VO by BARE short name (a C# record identifier
        // is always bare, and EmitRecord derives the record name from this same voName).
        root.Children().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == name);

    // ADR-0041: the verify field-tree resolver — a FULLY-QUALIFIED ref (contains ::) resolves
    // EXACTLY on the package-qualified name (ResolutionKey()/Fqn()), never a bare-tail fallback
    // that would bind a same-named object.value in the WRONG package on a cross-package
    // short-name collision. A bare ref matches by short name (first-wins). Kept SEPARATE from
    // FindObject so record emission (bare identifiers) is unaffected. Mirrors the render-helper
    // ResolveNestedObjectRef + Java/Kotlin + TS refMatchesObject.
    private static MetaData? ResolveObjectRef(MetaData root, string reference)
    {
        bool fqn = reference.Contains("::");
        return root.Children().FirstOrDefault(c => c.Type == TYPE_OBJECT &&
            (fqn ? c.ResolutionKey() == reference || c.Fqn() == reference : c.Name == reference));
    }

    // ADR-0039: resolve array-ness through the super chain (isArray is a native
    // property, not an attr; the former OwnAttr("isArray") clause was dead code).
    private static bool IsArrayField(MetaData field) => field.ResolvedIsArray();

    private static (string Type, string? RefVo) FieldType(MetaData owner, MetaData field)
    {
        if (field.SubType == FIELD_SUBTYPE_OBJECT)
        {
            // ADR-0039: resolving — @objectRef may be inherited via extends.
            var refAttr = field.Attr(FIELD_ATTR_OBJECT_REF);
            // @objectRef may be authored fully-qualified (acme::sales::Brief) or bare; the
            // generated record TYPE name is the BARE short name (StripPkg). (The verify
            // field-tree path — BuildTree — resolves the FULL ref FQN-exact via ResolveObjectRef
            // per ADR-0041; record emission here stays bare: one C# type per short name.)
            string refName = refAttr is string s ? CSharpNaming.StripPkg(s) : "object";
            string? refVo = refAttr is string r ? CSharpNaming.StripPkg(r) : null;
            return (IsArrayField(field) ? $"IReadOnlyList<{refName}>" : refName, refVo);
        }
        // Enum payload field -> the generated nested C# enum type (same scheme entity codegen uses
        // via CSharpNaming.EnumTypeName), NOT the `object` fallback. An enum array becomes
        // IReadOnlyList<<EnumType>>; the extract mapper coerces the string mirror via Enum.Parse.
        if (field.SubType == FIELD_SUBTYPE_ENUM)
        {
            string enumType = EnumTypeName(owner, field);
            return (IsArrayField(field) ? $"IReadOnlyList<{enumType}>" : enumType, null);
        }
        var scalar = ScalarType.GetValueOrDefault(field.SubType, "object");
        // Scalar array (e.g. `field.string` with isArray) -> a list of the scalar, mirroring the
        // object-array branch above and the TS payload-codegen reference. Without this a scalar
        // array would collapse to a single scalar (lossy).
        return (IsArrayField(field) ? $"IReadOnlyList<{scalar}>" : scalar, null);
    }

    /// <summary>
    /// The nested C# enum type name for an enum-subtype payload field — the SAME scheme as
    /// <see cref="CSharpNaming.EnumTypeName"/> (the super name when the field <c>extends:</c> an
    /// abstract enum so all extenders share one type, else <c>&lt;OwnerPascal&gt;&lt;FieldPascal&gt;</c>).
    /// PayloadCodegen walks <see cref="MetaData"/>, so the super is resolved off the field node directly.
    /// </summary>
    public static string EnumTypeName(MetaData owner, MetaData field)
    {
        if (field is MetaField mf && mf.ResolveSuper() is { } super)
            return Pascal(super.Name);
        return Pascal(owner.Name) + Pascal(field.Name);
    }

    /// <summary>
    /// Collect nested <c>public enum &lt;Name&gt; { &lt;members&gt; }</c> declarations for the enum
    /// fields of <paramref name="vo"/>, deduped by type name (two fields extending one abstract enum
    /// emit ONE declaration). Mirrors EntityGenerator.CollectEnumDecls; members verbatim.
    /// </summary>
    private static List<string> CollectEnumDecls(MetaData vo)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var decls = new List<string>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD && c.SubType == FIELD_SUBTYPE_ENUM))
        {
            var values = f is MetaField mf ? mf.EffectiveEnumValues : null;
            if (values is null || values.Count == 0) continue;
            var typeName = EnumTypeName(vo, f);
            if (!seen.Add(typeName)) continue;   // dedup shared abstract-enum types
            decls.Add($"    public enum {typeName} {{ {string.Join(", ", values)} }}");
        }
        return decls;
    }

    private static void EmitRecord(MetaData root, string voName, HashSet<string> emitted, List<string> output)
    {
        // A @payloadRef may reach here fully-qualified — ADR-0042 resolves a bare template
        // attr to the FQN form, and MetaData.Attr() returns that resolved (possibly
        // package-qualified) value, not the literal string the author typed. FindObject and
        // the emitted record's own type name both need the bare short name (a C# record
        // identifier can't contain "::" and isn't package-scoped); nested @objectRef fields
        // already arrive here pre-stripped via FieldType's CSharpNaming.StripPkg call, so
        // stripping here is a no-op for them and the fix for the top-level payloadRef case.
        voName = CSharpNaming.StripPkg(voName);
        if (!emitted.Add(voName)) return;
        var vo = FindObject(root, voName);
        if (vo is null) return;

        var lines = new List<string> { $"public sealed record {voName}", "{" };
        // Nested enum declarations first — C# requires an enum type be declared before a
        // property references it (deduped so shared abstract-enum extenders emit one decl).
        lines.AddRange(CollectEnumDecls(vo));
        var refs = new List<string>();
        // Use Children() (effective) so inherited projection fields are included.
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            var (type, refVo) = FieldType(vo, f);
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
    /// into nested element trees. This is the metadata→verify bridge a `dotnet meta verify`
    /// command uses to drift-check a template against its @payloadRef.
    /// </summary>
    public static IReadOnlyList<PayloadField> BuildPayloadFieldTree(MetaData root, string voName) =>
        BuildTree(root, voName, new HashSet<string>(StringComparer.Ordinal));

    private static IReadOnlyList<PayloadField> BuildTree(MetaData root, string voName, HashSet<string> visiting)
    {
        // ADR-0041: FQN-exact resolution for the verify field-tree (NOT the bare FindObject
        // used by record emission) so a fully-qualified nested @objectRef binds its own package.
        var vo = ResolveObjectRef(root, voName);
        if (vo is null || !visiting.Add(voName)) return [];
        var fields = new List<PayloadField>();
        foreach (var f in vo.Children().Where(c => c.Type == TYPE_FIELD))
        {
            // ADR-0039: resolving — @objectRef may be inherited via extends (TS reads f.attr).
            // ADR-0041: pass the FULL (possibly FQN) ref — ResolveObjectRef resolves it exactly.
            if (f.SubType == FIELD_SUBTYPE_OBJECT && f.Attr(FIELD_ATTR_OBJECT_REF) is string refName)
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
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        var tmpl = root.Children()
            .FirstOrDefault(c => c.Type == TYPE_TEMPLATE && c.Name == templateName)
            ?? throw new ArgumentException($"template \"{templateName}\" not found", nameof(templateName));

        // ADR-0039: resolving — template refs may be inherited via an abstract template base.
        var payloadRef = tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) as string
            ?? throw new InvalidOperationException($"template \"{templateName}\" has no @payloadRef");
        var textRef = tmpl.Attr(TEMPLATE_ATTR_TEXT_REF) as string ?? "";
        var format = tmpl.Attr(TEMPLATE_ATTR_FORMAT) as string ?? "text";
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
