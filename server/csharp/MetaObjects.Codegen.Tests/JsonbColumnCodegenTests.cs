// Jsonb open-bag codegen tests (TDD) — issue #98.
//
// A field.string carrying @dbColumnType:jsonb is the sanctioned "open JSON bag":
// the physical column is jsonb (returns a PARSED JSON value), so the generated
// entity property must be a JSON-value CLR type — System.Text.Json.JsonDocument —
// NOT string. This mirrors the TS fix (#97, z.unknown()) and Python (#99, Any):
// the API/wire boundary exposes a real JSON object, not a double-encoded string.
//
// Guards:
//   * field.string @dbColumnType:jsonb  → JsonDocument? property + System.Text.Json using.
//   * field.string @dbColumnType:uuid   → stays string? (string↔Guid converter is a DB
//                                         concern; the CLR property is unchanged — ADR-0013).
//   * plain field.string                → stays string?.
//   * DbContext still emits .HasColumnType("jsonb") for the jsonb field.

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class JsonbColumnCodegenTests
{
    // An entity with a jsonb open-bag field, a uuid-override field, and a plain
    // string field — so the three type-mapping paths are asserted together.
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Asset", "children": [
        { "source.rdb": { "@table": "assets" } },
        { "field.string": { "name": "id" } },
        { "field.string": { "name": "payload",    "@dbColumnType": "jsonb" } },
        { "field.string": { "name": "externalId", "@dbColumnType": "uuid" } },
        { "field.string": { "name": "label" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load(string json)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "test.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Jsonb_field_emits_JsonDocument_property_not_string()
    {
        var ctx = Ctx(Load(Model));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // The open-JSON bag surfaces as a parsed JSON value, not raw text.
        Assert.Contains("public JsonDocument? Payload { get; set; }", src);
        // Guard: the string form must NOT appear for the jsonb field.
        Assert.DoesNotContain("public string? Payload", src);
        Assert.DoesNotContain("public string Payload", src);
        // The JsonDocument type requires the System.Text.Json namespace.
        Assert.Contains("using System.Text.Json;", src);
    }

    [Fact]
    public void Uuid_override_field_stays_string()
    {
        var ctx = Ctx(Load(Model));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        // @dbColumnType:uuid keeps the CLR property a string (string↔Guid is a DB-side
        // value converter, ADR-0013) — only jsonb shifts the CLR type.
        Assert.Contains("public string? ExternalId { get; set; }", src);
    }

    [Fact]
    public void Plain_string_field_stays_string()
    {
        var ctx = Ctx(Load(Model));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        Assert.Contains("public string? Label { get; set; }", src);
    }

    [Fact]
    public void Jsonb_field_still_maps_to_jsonb_column_in_dbcontext()
    {
        var ctx = Ctx(Load(Model));
        var dbCtx = Assert.Single(new DbContextGenerator().Generate(ctx)).Content;

        Assert.Contains(
            "modelBuilder.Entity<Asset>().Property(x => x.Payload).HasColumnType(\"jsonb\");",
            dbCtx);
    }

    [Fact]
    public void Generated_jsonb_entity_compiles()
    {
        var ctx = Ctx(Load(Model));
        var src = Assert.Single(new EntityGenerator().Generate(ctx)).Content;

        var tree = CSharpSyntaxTree.ParseText(src, new CSharpParseOptions(LanguageVersion.CSharp12));
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("jsonb_" + Guid.NewGuid().ToString("N"),
            [tree], refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated jsonb entity should compile, got: " + string.Join("; ", errors));
    }
}
