using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// FR-010 codegen: the tolerant extract() API on OutputParserGenerator + the OutputPromptGenerator.
/// The headline is a compile-AND-RUN proof — generated parser + nullable mirror + payload + prompt
/// are compiled together with the render engine via Roslyn, then Extract()/RenderFormat() are
/// invoked by reflection. This is the gold-standard that catches codegen bugs string-assertions miss.
/// </summary>
public sealed class Fr010CodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "AnswerPayload", "children": [
        { "field.string": { "name": "text", "@required": true,
            "@example": "Your refund will appear in 3-5 days.",
            "@instruction": "One or two sentences to the customer." } },
        { "field.enum": { "name": "confidence", "@required": true,
            "@values": ["HIGH","OK","LOW"],
            "@enumAlias": { "medium": "OK" },
            "@enumDoc": { "HIGH": "Directly supported.", "OK": "Inference.", "LOW": "A guess." } } },
        { "field.int": { "name": "score" } },
        { "field.string": { "name": "note" } },
        { "field.string": { "name": "tags", "isArray": true } }
      ]}},
      { "template.prompt": { "name": "AnswerOutput", "@payloadRef": "AnswerPayload", "@responseRef": "AnswerPayload",
          "@textRef": "ai/answer", "@format": "text", "@responseFormat": "json", "@promptStyle": "guide" } }
    ]}}
    """;

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "outputs.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // ---- emission shape ----

    [Fact]
    public void Parser_emits_extract_api_and_nullable_mirror_for_json()
    {
        var src = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(Model)))).Content;

        Assert.Contains("using MetaObjects.Render.Extract;", src);
        // The single (loader-delegating) extract path — no baked snapshot.
        Assert.Contains("public const string PAYLOAD_FQN = \"AnswerPayload\";", src);
        Assert.Contains("global::MetaObjects.Meta.MetaObject mo, string text, ExtractOptions? opts = null)", src);
        Assert.Contains("global::MetaObjects.Meta.MetaRoot root, string text, ExtractOptions? opts = null)", src);
        Assert.Contains("global::MetaObjects.Codegen.Runtime.ExtractObject.Extract(mo, text, Format.Json, opts)", src);
        Assert.DoesNotContain("ExtractSchemaDef", src);
        Assert.DoesNotContain("FieldSpec.", src);
        Assert.DoesNotContain("ExtractLenient(string text)", src);
        Assert.DoesNotContain("TryExtractLenient", src);

        // Nullable mirror record — no `required`, every component nullable.
        Assert.Contains("public sealed record AnswerPayloadExtracted", src);
        Assert.Contains("public string? text { get; init; }", src);
        Assert.Contains("public string? confidence { get; init; }", src);
        Assert.Contains("public int? score { get; init; }", src);
        // Array field: nullable-element list matching ExtractMap.AsStringList's return type.
        Assert.Contains("global::System.Collections.Generic.IReadOnlyList<string?>? tags { get; init; }", src);
        Assert.DoesNotContain("required", src.Split("AnswerPayloadExtracted")[1]); // mirror half has no required
    }

    [Fact]
    public void Parser_emits_extract_for_a_text_bodied_prompt_with_a_json_reply()
    {
        // ADR-0052/0053, and the reason the ADR exists. This shape — a plain-text prompt
        // BODY eliciting a JSON REPLY — is the common case, and the old design could not
        // express it: the tier gated the tolerant extract on @format, the body's syntax,
        // so this template got a strict parser and NO extract at all. @responseFormat now
        // carries the reply's syntax (defaulting to json), and @responseRef presence alone
        // decides that there is an inbound half.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "P", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.prompt": { "name": "TextOut", "@payloadRef": "P", "@responseRef": "P", "@textRef": "t/x", "@format": "text" } }
        ]}}
        """;
        var src = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(m)))).Content;
        Assert.Contains("Parse(string text)", src);      // strict tier: the reply is json
        Assert.Contains("ExtractLenient(", src);          // tolerant tier: now unconditional
        Assert.Contains("Extracted", src);
        Assert.Contains("Format.Json", src);              // from @responseFormat's default
    }

    [Fact]
    public void Prompt_generator_emits_render_format_pair()
    {
        var file = Assert.Single(new OutputPromptGenerator().Generate(Ctx(Load(Model))));
        Assert.Equal("AnswerOutput.responseFormat.cs", file.Path);
        var src = file.Content;
        Assert.Contains("public static class AnswerOutputResponseFormat", src);
        Assert.Contains("private static readonly OutputFormatSpec Spec = new OutputFormatSpec(Format.Json, \"AnswerPayload\", PromptStyle.Guide,", src);
        Assert.Contains("public static string RenderFormat() => OutputFormatRenderer.Render(Spec, PromptOverrides.None());", src);
        Assert.Contains("public static string RenderFormat(PromptOverrides overrides)", src);
        // Enum field carries values + enumDoc; string field carries example + instruction.
        Assert.Contains("FieldKind.Enum", src);
        Assert.Contains("[\"HIGH\"] = \"Directly supported.\"", src);
        Assert.Contains("\"Your refund will appear in 3-5 days.\"", src);
    }

    [Fact]
    public void Prompt_generator_serves_a_text_bodied_prompt()
    {
        // The fragment describes the REPLY, so a text-bodied prompt still gets one — the
        // old @format gate skipped exactly the templates that most needed it.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "P", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.prompt": { "name": "TextOut", "@payloadRef": "P", "@responseRef": "P", "@textRef": "t/x", "@format": "text" } }
        ]}}
        """;
        var file = Assert.Single(new OutputPromptGenerator().Generate(Ctx(Load(m))));
        Assert.Equal("TextOut.responseFormat.cs", file.Path);
        Assert.Contains("Format.Json", file.Content);
    }

    [Fact]
    public void Prompt_generator_skips_a_prompt_with_no_response()
    {
        // The inbound gate is @responseRef PRESENCE. No declared reply, no fragment.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "P", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.prompt": { "name": "TextOut", "@payloadRef": "P", "@textRef": "t/x", "@format": "text" } }
        ]}}
        """;
        Assert.Empty(new OutputPromptGenerator().Generate(Ctx(Load(m))));
    }

    // ---- compile-AND-run proof ----

    [Fact]
    public void Generated_extract_and_prompt_compile_and_run()
    {
        var root = Load(Model);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var promptSrc = Assert.Single(new OutputPromptGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = "using System.Collections.Generic;\nnamespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "AnswerPayload");

        var asm = CompileToAssembly(parserSrc, promptSrc, payloadSrc);

        // --- invoke Extract() on a dirty response: preamble + off-vocab alias + missing optional ---
        var parserType = asm.GetType("Acme.Generated.AnswerOutputParser")!;
        // The single (loader-delegating) extract path: resolve the payload from the loaded MetaRoot.
        var extract = parserType.GetMethod("ExtractLenient",
            new[] { typeof(MetaRoot), typeof(string), typeof(MetaObjects.Render.Extract.ExtractOptions) })!;
        const string dirty = "Sure! Here is the result:\n```json\n{ \"text\": \"Refund in 3-5 days\", \"confidence\": \"medium\", \"score\": 95 }\n```";
        var result = extract.Invoke(null, new object?[] { root, dirty, null })!;

        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;
        string? Get(string p) => data.GetType().GetProperty(p)!.GetValue(data) as string;

        Assert.Equal("Refund in 3-5 days", Get("text"));
        Assert.Equal("OK", Get("confidence"));                       // @enumAlias "medium" → "OK"
        Assert.Equal(95, data.GetType().GetProperty("score")!.GetValue(data)); // int? boxed
        Assert.Null(data.GetType().GetProperty("note")!.GetValue(data));       // absent optional → null

        var report = result.GetType().GetProperty("Report")!.GetValue(result)!;
        bool isEmpty = (bool)report.GetType().GetProperty("IsEmpty")!.GetValue(report)!;
        Assert.False(isEmpty);

        // --- invoke RenderFormat() and assert the guide-style fragment ---
        var promptType = asm.GetType("Acme.Generated.AnswerOutputResponseFormat")!;
        var render = promptType.GetMethod("RenderFormat", Type.EmptyTypes)!;
        var fragment = (string)render.Invoke(null, null)!;

        Assert.DoesNotContain("<!--", fragment);                     // never comments
        Assert.Contains("Fill in each field as described below:", fragment);
        Assert.Contains("confidence (required)", fragment);
        Assert.Contains("one of HIGH, OK, LOW", fragment);
        Assert.Contains("HIGH = Directly supported.", fragment);
        Assert.Contains("Respond exactly like this:", fragment);
    }

    // ---- FR-011: @coerceDefault compile-AND-run proof ----

    private const string CoerceDefaultModel = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "TaskPayload", "children": [
        { "field.string": { "name": "title", "@required": true } },
        { "field.enum": { "name": "status", "@required": true,
            "@values": ["IN_PROGRESS","DONE"],
            "@coerceDefault": "DONE", "@normalize": "none" } }
      ]}},
      { "template.prompt": { "name": "TaskOutput", "@payloadRef": "TaskPayload", "@responseRef": "TaskPayload",
          "@textRef": "ai/task", "@format": "text", "@responseFormat": "json", "@promptStyle": "guide" } }
    ]}}
    """;

    [Fact]
    public void Generated_extract_folds_off_vocab_via_coerce_default_to_defaulted()
    {
        var root = Load(CoerceDefaultModel);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var promptSrc = Assert.Single(new OutputPromptGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "TaskPayload");

        var asm = CompileToAssembly(parserSrc, promptSrc, payloadSrc);

        var parserType = asm.GetType("Acme.Generated.TaskOutputParser")!;
        // The single (loader-delegating) extract path reads @coerceDefault/@normalize off live metadata.
        var extract = parserType.GetMethod("ExtractLenient",
            new[] { typeof(MetaRoot), typeof(string), typeof(MetaObjects.Render.Extract.ExtractOptions) })!;
        // Off-vocab enum value "banana" → @coerceDefault folds it to "DONE".
        const string dirty = "{ \"title\": \"ship it\", \"status\": \"banana\" }";
        var result = extract.Invoke(null, new object?[] { root, dirty, null })!;

        var data = result.GetType().GetProperty("Data")!.GetValue(result)!;
        string? Get(string p) => data.GetType().GetProperty(p)!.GetValue(data) as string;

        Assert.Equal("ship it", Get("title"));
        Assert.Equal("DONE", Get("status")); // @coerceDefault fold

        // The report classifies status as DEFAULTED (not EXTRACTED).
        var report = result.GetType().GetProperty("Report")!.GetValue(result)!;
        var states = (System.Collections.IDictionary)report.GetType().GetMethod("States")!.Invoke(report, null)!;
        Assert.Equal("DEFAULTED", states["status"]!.ToString());
        Assert.Equal("EXTRACTED", states["title"]!.ToString());
    }

    private static Assembly CompileToAssembly(params string[] sources)
    {
        var trees = sources.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        // The generated delegating extract/prompt code references the render engine, MetaObjects
        // core (MetaObject / MetaRoot / ValueObject), AND MetaObjects.Codegen (runtime ExtractObject).
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));

        // Elevate the nullable-covariance warning (CS8619) to an error so a mirror-type ↔
        // ExtractMap-return mismatch (e.g. on an array field) fails this proof rather than
        // silently emitting consumer-side warnings.
        var options = new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            .WithSpecificDiagnosticOptions(new Dictionary<string, ReportDiagnostic>
            {
                ["CS8619"] = ReportDiagnostic.Error,
            });
        var comp = CSharpCompilation.Create("fr010_" + Guid.NewGuid().ToString("N"), trees, refs, options);

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
