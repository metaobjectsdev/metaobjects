// @dbSetName is C#-only vocabulary: the EF Core DbSet property name the generated
// context gives an object. It is in the shared registry with `ports: ["csharp"]`, so every port
// loads and type-checks it and only C# acts on it. It loads under the strict loader on
// object.entity / projection / report.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class DbSetNameVocabularyTests
{
    private const string Model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Diagnosis", "@dbSetName": "Diagnosis", "children": [
            { "source.rdb": { "@table": "diagnoses" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "@fields": "id" } }
          ] } }
        ] } }
        """;

    [Fact]
    public void A_strict_load_accepts_dbSetName_on_an_entity()
    {
        var result = new MetaDataLoader(Provider.ComposeRegistry(CoreTypes.LibraryProviders), strict: true)
            .Load([new InMemoryStringSource(Model, id: "meta.json")]);
        Assert.Empty(result.Errors.Select(e => e.Code + ": " + e.Message));
        Assert.Equal("Diagnosis", result.Root.Objects().Single().OwnAttr("dbSetName"));
    }

    [Fact]
    public void It_is_shared_vocabulary_scoped_to_csharp()
    {
        Assert.Equal(RegistryManifest.ExclusionReason.Included, RegistryManifest.ClassifyPerTypeAttr("dbSetName"));
        var registry = Provider.ComposeRegistry(CoreTypes.LibraryProviders);
        var attr = registry.Find("object", "entity")!.Attributes.Single(a => a.Name == "dbSetName");
        Assert.Equal(new[] { "csharp" }, attr.Ports);
    }
}
