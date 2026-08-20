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
    public void A_responseRef_that_is_not_a_value_object_emits_no_parser()
    {
        // Fail-closed. @responseRef must resolve through the SAME payload-target resolver
        // @payloadRef obeys (object.value, or a sourceless object.projection), because
        // PayloadGenerator emits the record this parser binds using that resolver. When
        // FindInbound used the any-object ResolveObjectRef instead, an entity target
        // resolved HERE, the parser emitted `static Answer Parse(string)`, and
        // PayloadGenerator emitted no record — CS0246, generated code that cannot compile.
        //
        // Nothing upstream catches it: unlike TypeScript, whose loader validates the
        // @responseRef target (validation-passes.ts:336-345), the C# loader validates only
        // @payloadRef — so this model loads with ZERO errors. Asserted below, because if the
        // C# loader ever gains that rule this test would otherwise pass vacuously.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Req", "children": [ { "field.string": { "name": "q" } } ] } },
          { "object.entity": { "name": "Answer", "children": [
            { "source.rdb": { "@table": "answers" } },
            { "field.long": { "name": "id" } },
            { "field.string": { "name": "text" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
          ]}},
          { "template.prompt": { "name": "AskPrompt", "@payloadRef": "Req", "@responseRef": "Answer",
                                 "@textRef": "a/x", "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var load = new MetaDataLoader().Load([new InMemoryStringSource(m, id: "outputs.json")]);
        Assert.Empty(load.Errors);

        var ctx = new GenContext
        {
            Entities = load.Root.Objects(),
            Root = load.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        // No record for the entity, therefore no parser bound to it. The two must agree, and
        // agreeing on "nothing" is the only safe agreement available for a target neither can
        // legally emit. The prompt's @payloadRef (a real value-object) still gets its request
        // record — that is a different ref, and it resolves.
        var payloads = new PayloadGenerator().Generate(ctx).ToList();
        Assert.Equal("Req.payload.cs", Assert.Single(payloads).Path);
        Assert.DoesNotContain(payloads, f => f.Content.Contains("record Answer"));

        Assert.Empty(new OutputParserGenerator().Generate(ctx));
        Assert.Empty(new OutputPromptGenerator().Generate(ctx));
        Assert.Empty(new ExtractorGenerator().Generate(ctx));
    }

    [Fact]
    public void An_xml_reply_gets_the_tolerant_extract_and_no_strict_parser()
    {
        // ADR-0053: the strict Parse/TryParse tier is JSON-ONLY. Not for want of an XML
        // reader — MetaObjects.Render ships a forgiving one — but because strict
        // all-or-nothing semantics layered over a REPAIRING parser is incoherent: it would
        // throw or accept based on how much repair happened, which is not a contract
        // anyone can reason about. So an XML reply gets the tolerant extract and nothing
        // strict. Before ADR-0052 it got `JsonSerializer.Deserialize` — a generated method
        // that could never work.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Answer", "children": [ { "field.string": { "name": "text" } } ] } },
          { "template.prompt": { "name": "AskXml", "@payloadRef": "Answer", "@responseRef": "Answer",
                                 "@textRef": "ask/x", "@format": "text", "@responseFormat": "xml" } }
        ]}}
        """;
        var file = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(m))));
        Assert.Equal("AskXml.response.cs", file.Path);

        // No strict tier — nor any of the System.Text.Json machinery it needs.
        // Match the PUBLIC signatures, not a bare "TryParse(": the tolerant tier's
        // coercion mappers legitimately call int.TryParse / decimal.TryParse.
        Assert.DoesNotContain("public static Answer Parse(string text)", file.Content);
        Assert.DoesNotContain("public static bool TryParse(string text,", file.Content);
        Assert.DoesNotContain("using System.Text.Json;", file.Content);
        Assert.DoesNotContain("JsonSerializer", file.Content);

        // The tolerant tier IS emitted, and dispatches on the XML reader.
        Assert.Contains("using MetaObjects.Render.Extract;", file.Content);
        Assert.Contains("Format.Xml", file.Content);
        Assert.DoesNotContain("Format.Json", file.Content);
        Assert.Contains("AnswerExtracted", file.Content);
    }

    [Fact]
    public void A_json_reply_gets_both_tiers()
    {
        // The control for the XML case above: same model, same everything, one attribute
        // different. Without this pair, "no strict tier" could be passing because the
        // generator emits nothing useful for either format.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Answer", "children": [ { "field.string": { "name": "text" } } ] } },
          { "template.prompt": { "name": "AskJson", "@payloadRef": "Answer", "@responseRef": "Answer",
                                 "@textRef": "ask/j", "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var file = Assert.Single(new OutputParserGenerator().Generate(Ctx(Load(m))));
        Assert.Contains("public static Answer Parse(string text)", file.Content);
        Assert.Contains("public static bool TryParse(string text,", file.Content);
        Assert.Contains("using System.Text.Json;", file.Content);
        Assert.Contains("Format.Json", file.Content);
        Assert.DoesNotContain("Format.Xml", file.Content);
        // Both formats get the tolerant tier — it is the strict half that is format-gated.
        Assert.Contains("AnswerExtracted", file.Content);
    }

    [Fact]
    public void Emitted_source_compiles_alongside_the_payload_record()
    {
        // End-to-end: payload-VO codegen + output-parser codegen should compile
        // together with no errors. Guards against C# language-level regressions
        // in the emitted shape (required keyword, nullable annotations, etc.).
        //
        // The payload half MUST come through PayloadGenerator.Generate — the registered
        // generator seam `dotnet meta gen` actually runs — not through PayloadCodegen
        // directly. Calling the codec directly with a hand-written ref proves only that a
        // record CAN be produced for a name the test already knew; it cannot see the
        // generator failing to emit that record at all. That is exactly the ADR-0052
        // failure mode: the parser binds @responseRef, so if the generator does not walk
        // @responseRef the parser references a type nobody declares. Routed through the
        // seam, deleting the inbound walk turns this red with a CS0246.
        //
        // @responseRef is a DIFFERENT value-object from @payloadRef here on purpose: with
        // the two equal, the outbound walk would emit the needed record by coincidence.
        const string m = """
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "NpcRequestPayload", "children": [
            { "field.string": { "name": "setting" } }
          ]}},
          { "object.value": { "name": "NpcResponsePayload", "children": [
            { "field.string": { "name": "name" } },
            { "field.int":    { "name": "age" } }
          ]}},
          { "template.prompt": { "name": "NpcResponseOutput", "@payloadRef": "NpcRequestPayload", "@responseRef": "NpcResponsePayload",
                                  "@textRef": "npc/output", "@format": "text", "@responseFormat": "json" } }
        ]}}
        """;
        var root = Load(m);
        var parserSrc = Assert.Single(new OutputParserGenerator().Generate(Ctx(root))).Content;
        var payloadFiles = new PayloadGenerator().Generate(Ctx(root)).ToList();
        // The record the parser binds must be among what the generator emitted.
        Assert.Contains(payloadFiles, f => f.Path == "NpcResponsePayload.payload.cs");

        // PayloadGenerator already emits its own `namespace {ctx.Config.Namespace};` header,
        // which is the same namespace the parser emits under — no wrapping needed.
        var trees = payloadFiles
            .Select(f => CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .Prepend(CSharpSyntaxTree.ParseText(parserSrc, new CSharpParseOptions(LanguageVersion.CSharp12)))
            .ToArray();
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
