// FR-019 — shared + externally-provided enum codegen (C# port).
//
// Mirrors the TS reference (codegen-ts enum-shared / enum-import / enums-file):
//   • shared-materialized-once — a ROOT-level abstract field.enum extended by TWO
//     entities is emitted ONCE (a shared Enums.g.cs, namespace-level `public enum E`),
//     and BOTH entity files REFERENCE it (no nested `public enum E`).
//   • @provided — `@provided: true` emits NOTHING for the type; consuming entities
//     reference `<ProvidedEnumNamespace>.E`; a missing namespace config is a clear
//     codegen-time error.
//   • inline unchanged — a normal nested enum still emits `public enum <Entity><Field>`
//     inside the entity (the byte-identical default; the drift gate also enforces this).

using System.Text.RegularExpressions;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class Fr019SharedEnumCodegenTests
{
    private static MetaRoot Load(string json)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "fr019.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root, string? providedNs = null) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig
        {
            OutDir = "/tmp",
            Namespace = "Acme.Generated",
            ProvidedEnumNamespace = providedNs,
        },
    };

    private const string SharedModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "field.enum": { "name": "OrderStatus", "abstract": true, "@values": ["DRAFT", "PUBLISHED"] } },
      { "object.entity": { "name": "Order", "children": [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "extends": "OrderStatus" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Shipment", "children": [
        { "source.rdb": { "@table": "shipments" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "extends": "OrderStatus" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Shared_enum_materialized_exactly_once_and_referenced_by_both_entities()
    {
        var files = new EntityGenerator().Generate(Ctx(Load(SharedModel))).ToList();

        // A dedicated shared-enums file is emitted, holding the single materialized enum.
        var enumsFile = Assert.Single(files, f => f.Path == "Enums.g.cs");
        Assert.Contains("public enum OrderStatus { DRAFT, PUBLISHED }", enumsFile.Content);

        // The enum is materialized EXACTLY ONCE across the whole emitted set.
        var totalDecls = files.Sum(f => Regex.Matches(f.Content, @"public enum OrderStatus\b").Count);
        Assert.Equal(1, totalDecls);

        // BOTH entity files reference the shared type (no nested redeclaration).
        var order = Assert.Single(files, f => f.Path == "Order.g.cs");
        var shipment = Assert.Single(files, f => f.Path == "Shipment.g.cs");
        foreach (var ef in new[] { order, shipment })
        {
            Assert.DoesNotContain("public enum OrderStatus", ef.Content);
            Assert.Contains("public OrderStatus? Status { get; set; }", ef.Content);
        }
    }

    [Fact]
    public void Shared_enum_set_compiles()
    {
        var files = new EntityGenerator().Generate(Ctx(Load(SharedModel))).ToList();
        var trees = files.Select(f =>
            Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree.ParseText(
                f.Content,
                new Microsoft.CodeAnalysis.CSharp.CSharpParseOptions(Microsoft.CodeAnalysis.CSharp.LanguageVersion.CSharp12)))
            .ToList();
        var refs = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator).Where(p => p.Length > 0)
            .Select(p => (Microsoft.CodeAnalysis.MetadataReference)Microsoft.CodeAnalysis.MetadataReference.CreateFromFile(p))
            .ToList();
        var comp = Microsoft.CodeAnalysis.CSharp.CSharpCompilation.Create(
            "fr019shared_" + Guid.NewGuid().ToString("N"),
            trees, refs,
            new Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions(Microsoft.CodeAnalysis.OutputKind.DynamicallyLinkedLibrary));
        var errors = comp.GetDiagnostics()
            .Where(d => d.Severity == Microsoft.CodeAnalysis.DiagnosticSeverity.Error)
            .Select(d => $"{d.Id}: {d.GetMessage()}").ToList();
        Assert.True(errors.Count == 0, "shared-enum set should compile, got: " + string.Join("; ", errors));
    }

    private const string ProvidedModel = """
    { "metadata.root": { "package": "acme", "children": [
      { "field.enum": { "name": "ContactMethod", "abstract": true, "@values": ["EMAIL", "PHONE"], "@provided": true } },
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "preferred", "extends": "ContactMethod" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    [Fact]
    public void Provided_enum_is_not_materialized_and_referenced_via_configured_namespace()
    {
        var files = new EntityGenerator().Generate(Ctx(Load(ProvidedModel), providedNs: "Acme.External.Enums")).ToList();

        // NOTHING is emitted for the provided type: no shared file, no nested decl.
        Assert.DoesNotContain(files, f => f.Path == "Enums.g.cs");
        Assert.All(files, f => Assert.DoesNotContain("public enum ContactMethod", f.Content));

        // The consuming entity references the externally-provided type at the configured namespace.
        var customer = Assert.Single(files, f => f.Path == "Customer.g.cs");
        Assert.Contains("public Acme.External.Enums.ContactMethod? Preferred { get; set; }", customer.Content);
    }

    [Fact]
    public void Provided_enum_without_configured_namespace_is_a_codegen_error()
    {
        var ex = Assert.Throws<InvalidOperationException>(() =>
            new EntityGenerator().Generate(Ctx(Load(ProvidedModel), providedNs: null)).ToList());

        Assert.Contains("ContactMethod", ex.Message);
        Assert.Contains("ProvidedEnumNamespace", ex.Message);
    }

    [Fact]
    public void Inline_enum_still_emits_nested_declaration_unchanged()
    {
        const string inlineModel = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var files = new EntityGenerator().Generate(Ctx(Load(inlineModel))).ToList();

        // No shared file for an inline enum.
        Assert.DoesNotContain(files, f => f.Path == "Enums.g.cs");
        var order = Assert.Single(files, f => f.Path == "Order.g.cs");
        // Nested, per-entity enum type name (<Entity><Field>) — exactly as before FR-019.
        Assert.Contains("public enum OrderStatus { DRAFT, PUBLISHED, ARCHIVED }", order.Content);
        Assert.Contains("public OrderStatus? Status { get; set; }", order.Content);
    }
}
