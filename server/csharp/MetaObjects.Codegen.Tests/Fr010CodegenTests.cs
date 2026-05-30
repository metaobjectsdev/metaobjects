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
/// FR-010 codegen: the tolerant recover() API on OutputParserGenerator + the OutputPromptGenerator.
/// The headline is a compile-AND-RUN proof — generated parser + nullable mirror + payload + prompt
/// are compiled together with the render engine via Roslyn, then Recover()/RenderFormat() are
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
        { "field.string": { "name": "note" } }
      ]}},
      { "template.output": { "name": "AnswerOutput", "@payloadRef": "AnswerPayload",
          "@textRef": "ai/answer", "@format": "json", "@promptStyle": "guide" } }
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
    public void Parser_emits_recover_api_and_nullable_mirror_for_json()
    {
        var src = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(Model)))).Content;

        Assert.Contains("using MetaObjects.Render.Recover;", src);
        Assert.Contains("private static readonly RecoverSchema RecoverSchemaDef =", src);
        Assert.Contains("FieldSpec.EnumField(\"confidence\", true, new[] { \"HIGH\", \"OK\", \"LOW\" }", src);
        Assert.Contains("public static RecoveryResult<AnswerPayloadRecovered> Recover(string text)", src);
        Assert.Contains("public static RecoveryResult<AnswerPayloadRecovered> Recover(string text, RecoverOptions opts)", src);
        Assert.Contains("public static bool TryRecover(string text, out RecoveryResult<AnswerPayloadRecovered> result)", src);

        // Nullable mirror record — no `required`, every component nullable.
        Assert.Contains("public sealed record AnswerPayloadRecovered", src);
        Assert.Contains("public string? text { get; init; }", src);
        Assert.Contains("public string? confidence { get; init; }", src);
        Assert.Contains("public int? score { get; init; }", src);
        Assert.DoesNotContain("required", src.Split("AnswerPayloadRecovered")[1]); // mirror half has no required
    }

    [Fact]
    public void Parser_omits_recover_for_text_format()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "P", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.output": { "name": "TextOut", "@payloadRef": "P", "@textRef": "t/x", "@format": "text" } }
        ]}}
        """;
        var src = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(m)))).Content;
        Assert.Contains("Parse(string text)", src);          // strict parser still emitted
        Assert.DoesNotContain("Recover(", src);               // no recover for text
        Assert.DoesNotContain("Recovered", src);
    }

    [Fact]
    public void Prompt_generator_emits_render_format_pair()
    {
        var file = Assert.Single(new OutputPromptGenerator().Generate(Ctx(Load(Model))));
        Assert.Equal("AnswerOutput.prompt.cs", file.Path);
        var src = file.Content;
        Assert.Contains("public static class AnswerOutputPrompt", src);
        Assert.Contains("private static readonly OutputFormatSpec Spec = new OutputFormatSpec(Format.Json, \"AnswerPayload\", PromptStyle.Guide,", src);
        Assert.Contains("public static string RenderFormat() => OutputFormatRenderer.Render(Spec, PromptOverrides.None());", src);
        Assert.Contains("public static string RenderFormat(PromptOverrides overrides)", src);
        // Enum field carries values + enumDoc; string field carries example + instruction.
        Assert.Contains("FieldKind.Enum", src);
        Assert.Contains("[\"HIGH\"] = \"Directly supported.\"", src);
        Assert.Contains("\"Your refund will appear in 3-5 days.\"", src);
    }

    [Fact]
    public void Prompt_generator_skips_text_format()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "P", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.output": { "name": "TextOut", "@payloadRef": "P", "@textRef": "t/x", "@format": "text" } }
        ]}}
        """;
        Assert.Empty(new OutputPromptGenerator().Generate(Ctx(Load(m))));
    }

    // ---- compile-AND-run proof ----

    [Fact]
    public void Generated_recover_and_prompt_compile_and_run()
    {
        var root = Load(Model);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var promptSrc = Assert.Single(new OutputPromptGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = "namespace Acme.Generated;\n" + PayloadCodegen.GeneratePayloadRecords(root, "AnswerPayload");

        var asm = CompileToAssembly(parserSrc, promptSrc, payloadSrc);

        // --- invoke Recover() on a dirty response: preamble + off-vocab alias + missing optional ---
        var parserType = asm.GetType("Acme.Generated.AnswerOutputParser")!;
        var recover = parserType.GetMethod("Recover", new[] { typeof(string) })!;
        const string dirty = "Sure! Here is the result:\n```json\n{ \"text\": \"Refund in 3-5 days\", \"confidence\": \"medium\", \"score\": 95 }\n```";
        var result = recover.Invoke(null, new object[] { dirty })!;

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
        var promptType = asm.GetType("Acme.Generated.AnswerOutputPrompt")!;
        var render = promptType.GetMethod("RenderFormat", Type.EmptyTypes)!;
        var fragment = (string)render.Invoke(null, null)!;

        Assert.DoesNotContain("<!--", fragment);                     // never comments
        Assert.Contains("Fill in each field as described below:", fragment);
        Assert.Contains("confidence (required)", fragment);
        Assert.Contains("one of HIGH, OK, LOW", fragment);
        Assert.Contains("HIGH = Directly supported.", fragment);
        Assert.Contains("Respond exactly like this:", fragment);
    }

    private static Assembly CompileToAssembly(params string[] sources)
    {
        var trees = sources.Select(s =>
            CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12))).ToArray();

        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        // The generated recover/prompt code references the render engine.
        refs.Add(MetadataReference.CreateFromFile(
            typeof(MetaObjects.Render.Recover.RecoverSchema).Assembly.Location));

        var comp = CSharpCompilation.Create("fr010_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));

        ms.Seek(0, SeekOrigin.Begin);
        return Assembly.Load(ms.ToArray());
    }
}
