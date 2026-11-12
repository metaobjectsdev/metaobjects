// @collectionName is shared vocabulary: an object's collection name (the EF Core DbSet property).
// It is in the shared registry marked implementedIn ["csharp"], so every port loads and
// type-checks it. It loads under the strict
// loader on object.entity / projection / report.

using System.Text.Json;
using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class CollectionNameVocabularyTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Diagnosis", "@collectionName": "Diagnosis", "children": [
            { "source.rdb": { "@table": "diagnoses" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ] } }
        ] } }
        """;

    [Fact]
    public void A_strict_load_accepts_collectionName_on_an_entity()
    {
        var result = new MetaDataLoader(Provider.ComposeRegistry(CoreTypes.LibraryProviders), strict: true)
            .Load([new InMemoryStringSource(Model, id: "meta.json")]);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        Assert.Equal("Diagnosis", result.Root.Objects().Single().OwnAttr("collectionName"));
    }

    [Fact]
    public void A_strict_load_refuses_the_never_released_dbSetName()
    {
        var result = new MetaDataLoader(Provider.ComposeRegistry(CoreTypes.LibraryProviders), strict: true)
            .Load([new InMemoryStringSource(Model.Replace("@collectionName", "@dbSetName"), id: "meta.json")]);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_ATTR);
    }

    [Fact]
    public void It_is_shared_vocabulary_marked_by_implementing_port()
    {
        Assert.Equal(RegistryManifest.ExclusionReason.Included, RegistryManifest.ClassifyPerTypeAttr("collectionName"));
        var registry = Provider.ComposeRegistry(CoreTypes.LibraryProviders);
        var attr = registry.Find("object", "entity")!.Attributes.Single(a => a.Name == "collectionName");
        Assert.Equal(new[] { "csharp" }, attr.ImplementedIn);
    }
    [Fact]
    public void The_standard_pluralizer_matches_the_shared_naming_conformance_corpus()
    {
        string repoRoot = Path.GetDirectoryName(Path.GetDirectoryName(CorpusRoot.Path)!)!;
        using var doc = JsonDocument.Parse(File.ReadAllText(
            Path.Combine(repoRoot, "fixtures", "naming-conformance", "already-plural-pluralize.json")));
        var cases = doc.RootElement.GetProperty("cases").EnumerateArray().ToList();
        Assert.NotEmpty(cases);
        foreach (var c in cases)
        {
            string name = c.GetProperty("name").GetString()!;
            Assert.Equal((name, c.GetProperty("apiPlural").GetString()), (name, CollectionNames.StandardPluralize(name)));
        }
    }

    [Theory]
    [InlineData(null, "CaseHistories")]
    [InlineData("standard", "CaseHistories")]
    [InlineData("none", "CaseHistory")]
    public void An_object_without_collectionName_takes_the_project_pluralizer(string? collections, string expected)
    {
        const string model = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "CaseHistory", "children": [ { "field.long": { "name": "id" } } ] } },
              { "object.entity": { "name": "Diagnosis", "@collectionName": "DiagnosisRows", "children": [ { "field.long": { "name": "id" } } ] } }
            ] } }
            """;
        var result = new MetaDataLoader(Provider.ComposeRegistry(CoreTypes.LibraryProviders), strict: true)
            .Load([new InMemoryStringSource(model, id: "meta.json")]);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        result.Root.PhysicalNaming = PhysicalNaming.Default with { Collections = collections };
        var objects = result.Root.Objects().ToDictionary(o => o.Name);
        Assert.Equal(expected, CollectionNames.Of(objects["CaseHistory"]));
        Assert.Equal("DiagnosisRows", CollectionNames.Of(objects["Diagnosis"]));
    }
}
