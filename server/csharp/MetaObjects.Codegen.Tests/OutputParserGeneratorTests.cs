using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// OutputParserGenerator emission tests (FR6, ADR-0010). Mirrors
/// server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts —
/// asserts the file-per-template emit, the Parse / TryParse dual-API shape, and
/// that the generator stays out of template.prompt's lane.
/// </summary>
public sealed class OutputParserGeneratorTests
{
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

    [Fact]
    public void Emits_no_files_for_a_prompt_that_declares_no_response()
    {
        // A prompt with no @responseRef has no inbound half — nothing elicits a typed
        // reply, so there is nothing to parse.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Payload", "children": [ { "field.string": { "name": "x" } } ] } },
          { "template.prompt": { "name": "promptOnly", "@payloadRef": "Payload", "@textRef": "p/x", "@format": "text" } }
        ]}}
        """;
        var files = new OutputParserGenerator().Generate(Ctx(Load(m))).ToList();
        Assert.Empty(files);
    }

    [Fact]
    public void A_template_output_emits_no_parser_extractor_or_response_format()
    {
        // The ADR-0052 pin. `template.output` is OUTBOUND ONLY: it renders a document or
        // an email and generates nothing that reads a model's reply. Before this, the
        // parser tier had no @kind filter at all, so a markdown document template got a
        // generated `JSON.parse`-equivalent — a method that could never work.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Doc", "children": [ { "field.string": { "name": "body" } } ] } },
          { "template.output": { "name": "Welcome", "@payloadRef": "Doc",
                                 "@textRef": "mail/welcome", "@format": "json" } }
        ]}}
        """;
        var root = Load(m);
        Assert.Empty(new OutputParserGenerator().Generate(Ctx(root)));
        Assert.Empty(new OutputPromptGenerator().Generate(Ctx(root)));
        Assert.Empty(new ExtractorGenerator().Generate(Ctx(root)));
    }

    [Fact]
    public void Emits_one_file_per_responding_prompt_with_expected_path_and_class()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "AlphaPayload", "children": [ { "field.string": { "name": "name" } } ] } },
          { "object.value": { "name": "BetaPayload",  "children": [ { "field.int":    { "name": "n" } } ] } },
          { "template.prompt": { "name": "Alpha", "@payloadRef": "AlphaPayload", "@responseRef": "AlphaPayload", "@textRef": "a/x", "@format": "text", "@responseFormat": "json" } },
          { "template.prompt": { "name": "Beta",  "@payloadRef": "BetaPayload", "@responseRef": "BetaPayload",  "@textRef": "b/x", "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var files = new OutputParserGenerator().Generate(Ctx(Load(m))).OrderBy(f => f.Path).ToList();
        Assert.Equal(2, files.Count);
        Assert.Equal("Alpha.response.cs", files[0].Path);
        Assert.Equal("Beta.response.cs",  files[1].Path);
        Assert.Contains("public static class AlphaParser", files[0].Content);
        Assert.Contains("public static class BetaParser",  files[1].Content);
    }

    [Fact]
    public void Emits_dual_api_returning_the_payload_ref_type()
    {
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "NpcResponsePayload", "children": [
            { "field.string": { "name": "name" } },
            { "field.int":    { "name": "age" } }
          ]}},
          { "template.prompt": { "name": "NpcResponseOutput", "@payloadRef": "NpcResponsePayload", "@responseRef": "NpcResponsePayload",
                                  "@textRef": "npc/output", "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var file = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(m))));
        Assert.Equal("NpcResponseOutput.response.cs", file.Path);

        var src = file.Content;
        Assert.Contains("using System.Text.Json;", src);
        Assert.Contains("namespace Acme.Generated;", src);
        Assert.Contains("public static class NpcResponseOutputParser", src);

        // Parse returns the payload-VO type and throws on failure.
        Assert.Contains("public static NpcResponsePayload Parse(string text)", src);
        Assert.Contains("throw new JsonException", src);

        // TryParse returns bool + nullable out + error out.
        Assert.Contains("public static bool TryParse(string text,", src);
        Assert.Contains("[NotNullWhen(true)] out NpcResponsePayload? value", src);
        Assert.Contains("[NotNullWhen(false)] out string? error", src);
    }

    [Fact]
    public void Emitted_source_compiles_alongside_the_payload_record()
    {
        // End-to-end: payload-VO codegen + output-parser codegen should compile
        // together with no errors. Guards against C# language-level regressions
        // in the emitted shape (required keyword, nullable annotations, etc.).
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "NpcResponsePayload", "children": [
            { "field.string": { "name": "name" } },
            { "field.int":    { "name": "age" } }
          ]}},
          { "template.prompt": { "name": "NpcResponseOutput", "@payloadRef": "NpcResponsePayload", "@responseRef": "NpcResponsePayload",
                                  "@textRef": "npc/output", "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var root = Load(m);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var payloadSrc = PayloadCodegen.GeneratePayloadRecords(root, "NpcResponsePayload");

        // Wrap the payload record in a namespace matching the parser's.
        var wrappedPayload = "namespace Acme.Generated;\n" + payloadSrc;

        var trees = new[]
        {
            CSharpSyntaxTree.ParseText(parserSrc,     new CSharpParseOptions(LanguageVersion.CSharp12)),
            CSharpSyntaxTree.ParseText(wrappedPayload, new CSharpParseOptions(LanguageVersion.CSharp12)),
        };
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("outparse_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "parser + payload should compile, got: " + string.Join("; ", errors));
    }

    [Fact]
    public void Emitted_source_matches_the_shared_responding_prompt_fixture()
    {
        // Conformance-adjacent check: the same fixture used by the TS port should
        // drive the C# emit (different output shape — TS = Zod, C# = STJ — but
        // same metadata in). ADR-0052: the shared inbound fixture is a responding
        // PROMPT — `template-output-simple` is outbound-only now and emits nothing here.
        var repoRoot = LocateRepoRoot();
        var fixtureDir = Path.Combine(repoRoot, "fixtures", "conformance", "template-prompt-response-json", "input");
        Assert.True(Directory.Exists(fixtureDir), $"fixture dir not found at {fixtureDir}");

        var load = MetaDataLoader.FromDirectory(fixtureDir);
        Assert.Empty(load.Errors);

        var ctx = new GenContext
        {
            Entities = load.Root.Objects(),
            Root = load.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        var file = Assert.Single(new OutputParserGenerator().Generate(ctx));
        Assert.Equal("SupportAnswerPrompt.response.cs", file.Path);
        // The bound type is the @responseRef shape (SupportAnswer), NOT the @payloadRef
        // request shape (SupportRequest) — the distinction ADR-0052 exists to draw.
        Assert.Contains("public static SupportAnswer Parse(string text)", file.Content);
        Assert.DoesNotContain("SupportRequest Parse(", file.Content);
        Assert.Contains("public static bool TryParse(string text,", file.Content);
    }

    // Walk upward from the test assembly to the repo root (contains a fixtures/ dir).
    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }
}
