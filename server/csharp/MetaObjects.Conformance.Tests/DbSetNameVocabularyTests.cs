// @dbSetName is C#-only vocabulary: the EF Core DbSet property name the generated context gives
// an object. It loads under the strict loader on object.entity / projection / report, and it is a
// per-port binding (ExclusionReason.NativeBinding), carved out of the cross-port registry manifest
// the way Java's @object / @objectAdapter are, so it never reads as vocabulary the other ports
// are expected to implement.

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
    public void It_is_a_port_binding_not_cross_port_vocabulary()
    {
        Assert.Equal(RegistryManifest.ExclusionReason.NativeBinding, RegistryManifest.ClassifyPerTypeAttr("dbSetName"));
    }
}
