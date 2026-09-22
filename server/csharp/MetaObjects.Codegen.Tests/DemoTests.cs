using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// THE DEMO (FR-004 Plan #3, T7) — the acceptance criterion for the fourth pillar.
/// Proves BOTH enforcement mechanisms close the loop for the C# port:
///   (a) compile-time: the payload type is the value object's own POCO (ADR-0056 —
///       EntityGenerator emits it from the projection metadata), so a caller naming a
///       member the metadata does not declare fails to COMPILE (verified here with Roslyn).
///   (b) build-time:  verify() parses the opaque template text and catches a
///       variable the payload doesn't declare ("a renamed field broke a prompt").
/// Omitting a @required member is NOT a compile error in C#: the POCO is shared with the
/// REST tier, where presence is a validation concern, so its members carry no `required`
/// keyword. The strict response parser enforces presence instead.
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

    // Compile sources against the framework + MetaObjects.Render; return error diagnostics.
    private static IReadOnlyList<string> CompileErrors(IEnumerable<string> sources)
    {
        var trees = sources.Select(src => CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(Renderer).Assembly.Location));

        var compilation = CSharpCompilation.Create(
            "demo_" + Guid.NewGuid().ToString("N"),
            trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        return compilation.GetDiagnostics()
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}")
            .ToList();
    }

    // The value objects' POCOs, as `dotnet meta gen --generators entity` emits them, plus a caller.
    private static IEnumerable<string> WithGeneratedPayload(MetaRoot root, string caller)
    {
        var ctx = new GenContext
        {
            Entities = root.Objects(), Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        return new EntityGenerator().Generate(ctx).Select(f => f.Content).Append(caller);
    }

    private const string Render = """
        global::MetaObjects.Render.Renderer.Render(new global::MetaObjects.Render.RenderRequest
            { Ref = "prompt/strategy", Payload = payload, Format = "xml", Provider = p })
        """;

    [Fact]
    public void Compile_time__a_correctly_shaped_caller_compiles()
    {
        var errors = CompileErrors(WithGeneratedPayload(Load(), $$"""
        using System.Collections.Generic;
        using Acme.Generated;
        using MetaObjects.Render;
        public static class GoodCaller
        {
            public static string Go(IProvider p)
            {
                var payload = new AuthorBrief { DisplayName = "Ada", PostCount = 1, Posts = new List<PostBrief>() };
                return {{Render}};
            }
        }
        """));
        Assert.True(errors.Count == 0, "expected the generated payload + a correct caller to compile, got: "
            + string.Join("; ", errors));
    }

    [Fact]
    public void Compile_time__a_caller_naming_an_UNDECLARED_member_fails_to_compile()
    {
        // `title` belongs to PostBrief, not AuthorBrief — the shape a renamed or misremembered
        // field produces. The POCO's member set is the metadata's, so this does not compile.
        var errors = CompileErrors(WithGeneratedPayload(Load(), $$"""
        using Acme.Generated;
        using MetaObjects.Render;
        public static class BadCaller
        {
            public static string Go(IProvider p)
            {
                var payload = new AuthorBrief { DisplayName = "Ada", Title = "not a member" };
                return {{Render}};
            }
        }
        """));
        Assert.Contains(errors, e => e.StartsWith("CS0117", StringComparison.Ordinal));
    }

    [Fact]
    public void Compile_time__a_caller_omitting_an_OPTIONAL_member_compiles()
    {
        // `posts` carries no `@required`, so omitting it must be legal — the shape #309 was
        // filed about: an LLM response that simply does not populate an optional field.
        var errors = CompileErrors(WithGeneratedPayload(Load(), $$"""
        using Acme.Generated;
        using MetaObjects.Render;
        public static class PartialCaller
        {
            public static string Go(IProvider p)
            {
                var payload = new AuthorBrief { DisplayName = "Ada", PostCount = 1 };
                return {{Render}};
            }
        }
        """));
        Assert.True(errors.Count == 0, "expected omitting an OPTIONAL member to compile, got: "
            + string.Join("; ", errors));
    }

    [Fact]
    public void Build_time__verify_catches_a_drifted_template_variable()
    {
        var fields = PayloadFieldTree.Build(Load(), "AuthorBrief");
        var drift = Verify.Check("Hi {{displayName}}, you have {{notARealField}} posts.", fields);
        Assert.Contains(Verify.ERR_VAR_NOT_ON_PAYLOAD, drift.Select(e => e.Code));
    }
}
