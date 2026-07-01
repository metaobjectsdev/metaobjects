// output-parser-generator — for each `template.output` declaration, emits a
// `<TemplateName>.output.cs` file declaring a static `<TemplateName>Parser`
// class with the .NET BCL `Parse`/`TryParse` dual API (ADR-0010). `Parse`
// throws on bad input; `TryParse` returns a bool and an out-error.
//
// The emitted parser RETURNS the payload-VO record already emitted by
// PayloadCodegen (same metadata model). It does NOT redeclare the payload
// shape; this generator emits parser glue only.
//
// Ported from typescript/packages/codegen-ts/src/generators/output-parser-file.ts
// (renderer in typescript/packages/codegen-ts/src/templates/output-parser.ts).
// TS uses Zod; C# uses System.Text.Json + the `required` keyword for
// presence enforcement (.NET 7+). No DataAnnotations / Validator pass —
// `required`-keyword construction + STJ's strict deserialization cover
// presence + type in BCL-native form.
//
// FR-010 tolerant extraction — one metadata-driven path (Plan 2.1). For
// `@format: json|xml` outputs the parser also emits tolerant best-effort
// extraction (never throws; lost/malformed components are null in a nullable
// mirror + classified in the report):
//   • Runtime-delegating  ExtractLenient(MetaObject, string[, ExtractOptions]) (+ an
//     ExtractLenient(MetaRoot, ...) convenience overload that resolves the baked
//     PAYLOAD_FQN) — delegates to MetaObjects.Codegen.Runtime.ExtractObject,
//     which assembles the FULL object graph (nested objects + arrays-of-objects)
//     reflection-free via the Phase A object model by reading the live metadata
//     directly, then maps the assembled ValueObject graph into the typed nullable
//     mirror via generated From*Extracted mappers.
//
// ASSEMBLY CONTRACT (delegating extract). ExtractObject is sited in
// MetaObjects.Codegen (it bridges core + Render, which neither can host alone).
// So the GENERATED parser, when compiled in a CONSUMER assembly, references
// MetaObjects.Codegen (ExtractObject) + MetaObjects (core: MetaObject / MetaRoot
// / ValueObject) + MetaObjects.Render (the extract engine). A consumer using the
// extract API must carry MetaObjects.Codegen on its classpath (it transitively
// brings core + Render).

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Emits one parser file per <c>template.output</c> node, with a static class
/// exposing <c>Parse(string)</c> + <c>TryParse(string, out T?, out string?)</c>.
/// </summary>
public class OutputParserGenerator : IGenerator
{
    public virtual string Name => "output-parser-generator";

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        // ADR-0039: Children() — resolving root scan (a metadata root has no super, so this is
        // behavior-identical, but follows the ADR rule to never rely on "root is never extended").
        var outputs = ctx.Root.Children()
            .Where(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_OUTPUT)
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

        var files = new List<EmittedFile>();
        foreach (var tmpl in outputs)
        {
            if (!AppliesTo(tmpl))
            {
                // ADR-0039: resolving — @payloadRef may be inherited via an abstract template base.
                if (tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is null)
                    ctx.Warn($"{Name}: template.output \"{tmpl.Name}\" missing @payloadRef — skipped.");
                continue;
            }
            var payloadRef = (string)tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF)!;
            files.Add(EmitParser(tmpl, payloadRef, ctx));
        }
        return files;
    }

    /// <summary>
    /// True iff this generator emits an output parser for <paramref name="tmpl"/>: a
    /// <c>template.output</c> carrying a <c>@payloadRef</c> (the strict FR-006 parser is
    /// always emitted; the tolerant extract API layers on for json/xml + a resolvable VO).
    /// Single source of truth shared by the generator loop AND the api-docs builder.
    /// </summary>
    public static bool AppliesTo(MetaData tmpl) =>
        tmpl.Type == TYPE_TEMPLATE && tmpl.SubType == TEMPLATE_SUBTYPE_OUTPUT &&
        // ADR-0039: resolving — @payloadRef may be inherited via an abstract template base.
        tmpl.Attr(TEMPLATE_ATTR_PAYLOAD_REF) is string;

    protected virtual EmittedFile EmitParser(MetaData tmpl, string payloadRef, GenContext ctx)
    {
        var templateName = tmpl.Name;
        var parserClass = CSharpNaming.ParserClassName(templateName);
        // FR-032: @payloadRef is an FQN after the desugar/sweep; the generated C# TYPE
        // NAME is the resolved value-object's bare name (an FQN like "acme::ai::Payload"
        // is not a valid C# identifier). Mirrors RenderHelperGenerator's StripPkg use.
        var payloadType = CSharpNaming.StripPkg(payloadRef);
        var extractedType = $"{payloadType}Extracted";

        // FR-010: emit the tolerant extract() API alongside strict Parse/TryParse when the
        // template targets json/xml AND the @payloadRef resolves to a value-object we can
        // bake a ExtractSchema from. Otherwise only the FR-006 strict parser is emitted.
        // ADR-0039: resolving — @format may be inherited via an abstract template base.
        var format = tmpl.Attr(TEMPLATE_ATTR_FORMAT) as string ?? "text";
        bool formatSupportsExtract =
            format.Equals("json", StringComparison.OrdinalIgnoreCase) ||
            format.Equals("xml", StringComparison.OrdinalIgnoreCase);
        // ADR-0039: Children() — resolving root scan (behavior-identical; root has no super).
        var vo = ctx.Root.Children().FirstOrDefault(c => c.Type == TYPE_OBJECT && CSharpNaming.StripPkg(c.Name) == payloadType);
        bool emitExtract = formatSupportsExtract && vo is not null;

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects output-parser-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        sb.AppendLine("using System.Diagnostics.CodeAnalysis;");
        sb.AppendLine("using System.Text.Json;");
        if (emitExtract) sb.AppendLine("using MetaObjects.Render.Extract;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"/// <summary>Parser for LLM responses matching the <c>{templateName}</c> template.output.</summary>");
        sb.AppendLine($"public static class {parserClass}");
        sb.AppendLine("{");
        sb.AppendLine("    private static readonly JsonSerializerOptions Options = new()");
        sb.AppendLine("    {");
        // Case-sensitive (default) — the payload-VO property names are emitted as
        // the exact metadata field names (typically camelCase), which matches the
        // JSON the LLM is expected to produce.
        sb.AppendLine("        PropertyNameCaseInsensitive = false,");
        sb.AppendLine("    };");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Parse an LLM response into a typed <see cref=\"{payloadType}\"/>.</summary>");
        sb.AppendLine($"    /// <param name=\"text\">The raw response text — expected to be JSON.</param>");
        sb.AppendLine("    /// <returns>The deserialized, validated payload.</returns>");
        sb.AppendLine("    /// <exception cref=\"JsonException\">JSON is malformed, missing a <c>required</c> property, or has a type mismatch.</exception>");
        sb.AppendLine($"    public static {payloadType} Parse(string text) =>");
        sb.AppendLine($"        JsonSerializer.Deserialize<{payloadType}>(text, Options)");
        sb.AppendLine($"            ?? throw new JsonException(\"deserialized to null\");");
        sb.AppendLine();
        sb.AppendLine($"    /// <summary>Parse with explicit error handling — does not throw on validation failure.</summary>");
        sb.AppendLine("    /// <param name=\"text\">The raw response text — expected to be JSON.</param>");
        sb.AppendLine("    /// <param name=\"value\">On success, the deserialized payload; otherwise null.</param>");
        sb.AppendLine("    /// <param name=\"error\">On failure, a human-readable error message; otherwise null.</param>");
        sb.AppendLine("    /// <returns><c>true</c> on success; <c>false</c> on validation failure.</returns>");
        sb.AppendLine($"    public static bool TryParse(string text, [NotNullWhen(true)] out {payloadType}? value, [NotNullWhen(false)] out string? error)");
        sb.AppendLine("    {");
        sb.AppendLine("        try");
        sb.AppendLine("        {");
        sb.AppendLine("            value = Parse(text);");
        sb.AppendLine("            error = null;");
        sb.AppendLine("            return true;");
        sb.AppendLine("        }");
        sb.AppendLine("        catch (JsonException ex)");
        sb.AppendLine("        {");
        sb.AppendLine("            value = null;");
        sb.AppendLine("            error = ex.Message;");
        sb.AppendLine("            return false;");
        sb.AppendLine("        }");
        sb.AppendLine("    }");

        // FR-010: for json|xml outputs, emit the single metadata-driven extract path — the
        // runtime-DELEGATING ExtractLenient(MetaObject/MetaRoot, text) overloads (delegating to
        // MetaObjects.Codegen.Runtime.ExtractObject, which assembles the full object graph
        // reflection-free by reading the live metadata directly), plus the nested-aware nullable
        // mirror records + mappers. No baked ExtractSchema snapshot.
        string formatEnum = format.Equals("xml", StringComparison.OrdinalIgnoreCase)
            ? "Format.Xml" : "Format.Json";

        if (emitExtract)
            sb.Append(ExtractDelegateEmitter.DelegatingMembers(vo!, ctx.Root, payloadType, extractedType, formatEnum));

        sb.AppendLine("}");

        if (emitExtract)
        {
            sb.AppendLine();
            // The payload mirror is emitted nested-aware (object fields typed as nested mirrors)
            // along with every reachable nested mirror record.
            sb.Append(ExtractDelegateEmitter.NestedMirrorRecords(vo!, ctx.Root, extractedType));
        }

        return new EmittedFile($"{templateName}.output.cs", sb.ToString());
    }
}
