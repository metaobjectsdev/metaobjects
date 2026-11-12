// @collectionName is shared vocabulary: an object's collection name (the EF Core DbSet property).
// It is in the shared registry marked implementedIn ["csharp"], so every port loads and
// type-checks it. It loads under the strict
// loader on object.entity / projection / report.

using MetaObjects;
using MetaObjects.Loader;
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
}
