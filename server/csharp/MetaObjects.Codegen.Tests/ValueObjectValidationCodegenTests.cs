using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// Program D — value-object jsonb columns (field.object @storage:jsonb, single AND @isArray)
// must be POST-able + PATCH-able with FULL nested validation. Mirrors the gate fixture
// (fixtures/api-contract-conformance/jsonb): a reused Marker VO (label @required @maxLength 40)
// on a required single column, a nullable single column, and a nullable array column.
public class ValueObjectValidationCodegenTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::store", "children": [
      { "object.value": { "name": "Marker", "children": [
        { "field.string": { "name": "label", "@required": true, "@maxLength": 40 } },
        { "field.int":    { "name": "score" } }
      ]}},
      { "object.entity": { "name": "Document", "children": [
        { "source.rdb":   { "@table": "documents" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title", "@required": true, "@maxLength": 200 } },
        { "field.object": { "name": "primaryMarker",  "@objectRef": "Marker", "@storage": "jsonb", "@required": true } },
        { "field.object": { "name": "optionalMarker", "@objectRef": "Marker", "@storage": "jsonb" } },
        { "field.object": { "name": "markers",        "@objectRef": "Marker", "@storage": "jsonb", "isArray": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "vo.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Store.Generated" },
    };

    [Fact]
    public void Marker_poco_carries_validation_and_json_property_name_attributes()
    {
        var files = new EntityGenerator().Generate(Ctx(Load())).ToList();
        var marker = files.Single(f => f.Path == "Marker.g.cs").Content;

        // The VO's own members carry validation DataAnnotations so a nested VO validates in
        // FULL on POST/PATCH: label is required (non-empty) AND <= 40 chars.
        Assert.Contains("[Required(AllowEmptyStrings = true)]", marker);
        Assert.Contains("[MaxLength(40)]", marker);
        // [JsonPropertyName] pins the owned-JSON element name (+ wire name) to the metadata
        // field name so EF Core 8 storage matches the shared seed + cross-port wire contract.
        Assert.Contains("[JsonPropertyName(\"label\")]", marker);
        Assert.Contains("[JsonPropertyName(\"score\")]", marker);
        // A VO POCO still carries NO EF-mapping attributes (JSON mapping is fluent, .ToJson).
        Assert.DoesNotContain("[Column(", marker);
        Assert.DoesNotContain("[Key]", marker);
    }

    [Fact]
    public void Routes_emit_typed_vo_merge_arms_and_post_validation()
    {
        var files = new RoutesGenerator().Generate(Ctx(Load())).ToList();
        var routes = files.Single(f => f.Path == "DocumentRoutes.g.cs").Content;

        // PATCH merge — a typed arm per VO column (keyed on the wire field name), assigning
        // the CLR owned-nav property (EF .ToJson persists via full-document replacement).
        Assert.Contains("\"primaryMarker\"", routes);
        Assert.Contains("\"optionalMarker\"", routes);
        Assert.Contains("\"markers\"", routes);
        Assert.Contains("existing.OptionalMarker = null;", routes);        // nullable single: present-null clears
        Assert.Contains("existing.Markers = null;", routes);              // nullable array: present-null clears
        Assert.Contains("Deserialize<Marker>", routes);                  // single VO
        Assert.Contains("Deserialize<System.Collections.Generic.List<Marker>>", routes); // array VO
        // Recursive VO validation on BOTH PATCH and POST.
        Assert.Contains("ValueObjectValidator.Validate", routes);
        Assert.Contains("ValueObjectValidator.Validate(input.PrimaryMarker)", routes);
    }

    [Fact]
    public void Generated_entity_and_value_object_compile_together()
    {
        // The VO POCO now carries validation DataAnnotations + [JsonPropertyName]; verify the
        // added usings compile (the full generated server incl. routes is compiled by the
        // integration generated lane). Entity + VO only — no ASP.NET reference needed.
        var ctx = Ctx(Load());
        // §A6 (task 4) — the entity now references its names artifact.
        var files = new EntityGenerator().Generate(ctx)
            .Concat(new NamesGenerator().Generate(ctx)).ToList();
        var trees = files.Select(f =>
            CSharpSyntaxTree.ParseText(f.Content, new CSharpParseOptions(LanguageVersion.CSharp12))).ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p)).ToList();
        var comp = CSharpCompilation.Create("vocompile_" + Guid.NewGuid().ToString("N"),
            trees, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var errors = comp.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "generated VO entity should compile, got: " + string.Join("; ", errors));
    }
}
