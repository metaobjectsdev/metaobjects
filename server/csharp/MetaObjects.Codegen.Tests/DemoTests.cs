using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects;
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// THE DEMO (FR-004 Plan #3, T7) — the acceptance criterion for the fourth pillar.
/// Proves BOTH enforcement mechanisms close the loop for the C# port:
///   (a) compile-time: a payload VO codegen'd from the projection metadata makes a
///       wrong-shaped caller fail to COMPILE (verified here with Roslyn).
///   (b) build-time:  verify() parses the opaque template text and catches a
///       variable the payload doesn't declare ("a renamed field broke a prompt").
/// </summary>
public class DemoTests
{
    private const string Model = """
    {
      "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": { "name": "PostBrief", "children": [
            { "field.string": { "name": "title" } }
          ]}},
          { "object.projection": { "name": "AuthorBrief", "children": [
            { "field.string": { "name": "displayName", "@required": true } },
            { "field.int": { "name": "postCount", "@required": true } },
            { "field.object": { "name": "posts", "isArray": true, "@objectRef": "PostBrief" } }
          ]}},
          { "template.prompt": { "name": "contentStrategyPrompt",
            "@payloadRef": "AuthorBrief", "@textRef": "prompt/strategy", "@format": "xml" } }
        ]
      }
    }
    """;

    private static MetaRoot Load()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "demo.json")]);
        Assert.Empty(result.Errors);
        return result.Root;
    }

    // Compile a source string against the framework + MetaObjects.Render; return error diagnostics.
    private static IReadOnlyList<string> CompileErrors(string source)
    {
        var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(Renderer).Assembly.Location));

        var compilation = CSharpCompilation.Create(
            "demo_" + Guid.NewGuid().ToString("N"),
            [tree], refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        return compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
    }

    private static string GeneratedSource(MetaRoot root)
    {
        var records = PayloadCodegen.GeneratePayloadRecords(root, "AuthorBrief");
        // Hoist the handle's `using` to the top so it can sit after the record decls.
        var handle = PayloadCodegen.GenerateRenderHandle(root, "contentStrategyPrompt")
            .Replace("using MetaObjects.Render;", "").TrimStart();
        return "using System.Collections.Generic;\nusing MetaObjects.Render;\n\n"
            + records + "\n" + handle + "\n";
    }

    [Fact]
    public void Compile_time__a_correctly_shaped_caller_compiles()
    {
        var source = GeneratedSource(Load()) + """
        public static class GoodCaller
        {
            public static string Go(IProvider p)
            {
                var good = new AuthorBrief { displayName = "Ada", postCount = 1, posts = new List<PostBrief>() };
                return RenderHandles.RenderContentStrategyPrompt(good, p);
            }
        }
        """;
        var errors = CompileErrors(source);
        Assert.True(errors.Count == 0, "expected the generated payload + a correct caller to compile, got: "
            + string.Join("; ", errors));
    }

    [Fact]
    public void Compile_time__a_caller_omitting_a_DECLARED_required_member_fails_to_compile()
    {
        // The caller omits `postCount`, which the metadata marks `@required: true` — the
        // codegen'd shape contract makes that a compile error, not a silent runtime mismatch.
        //
        // #309: this test previously proved the same thing about fields carrying NO
        // `@required` at all, because the emitter marked every property `required`. It
        // therefore pinned the defect while its comment claimed to demonstrate the design.
        // The fixture now declares what the test asserts, so it passes for the stated reason.
        var source = GeneratedSource(Load()) + """
        public static class BadCaller
        {
            public static string Go(IProvider p)
            {
                var bad = new AuthorBrief { displayName = "Ada" };
                return RenderHandles.RenderContentStrategyPrompt(bad, p);
            }
        }
        """;
        var errors = CompileErrors(source);
        Assert.True(errors.Count > 0, "expected a caller omitting a required member to FAIL compilation, but it compiled clean");
    }

    [Fact]
    public void Compile_time__a_caller_omitting_an_OPTIONAL_member_compiles()
    {
        // The other arm, which no test covered while every property was `required`: `posts`
        // carries no `@required`, so omitting it must be legal. This is the shape #309 was
        // filed about — an LLM response that simply does not populate an optional field.
        var source = GeneratedSource(Load()) + """
        public static class PartialCaller
        {
            public static string Go(IProvider p)
            {
                var partial = new AuthorBrief { displayName = "Ada", postCount = 1 };
                return RenderHandles.RenderContentStrategyPrompt(partial, p);
            }
        }
        """;
        var errors = CompileErrors(source);
        Assert.True(errors.Count == 0, "expected omitting an OPTIONAL member to compile, got: "
            + string.Join("; ", errors));
    }

    [Fact]
    public void Build_time__verify_catches_a_drifted_template_variable()
    {
        var fields = PayloadCodegen.BuildPayloadFieldTree(Load(), "AuthorBrief");
        var drift = Verify.Check("Hi {{displayName}}, you have {{notARealField}} posts.", fields);
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, drift.Select(e => e.Code));
    }
}
