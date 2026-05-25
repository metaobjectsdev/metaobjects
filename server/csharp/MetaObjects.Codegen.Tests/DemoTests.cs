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
          { "object.value": { "name": "AuthorBrief", "children": [
            { "field.string": { "name": "displayName" } },
            { "field.int": { "name": "postCount" } },
            { "field.object": { "name": "posts", "isArray": true, "@objectRef": "PostBrief",
              "children": [ { "origin.collection": { "@via": "Author.posts" } } ] } }
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
    public void Compile_time__a_wrong_shaped_caller_fails_to_compile()
    {
        // The caller omits required members (postCount, posts) — the codegen'd shape
        // contract makes this a compile error, not a silent runtime mismatch.
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
        Assert.True(errors.Count > 0, "expected a wrong-shaped caller to FAIL compilation, but it compiled clean");
    }

    [Fact]
    public void Build_time__verify_catches_a_drifted_template_variable()
    {
        var fields = PayloadCodegen.BuildPayloadFieldTree(Load(), "AuthorBrief");
        var drift = Verify.Check("Hi {{displayName}}, you have {{notARealField}} posts.", fields);
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, drift.Select(e => e.Code));
    }
}
