// output-parser-generator — for each responding `template.prompt` (one carrying
// `@responseRef`), emits a `<PromptName>.response.cs` file declaring a static
// `<PromptName>Parser` class with the .NET BCL `Parse`/`TryParse` dual API
// (ADR-0010). `Parse` throws on bad input; `TryParse` returns a bool and an
// out-error.
//
// ADR-0052 — this tier is INBOUND: it reads a model's REPLY. It used to key on
// `template.output` with no format filter at all, so an email template generated
// a JSON parser for text the system had just rendered. `template.output` is
// outbound only and emits nothing here.
//
// The emitted parser RETURNS the RESPONSE-VO record emitted by PayloadCodegen
// from the same `@responseRef` (never the `@payloadRef` record, which types the
// REQUEST this prompt renders outbound). It does NOT redeclare the shape; this
// generator emits parser glue only.
//
// Ported from typescript/packages/codegen-ts/src/generators/output-parser-file.ts
// (renderer in typescript/packages/codegen-ts/src/templates/output-parser.ts).
// TS uses Zod; C# uses System.Text.Json + the `required` keyword for
// presence enforcement (.NET 7+). No DataAnnotations / Validator pass —
// `required`-keyword construction + STJ's strict deserialization cover
// presence + type in BCL-native form.
//
// FR-010 tolerant extraction — one metadata-driven path (Plan 2.1). Every
// responding prompt also emits tolerant best-effort extraction (never throws;
// lost/malformed components are null in a nullable mirror + classified in the
// report). ADR-0052: unconditional — a declared `@responseRef` IS the request
// for the tolerant path, and `@responseFormat` is a closed json|xml set, so
// there is no third case left to gate on:
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
/// Emits one response-parser file per responding <c>template.prompt</c>, with a static class
/// exposing <c>Parse(string)</c> + <c>TryParse(string, out T?, out string?)</c>.
/// </summary>
public class OutputParserGenerator : IGenerator
{
    public virtual string Name => "output-parser-generator";

    public virtual IEnumerable<EmittedFile> Generate(GenContext ctx)
    {
        var files = new List<EmittedFile>();
        // ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        foreach (var tmpl in FindInbound.InboundTemplates(ctx.Root))
        {
            // ADR-0039: resolving — @responseRef may be inherited via an abstract template base.
            var responseRef = (string)tmpl.Attr(TEMPLATE_ATTR_RESPONSE_REF)!;
            files.Add(EmitParser(tmpl, responseRef, ctx));
        }
        return files;
    }

    /// <summary>
    /// True iff this generator emits a response parser for <paramref name="tmpl"/>: a
    /// <c>template.prompt</c> carrying a <c>@responseRef</c>. Single source of truth shared by
    /// the generator loop AND the api-docs builder.
    /// </summary>
    public static bool AppliesTo(MetaData tmpl) =>
        tmpl.Type == TYPE_TEMPLATE && tmpl.SubType == TEMPLATE_SUBTYPE_PROMPT &&
        // ADR-0039: resolving — @responseRef may be inherited via an abstract template base.
        tmpl.Attr(TEMPLATE_ATTR_RESPONSE_REF) is string;

    protected virtual EmittedFile EmitParser(MetaData tmpl, string responseRef, GenContext ctx)
    {
        var templateName = tmpl.Name;
        var parserClass = CSharpNaming.ParserClassName(templateName);
        // ADR-0052: the shape parsed INTO is @responseRef — the reply — never @payloadRef,
        // which types the request this prompt renders outbound.
        var payloadRef = responseRef;

        // ADR-0042/#228: resolve @payloadRef package-aware — never a bare-tail/global-scan
        // fallback that could bind the WRONG package's same-short-named object under a
        // cross-package collision (the #219/#244 "wrong node" class). The loader validates
        // @payloadRef through this SAME canonical resolver; codegen must never silently walk
        // a DIFFERENT node than what was validated.
        var referrerPkg = global::MetaObjects.NamingRefs.EffectivePackage(tmpl);
        var vo = global::MetaObjects.NamingRefs.ResolveObjectRef(ctx.Root, payloadRef, referrerPkg);
        // FR-032/ADR-0044: @payloadRef may be an FQN after the desugar/sweep; the generated C#
        // TYPE NAME is PayloadCodegen's OWN emitted name for the resolved VO — bare unless its
        // within-closure short name collides (never a raw StripPkg of the possibly-FQN attribute
        // string, which would diverge from the ACTUAL record PayloadGenerator/PayloadCodegen
        // emits under a collision). Falls back to StripPkg only when payloadRef is unresolvable
        // (mirrors the pre-#228 permissive behavior for a dangling/malformed @payloadRef).
        var payloadType = PayloadCodegen.ResolveEmittedName(ctx.Root, payloadRef, referrerPkg)
            ?? CSharpNaming.StripPkg(payloadRef);
        var extractedType = $"{payloadType}Extracted";

        // ADR-0053: the reply's syntax is @responseFormat (json|xml, default json) — never
        // @format, which is the syntax of the rendered prompt BODY. The old @format gate is
        // what made a text-bodied prompt with a JSON reply emit a strict parser and no
        // extract at all.
        var format = FindInbound.ResponseFormatOf(tmpl);
        bool emitExtract = vo is not null;

        // The strict Parse/TryParse tier is JSON-ONLY, by construction.
        //
        // Its body is `JsonSerializer.Deserialize<T>`, and there is no XML equivalent worth
        // generating. Not because no XML reader exists — MetaObjects.Render ships a forgiving
        // one — but because strict all-or-nothing semantics layered over a REPAIRING parser is
        // incoherent: it would throw or accept based on how much repair happened, which is not
        // a contract anyone can reason about. Before ADR-0052 an XML template got
        // `JsonSerializer.Deserialize` anyway — a generated method that could never work.
        //
        // So an XML reply gets the tolerant extract and nothing strict. Its typed shape is
        // `<Name>Extracted` — a nullable mirror, the honest type for a best-effort parse.
        bool emitStrict = !FindInbound.IsXml(format);

        var sb = new StringBuilder();
        sb.AppendLine("// <auto-generated/>");
        sb.AppendLine("// Generated by MetaObjects output-parser-generator. Do not edit by hand.");
        sb.AppendLine("#nullable enable");
        sb.AppendLine("using System;");
        sb.AppendLine("using System.Collections.Generic;");
        if (emitStrict) sb.AppendLine("using System.Diagnostics.CodeAnalysis;");
        if (emitStrict) sb.AppendLine("using System.Text.Json;");
        if (emitExtract) sb.AppendLine("using MetaObjects.Render.Extract;");
        sb.AppendLine();
        sb.AppendLine($"namespace {ctx.Config.Namespace};");
        sb.AppendLine();
        sb.AppendLine($"/// <summary>Parser for LLM responses matching the <c>{templateName}</c> template.prompt.</summary>");
        sb.AppendLine($"public static class {parserClass}");
        sb.AppendLine("{");
        if (emitStrict)
        {
            sb.AppendLine("    private static readonly JsonSerializerOptions Options = new()");
            sb.AppendLine("    {");
            // Case-sensitive (default) — the response-VO property names are emitted as
            // the exact metadata field names (typically camelCase), which matches the
            // JSON the LLM is expected to produce.
            sb.AppendLine("        PropertyNameCaseInsensitive = false,");
            sb.AppendLine("    };");
            sb.AppendLine();
            sb.AppendLine($"    /// <summary>Parse an LLM response into a typed <see cref=\"{payloadType}\"/>.</summary>");
            sb.AppendLine($"    /// <param name=\"text\">The raw response text — expected to be JSON.</param>");
            sb.AppendLine("    /// <returns>The deserialized, validated response.</returns>");
            sb.AppendLine("    /// <exception cref=\"JsonException\">JSON is malformed, missing a <c>required</c> property, or has a type mismatch.</exception>");
            sb.AppendLine($"    public static {payloadType} Parse(string text) =>");
            sb.AppendLine($"        JsonSerializer.Deserialize<{payloadType}>(text, Options)");
            sb.AppendLine($"            ?? throw new JsonException(\"deserialized to null\");");
            sb.AppendLine();
            sb.AppendLine($"    /// <summary>Parse with explicit error handling — does not throw on validation failure.</summary>");
            sb.AppendLine("    /// <param name=\"text\">The raw response text — expected to be JSON.</param>");
            sb.AppendLine("    /// <param name=\"value\">On success, the deserialized response; otherwise null.</param>");
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
        }

        // FR-010: emit the single metadata-driven extract path — the runtime-DELEGATING
        // ExtractLenient(MetaObject/MetaRoot, text) overloads (delegating to
        // MetaObjects.Codegen.Runtime.ExtractObject, which assembles the full object graph
        // reflection-free by reading the live metadata directly), plus the nested-aware nullable
        // mirror records + mappers. No baked ExtractSchema snapshot.
        string formatEnum = FindInbound.IsXml(format) ? "Format.Xml" : "Format.Json";

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

        // ADR-0052 D4: the artifact name follows the DIRECTION axis. A parser file named
        // `.output.cs` generated from a prompt reproduces the confusion being removed.
        return new EmittedFile($"{templateName}.response.cs", sb.ToString());
    }
}
