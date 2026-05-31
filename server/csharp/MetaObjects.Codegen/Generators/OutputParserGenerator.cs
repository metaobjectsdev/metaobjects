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
// FR-010 tolerant extraction — TWO flavours (Plan 2.1). For `@format: json|xml`
// outputs the parser also emits tolerant best-effort extraction (never throws;
// lost/malformed components are null in a nullable mirror + classified in the
// report):
//   • Self-contained  Extract(string[, ExtractOptions]) — drives a baked
//     ExtractSchema literal + ExtractMap reads. No runtime metadata needed, but
//     does NOT populate nested-object / array-of-object components (those stay
//     null — the historical FR-010 gap). Always emitted for back-compat.
//   • Runtime-delegating  Extract(MetaObject, string[, ExtractOptions]) (+ a
//     Extract(MetaRoot, ...) convenience overload that resolves the baked
//     PAYLOAD_FQN) — delegates to MetaObjects.Codegen.Runtime.ExtractObject,
//     which assembles the FULL nested object graph reflection-free via the Phase
//     A object model, then maps the assembled ValueObject graph into the typed
//     nullable mirror via generated From*Extracted mappers. CLOSES the nested
//     gap. Emitted only when the payload (or a reachable nested VO) has a
//     nested-object / array-of-object field.
//
// ASSEMBLY CONTRACT (delegating extract). ExtractObject is sited in
// MetaObjects.Codegen (it bridges core + Render, which neither can host alone).
// So the GENERATED parser, when compiled in a CONSUMER assembly, references
// MetaObjects.Codegen (ExtractObject) + MetaObjects (core: MetaObject / MetaRoot
// / ValueObject) + MetaObjects.Render (the extract engine) for the delegating
// path. The self-contained ExtractLenient(string) needs only MetaObjects.Render. A
// consumer wanting nested extraction must carry MetaObjects.Codegen on its
// classpath (it transitively brings core + Render).

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Template.TemplateConstants;

namespace MetaObjects.Codegen.Generators;

/// <summary>
/// Emits one parser file per <c>template.output</c> node, with a static class
/// exposing <c>Parse(string)</c> + <c>TryParse(string, out T?, out string?)</c>.
/// </summary>
public sealed class OutputParserGenerator : IGenerator
{
    public string Name => "output-parser-generator";

    public IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var outputs = ctx.Root.OwnChildren()
            .Where(c => c.Type == TYPE_TEMPLATE && c.SubType == TEMPLATE_SUBTYPE_OUTPUT)
            .OrderBy(t => t.Name, StringComparer.Ordinal)
            .ToList();

        var files = new List<EmittedFile>();
        foreach (var tmpl in outputs)
        {
            if (tmpl.OwnAttr(TEMPLATE_ATTR_PAYLOAD_REF) is not string payloadRef)
            {
                // Loader passes treat missing @payloadRef as a load error; defensively skip.
                ctx.Warn($"{Name}: template.output \"{tmpl.Name}\" missing @payloadRef — skipped.");
                continue;
            }
            files.Add(EmitParser(tmpl, payloadRef, ctx));
        }
        return files;
    }

    private static EmittedFile EmitParser(MetaData tmpl, string payloadRef, GenContext ctx)
    {
        var templateName = tmpl.Name;
        var parserClass = $"{templateName}Parser";
        var payloadType = payloadRef;
        var extractedType = $"{payloadType}Extracted";

        // FR-010: emit the tolerant extract() API alongside strict Parse/TryParse when the
        // template targets json/xml AND the @payloadRef resolves to a value-object we can
        // bake a ExtractSchema from. Otherwise only the FR-006 strict parser is emitted.
        var format = tmpl.OwnAttr(TEMPLATE_ATTR_FORMAT) as string ?? "text";
        bool formatSupportsExtract =
            format.Equals("json", StringComparison.OrdinalIgnoreCase) ||
            format.Equals("xml", StringComparison.OrdinalIgnoreCase);
        var vo = ctx.Root.OwnChildren().FirstOrDefault(c => c.Type == TYPE_OBJECT && c.Name == payloadRef);
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

        // FR-010 Plan 2.1: when the payload (or a reachable nested VO) has a nested-object /
        // array-of-object field, additionally emit the runtime-DELEGATING extract overload that
        // closes the nested gap. The self-contained baked ExtractLenient(string) is ALWAYS kept (back-compat,
        // scalar/enum-only). The payload mirror is emitted nested-aware on the delegating path so its
        // one shared <Payload>Extracted type can carry populated nested components.
        bool emitDelegate = emitExtract && ExtractDelegateEmitter.HasNested(vo!, ctx.Root);
        string formatEnum = format.Equals("xml", StringComparison.OrdinalIgnoreCase)
            ? "Format.Xml" : "Format.Json";

        if (emitExtract)
        {
            string schemaLiteral = ExtractSchemaEmitter.SchemaLiteral(vo!, format, payloadType);
            string initializer = ExtractSchemaEmitter.MirrorInitializer(vo!, extractedType);
            sb.AppendLine();
            sb.AppendLine("    // FR-010 tolerant extraction — best-effort, never throws. Returns a nullable");
            sb.AppendLine($"    // mirror (<see cref=\"{extractedType}\"/>) with components null where lost/malformed.");
            sb.AppendLine($"    private static readonly ExtractSchema ExtractSchemaDef = {schemaLiteral};");
            sb.AppendLine();
            sb.AppendLine($"    /// <summary>Self-contained tolerant best-effort extraction of a dirty LLM response; never throws.");
            if (emitDelegate)
                sb.AppendLine($"    /// Does NOT populate nested-object / array-of-object components (those stay null) — use the");
            if (emitDelegate)
                sb.AppendLine($"    /// <see cref=\"ExtractLenient(global::MetaObjects.Meta.MetaObject, string, ExtractOptions)\"/> overload for full nested extraction.</summary>");
            else
                sb.AppendLine($"    /// </summary>");
            sb.AppendLine($"    public static ExtractionResult<{extractedType}> ExtractLenient(string text) =>");
            sb.AppendLine("        ExtractLenient(text, ExtractOptions.Defaults());");
            sb.AppendLine();
            sb.AppendLine($"    /// <summary>Self-contained tolerant extraction with explicit <see cref=\"ExtractOptions\"/>.</summary>");
            sb.AppendLine($"    public static ExtractionResult<{extractedType}> ExtractLenient(string text, ExtractOptions opts)");
            sb.AppendLine("    {");
            sb.AppendLine("        var o = global::MetaObjects.Render.Extract.ExtractEngine.Run(text, ExtractSchemaDef, opts);");
            sb.AppendLine("        var d = o.Data;");
            sb.AppendLine($"        var data = {initializer};");
            sb.AppendLine($"        return new ExtractionResult<{extractedType}>(data, o.Report);");
            sb.AppendLine("    }");
            sb.AppendLine();
            sb.AppendLine("    /// <summary>Extraction as a bool gate: <c>true</c> when the response was non-empty and no required field was lost.</summary>");
            sb.AppendLine($"    public static bool TryExtractLenient(string text, out ExtractionResult<{extractedType}> result)");
            sb.AppendLine("    {");
            sb.AppendLine("        result = ExtractLenient(text);");
            sb.AppendLine("        return !result.Report.IsEmpty && !result.Report.HasLostRequired();");
            sb.AppendLine("    }");

            if (emitDelegate)
                sb.Append(ExtractDelegateEmitter.DelegatingMembers(vo!, ctx.Root, payloadType, extractedType, formatEnum));
        }

        sb.AppendLine("}");

        if (emitExtract)
        {
            sb.AppendLine();
            // On the delegating path the payload mirror is emitted nested-aware (object fields typed
            // as nested mirrors) along with the nested mirror records; otherwise the self-contained
            // payload mirror (object fields -> object?) suffices.
            if (emitDelegate)
                sb.Append(ExtractDelegateEmitter.NestedMirrorRecords(vo!, ctx.Root, extractedType));
            else
                sb.Append(ExtractSchemaEmitter.MirrorRecordDecl(vo!, extractedType));
        }

        return new EmittedFile($"{templateName}.output.cs", sb.ToString());
    }
}
