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
// ADR-0056: the emitted parser RETURNS the `@responseRef` value object's own POCO,
// the one EntityGenerator emits (never the `@payloadRef` object, which types the
// REQUEST this prompt renders outbound). It declares no type for the shape, so a
// run that wires it must also wire EntityGenerator (`entity`). The one type it
// does own is the value object's all-nullable mirror (`<Vo>Extracted`), and that
// is keyed by the value object: emitted ONCE per run, in the value object's own
// namespace, however many prompts parse into it.
//
// Ported from typescript/packages/codegen-ts/src/generators/output-parser-file.ts
// (renderer in typescript/packages/codegen-ts/src/templates/output-parser.ts).
// TS uses Zod; C# uses System.Text.Json. Presence is enforced by a generated
// JsonTypeInfo modifier that marks each @required field required (the POCO's
// members are shared with the REST tier, so they cannot carry the `required`
// keyword themselves), and enums travel as their member symbols.
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

using MetaObjects.Codegen.Writer;
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
        // ADR-0056 rule 3: each mirrored value object's <Vo>Extracted record is emitted ONCE per
        // run, in its own namespace — so two prompts parsing into one shape share it, and where it
        // lands never depends on which prompt came first.
        var mirrored = new Dictionary<string, MetaData>(StringComparer.Ordinal);
        // ADR-0052: the direction rule lives in FindInbound, never re-derived here.
        foreach (var tmpl in FindInbound.InboundTemplates(ctx.Root))
        {
            // Skip on RESOLUTION, not just presence. InboundTemplates filters on @responseRef
            // presence (it has no root to resolve against), so this loop is the only place the
            // ref's target is checked — and it was not checking. A @responseRef naming an
            // object.entity therefore emitted `static Answer Parse(string)` naming a type no
            // value-object generator declares: CS0246. Every sibling inbound
            // generator already skipped on ResponseShape; this one alone did not.
            if (FindInbound.ResponseShape(ctx.Root, tmpl) is not { } shape) continue;
            files.Add(EmitParser(tmpl, shape.Ref, ctx));
            foreach (var vo in ExtractDelegateEmitter.MirrorClosure(shape.Vo, ctx.Root))
                mirrored.TryAdd(vo.ResolutionKey(), vo);
        }
        foreach (var vo in mirrored.Values)
            files.Add(ExtractDelegateEmitter.MirrorFile(vo, ctx.Root, ctx.Config));
        return files;
    }

    /// <summary>
    /// True iff this generator emits a response parser for <paramref name="tmpl"/>: a
    /// <c>template.prompt</c> carrying a <c>@responseRef</c>. Single source of truth shared by
    /// the generator loop AND the api-docs builder.
    /// </summary>
    public static bool AppliesTo(MetaData tmpl, MetaRoot root) => FindInbound.IsInbound(tmpl, root);

    protected virtual EmittedFile EmitParser(MetaData tmpl, string responseRef, GenContext ctx)
    {
        var templateName = tmpl.Name;
        var parserClass = CSharpNaming.ParserClassName(templateName);
        ctx.Claim($"the C# namespace {ctx.Config.Namespace}", parserClass, tmpl.ResolutionKey(), "rename one (an output parser is declared in the configured namespace, GenConfig.Namespace, whatever its package, "
            + "so the two packages do not keep them apart)");
        // ADR-0052: the shape parsed INTO is @responseRef — the reply — never @payloadRef,
        // which types the request this prompt renders outbound.
        var payloadRef = responseRef;

        // ADR-0042/#228: resolve @payloadRef package-aware — never a bare-tail/global-scan
        // fallback that could bind the WRONG package's same-short-named object under a
        // cross-package collision (the #219/#244 "wrong node" class). The loader validates
        // @payloadRef through this SAME canonical resolver; codegen must never silently walk
        // a DIFFERENT node than what was validated.
        var vo = global::MetaObjects.NamingRefs.RefTarget(tmpl, TEMPLATE_ATTR_RESPONSE_REF);
        // ADR-0056: the parsed type IS the value object's own POCO, named the way every generator
        // names it (never the raw ref string, which may be an FQN).
        var ns = ctx.Config.Namespace;
        var payloadType = vo is not null
            ? ValueObjectNames.TypeRef(vo, ctx.Root, ctx.Config, ns)
            : CSharpNaming.StripPkg(payloadRef);

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

        var required = emitStrict && vo is not null ? RequiredFields(vo, ctx) : [];

        var w = NewWriter();
        WriteFileHeader(w, emitStrict, requiredFields: required.Count > 0, emitExtract);
        w.Blank();
        w.Line($"namespace {ns};");
        w.Blank();
        w.Line($"/// <summary>Parser for LLM responses matching the <c>{templateName}</c> template.prompt.</summary>");
        using (w.Braced($"public static class {parserClass}"))
        {
            if (emitStrict)
            {
                WriteOptions(w, required);
                w.Blank();
                if (required.Count > 0)
                {
                    WriteRequireDeclaredFields(w, required);
                    w.Blank();
                }
                WriteParse(w, payloadType);
                w.Blank();
                WriteTryParse(w, payloadType);
            }

            // FR-010: emit the single metadata-driven extract path — the runtime-DELEGATING
            // ExtractLenient(MetaObject/MetaRoot, text) overloads (delegating to
            // MetaObjects.Codegen.Runtime.ExtractObject, which assembles the full object graph
            // reflection-free by reading the live metadata directly) and the mappers into the
            // value objects' mirrors. The mirror records themselves are emitted once per run
            // (see Generate). No baked ExtractSchema snapshot.
            string formatEnum = FindInbound.IsXml(format) ? "Format.Xml" : "Format.Json";

            if (emitExtract)
                WriteExtract(w, vo!, ctx, ns, formatEnum);
        }

        // ADR-0052 D4: the artifact name follows the DIRECTION axis. A parser file named
        // `.output.cs` generated from a prompt reproduces the confusion being removed.
        return new EmittedFile(OutputPaths.Of(tmpl, ctx, $"{templateName}.response.cs"), w.ToString());
    }

    // The pieces of the file, one overridable method each (ADR-0063 item 7): a subclass changes the
    // piece it wants and keeps the rest. Not a stability contract.

    /// <summary>The writer the file is written on.</summary>
    protected virtual CsWriter NewWriter() => new();

    /// <summary>The generated-file marker, the nullable context and the usings the file needs.</summary>
    protected virtual void WriteFileHeader(CsWriter w, bool strict, bool requiredFields, bool extract)
    {
        w.GeneratedFileHeader("output-parser-generator");
        w.Using("System");
        w.Using("System.Collections.Generic");
        if (strict)
        {
            w.Using("System.Diagnostics.CodeAnalysis");
            w.Using("System.Text.Json");
            w.Using("System.Text.Json.Serialization");
        }
        if (requiredFields) w.Using("System.Text.Json.Serialization.Metadata");
        if (extract) w.Using("MetaObjects.Render.Extract");
    }

    /// <summary>The strict tier's <c>JsonSerializerOptions</c>.</summary>
    protected virtual void WriteOptions(CsWriter w, IReadOnlyList<(string Type, List<string> Names)> required)
    {
        using (w.Braced("private static readonly JsonSerializerOptions Options = new()", "};"))
        {
            // Case-sensitive (default) — every value-object POCO member carries its metadata
            // field name in [JsonPropertyName], which is the key the model is asked to produce.
            w.Line("PropertyNameCaseInsensitive = false,");
            // A field.enum travels as its member symbol, as the output-format prompt says.
            w.Line("Converters = { new JsonStringEnumConverter() },");
            if (required.Count > 0)
                w.Line("TypeInfoResolver = new DefaultJsonTypeInfoResolver { Modifiers = { RequireDeclaredFields } },");
        }
    }

    /// <summary>The type-info modifier that marks each <c>@required</c> field required.</summary>
    protected virtual void WriteRequireDeclaredFields(CsWriter w, IReadOnlyList<(string Type, List<string> Names)> required)
    {
        w.Line("/// <summary>A reply that omits a <c>@required</c> field fails to parse. The value-object POCOs");
        w.Line("/// cannot say so themselves: their members are shared with the REST tier, where presence is a");
        w.Line("/// validation concern.</summary>");
        using (w.Braced("private static void RequireDeclaredFields(JsonTypeInfo info)"))
        {
            w.Line("string[]? required =");
            using (w.Hanging())
            {
                foreach (var (type, names) in required)
                    w.Line($"info.Type == typeof({type}) ? new[] {{ {string.Join(", ", names.Select(n => $"\"{n}\""))} }} :");
                w.Line("null;");
            }
            w.Line("if (required is null) return;");
            w.Line("foreach (var p in info.Properties)");
            using (w.Hanging()) w.Line("if (Array.IndexOf(required, p.Name) >= 0) p.IsRequired = true;");
        }
    }

    /// <summary>The throwing <c>Parse</c>.</summary>
    protected virtual void WriteParse(CsWriter w, string payloadType)
    {
        w.Line($"/// <summary>Parse an LLM response into a typed <see cref=\"{payloadType}\"/>.</summary>");
        w.Line($"/// <param name=\"text\">The raw response text — expected to be JSON.</param>");
        w.Line("/// <returns>The deserialized, validated response.</returns>");
        w.Line("/// <exception cref=\"JsonException\">JSON is malformed, missing a <c>required</c> property, or has a type mismatch.</exception>");
        w.Line($"public static {payloadType} Parse(string text) =>");
        using (w.Hanging())
        {
            w.Line($"JsonSerializer.Deserialize<{payloadType}>(text, Options)");
            using (w.Hanging()) w.Line($"?? throw new JsonException(\"deserialized to null\");");
        }
    }

    /// <summary>The non-throwing <c>TryParse</c>.</summary>
    protected virtual void WriteTryParse(CsWriter w, string payloadType)
    {
        w.Line($"/// <summary>Parse with explicit error handling — does not throw on validation failure.</summary>");
        w.Line("/// <param name=\"text\">The raw response text — expected to be JSON.</param>");
        w.Line("/// <param name=\"value\">On success, the deserialized response; otherwise null.</param>");
        w.Line("/// <param name=\"error\">On failure, a human-readable error message; otherwise null.</param>");
        w.Line("/// <returns><c>true</c> on success; <c>false</c> on validation failure.</returns>");
        using (w.Braced($"public static bool TryParse(string text, [NotNullWhen(true)] out {payloadType}? value, [NotNullWhen(false)] out string? error)"))
        {
            using (w.Braced("try"))
            {
                w.Line("value = Parse(text);");
                w.Line("error = null;");
                w.Line("return true;");
            }
            using (w.Braced("catch (JsonException ex)"))
            {
                w.Line("value = null;");
                w.Line("error = ex.Message;");
                w.Line("return false;");
            }
        }
    }

    /// <summary>The runtime-delegating <c>ExtractLenient</c> members and their mappers.</summary>
    protected virtual void WriteExtract(CsWriter w, MetaData vo, GenContext ctx, string ns, string formatEnum) =>
        ExtractDelegateEmitter.WriteDelegatingMembers(w, vo, ctx.Root, ctx.Config, ns, formatEnum);

    /// <summary>
    /// The <c>@required</c> fields of every value object the strict parse decodes — the response
    /// value object and each one nested under it — as (type reference, JSON names) pairs. Value
    /// objects with no required field are omitted.
    /// </summary>
    private static List<(string Type, List<string> Names)> RequiredFields(MetaData vo, GenContext ctx) =>
        ExtractDelegateEmitter.MirrorClosure(vo, ctx.Root)
            .Select(v => (
                Type: ValueObjectNames.TypeRef(v, ctx.Root, ctx.Config, ctx.Config.Namespace),
                Names: Fr010FieldMapping.Fields(v).Where(Fr010FieldMapping.IsRequired).Select(f => f.Name).ToList()))
            .Where(r => r.Names.Count > 0)
            .ToList();
}
