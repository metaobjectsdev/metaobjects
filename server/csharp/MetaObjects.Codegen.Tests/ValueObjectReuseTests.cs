// ADR-0056 — a value object's type is generated once; the template tier references it.
//
// C# pins: EntityGenerator emits a POCO for EVERY value shape (reached by an entity or not),
// names it the way every other generator names it (ValueObjectNames), and the template tier
// declares none of its own — two prompts parsing into one value object share its mirror.
// Also the verify field-tree bridge (PayloadFieldTree), which is what remains of the old
// PayloadCodegen.

using System.Reflection;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Render;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class ValueObjectReuseTests
{
    private static MetaRoot Load(params string[] models)
    {
        var r = new MetaDataLoader().Load(
            models.Select((m, i) => (IMetaDataSource)new InMemoryStringSource(m, id: $"m{i}.json")).ToArray());
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    // ---- the value-object tier ----

    [Fact]
    public void Every_value_shape_gets_a_poco_whether_or_not_an_entity_reaches_it()
    {
        // No entity at all: before ADR-0056 C# emitted a POCO only for value objects an entity
        // object-field reached, and the template tier wrote its own record for the rest.
        var root = Load("""
        { "metadata.root": { "package": "acme::ai", "children": [
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "text" } } ] } },
          { "object.value": { "name": "Base", "abstract": true, "children": [ { "field.string": { "name": "x" } } ] } },
          { "object.projection": { "name": "Brief", "children": [ { "field.string": { "name": "summary" } } ] } }
        ]}}
        """);

        var paths = new EntityGenerator().Generate(Ctx(root)).Select(f => f.Path).ToList();

        // The concrete value object and the sourceless projection; not the unreached abstract.
        Assert.Equal(["Brief.g.cs", "Note.g.cs"], paths.OrderBy(p => p, StringComparer.Ordinal));
    }

    private const string Alpha = """
    { "metadata.root": { "package": "acme::alpha", "children": [
      { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "alphaText" } } ] } } ] } }
    """;
    private const string Beta = """
    { "metadata.root": { "package": "acme::beta", "children": [
      { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "betaText" } } ] } } ] } }
    """;

    [Fact]
    public void Two_value_objects_sharing_a_short_name_emit_package_qualified_pocos()
    {
        var root = Load(Alpha, Beta);
        var files = new EntityGenerator().Generate(Ctx(root)).ToList();

        Assert.Equal(["AcmeAlphaNote.g.cs", "AcmeBetaNote.g.cs"], files.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal));
        Assert.Contains("public class AcmeAlphaNote", files[0].Content + files[1].Content);
        Assert.Equal("AcmeAlphaNote", ValueObjectNames.TypeName(root.Objects().First(o => o.ResolutionKey() == "acme::alpha::Note"), root));
    }

    [Fact]
    public void A_unique_short_name_stays_bare()
    {
        var root = Load(Alpha);
        Assert.Equal("Note.g.cs", Assert.Single(new EntityGenerator().Generate(Ctx(root))).Path);
    }

    [Fact]
    public void A_derived_name_that_still_collides_fails_loud()
    {
        // acme::alpha::Note qualifies to AcmeAlphaNote — which acme::AlphaNote also derives.
        var root = Load(Alpha, Beta, """
        { "metadata.root": { "package": "acme", "children": [
          { "object.value": { "name": "AlphaNote", "children": [ { "field.string": { "name": "a" } } ] } },
          { "object.value": { "name": "Note", "children": [ { "field.string": { "name": "b" } } ] } } ] } }
        """, """
        { "metadata.root": { "package": "acme::acme", "children": [
          { "object.value": { "name": "AlphaNote", "children": [ { "field.string": { "name": "c" } } ] } } ] } }
        """);

        var ex = Assert.ThrowsAny<InvalidOperationException>(() => new EntityGenerator().Generate(Ctx(root)).ToList());
        Assert.Contains("ERR_PAYLOAD_NAME_COLLISION", ex.Message);
    }

    // ---- the template tier references it ----

    private const string SharedResponse = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "Detail", "children": [ { "field.string": { "name": "why", "@required": true } } ] } },
      { "object.value": { "name": "Answer", "children": [
        { "field.string": { "name": "text", "@required": true } },
        { "field.string": { "name": "bio" } },
        { "field.object": { "name": "detail", "@objectRef": "Detail" } }
      ]}},
      { "template.prompt": { "name": "AskA", "@payloadRef": "Answer", "@responseRef": "Answer",
          "@textRef": "a/x", "@format": "text", "@responseFormat": "json" } },
      { "template.prompt": { "name": "AskB", "@payloadRef": "Answer", "@responseRef": "Answer",
          "@textRef": "b/x", "@format": "text", "@responseFormat": "json" } }
    ]}}
    """;

    [Fact]
    public void Two_prompts_parsing_into_one_value_object_share_its_mirror_and_compile()
    {
        var root = Load(SharedResponse);
        var ctx = Ctx(root);
        var parserFiles = new OutputParserGenerator().Generate(ctx).ToList();

        // One parser per prompt, one mirror per value object — never one per prompt, which would
        // declare `AnswerExtracted` twice in one namespace (CS0101).
        Assert.Equal(
            ["AnswerExtracted.g.cs", "AskA.response.cs", "AskB.response.cs", "DetailExtracted.g.cs"],
            parserFiles.Select(f => f.Path).OrderBy(p => p, StringComparer.Ordinal));
        // The parsers declare no type for the shape.
        foreach (var f in parserFiles.Where(f => f.Path.EndsWith(".response.cs")))
        {
            Assert.DoesNotContain("record Answer", f.Content);
            Assert.DoesNotContain("class Answer", f.Content);
        }

        var asm = Compile([
            .. parserFiles.Select(f => f.Content),
            .. new ExtractorGenerator().Generate(ctx).Select(f => f.Content),
            .. GeneratedValueObjects.Sources(root),
        ]);
        var parse = asm.GetType("Acme.Generated.AskAParser")!.GetMethod("Parse")!;
        var answer = parse.Invoke(null, ["{ \"text\": \"hi\", \"detail\": { \"why\": \"because\" } }"])!;
        Assert.Equal("Answer", answer.GetType().Name);
        var detail = answer.GetType().GetProperty("Detail")!.GetValue(answer)!;
        Assert.Equal("because", detail.GetType().GetProperty("Why")!.GetValue(detail));

        // A nested @required field is enforced too.
        var ex = Assert.Throws<TargetInvocationException>(() =>
            parse.Invoke(null, ["{ \"text\": \"hi\", \"detail\": { } }"]));
        Assert.IsType<System.Text.Json.JsonException>(ex.InnerException);
    }

    [Fact]
    public void A_poco_payload_renders_its_fields_and_derived_has_accessors()
    {
        // The POCO's members are PascalCase with the field name in [JsonPropertyName]; the
        // template names the FIELD. The renderer views the POCO as its wire-name map, which is
        // also what gives it `{{#hasBio}}` — the accessor a JVM payload record used to generate.
        var root = Load(SharedResponse);
        var asm = Compile(GeneratedValueObjects.Sources(root));
        var answerType = asm.GetType("Acme.Generated.Answer")!;

        var with = Activator.CreateInstance(answerType)!;
        answerType.GetProperty("Text")!.SetValue(with, "hi");
        answerType.GetProperty("Bio")!.SetValue(with, "Ada");
        var without = Activator.CreateInstance(answerType)!;
        answerType.GetProperty("Text")!.SetValue(without, "hi");

        var provider = new InlineProvider("{{text}}{{#hasBio}} ({{bio}}){{/hasBio}}");
        Assert.Equal("hi (Ada)", Renderer.Render(new RenderRequest { Ref = "t", Payload = with, Provider = provider }));
        Assert.Equal("hi", Renderer.Render(new RenderRequest { Ref = "t", Payload = without, Provider = provider }));
    }

    private sealed class InlineProvider(string body) : IProvider
    {
        public string? Resolve(string reference) => body;
    }

    // ---- the verify field-tree bridge ----

    [Fact]
    public void PayloadFieldTree_resolves_fqn_nested_objectRef_across_package_collision()
    {
        var root = Load(Alpha, Beta, """
        { "metadata.root": { "package": "acme::app", "children": [
          { "object.value": { "name": "Digest", "children": [
            { "field.object": { "name": "fromAlpha", "@objectRef": "acme::alpha::Note" } },
            { "field.object": { "name": "fromBeta",  "@objectRef": "acme::beta::Note" } } ] } } ] } }
        """);

        var tree = PayloadFieldTree.Build(root, "Digest");

        // FQN-exact: each ref binds to its OWN package's Note.
        Assert.Equal("alphaText", Assert.Single(Assert.Single(tree, f => f.Name == "fromAlpha").Fields!).Name);
        Assert.Equal("betaText", Assert.Single(Assert.Single(tree, f => f.Name == "fromBeta").Fields!).Name);
    }

    [Fact]
    public void PayloadFieldTree_bare_ref_binds_the_referrers_own_package()
    {
        // #228 — two packages each declare their own `Report`; a bare ref resolved with a
        // template's package binds THAT package's Report, never whichever loaded first.
        var root = Load("""
        { "metadata.root": { "package": "acme::alpha", "children": [
          { "object.value": { "name": "Report", "children": [ { "field.string": { "name": "alphaVal" } } ] } } ] } }
        """, """
        { "metadata.root": { "package": "acme::beta", "children": [
          { "object.value": { "name": "Report", "children": [ { "field.string": { "name": "betaVal" } } ] } } ] } }
        """);

        Assert.Equal("alphaVal", Assert.Single(PayloadFieldTree.Build(root, "Report", "acme::alpha")).Name);
        Assert.Equal("betaVal", Assert.Single(PayloadFieldTree.Build(root, "Report", "acme::beta")).Name);
        // No referrer package keeps the permissive global-scan fallback.
        Assert.Single(PayloadFieldTree.Build(root, "Report"));
    }

    private static Assembly Compile(IEnumerable<string> sources)
    {
        var trees = sources.Select(s => CSharpSyntaxTree.ParseText(s, new CSharpParseOptions(LanguageVersion.CSharp12)));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Render.Extract.ExtractSchema).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObject).Assembly.Location));
        refs.Add(MetadataReference.CreateFromFile(typeof(MetaObjects.Codegen.Runtime.ExtractObject).Assembly.Location));
        var comp = CSharpCompilation.Create("vo_reuse_" + Guid.NewGuid().ToString("N"), trees, refs,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var ms = new MemoryStream();
        var emit = comp.Emit(ms);
        var errors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated code should compile, got: " + string.Join("; ", errors));
        return Assembly.Load(ms.ToArray());
    }
}
