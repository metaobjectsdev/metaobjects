using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class InstanceArtifactsTests
{
    private const string Model = """
    {
      "metadata.root": {
        "package": "acme::ia",
        "children": [
          { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.long": { "name": "id" } }
          ] } },
          { "object.entity": { "name": "Concrete", "children": [
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } }
        ]
      }
    }
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "ia.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    [Fact]
    public void Abstract_entity_is_abstract_and_emits_no_instance_artifacts()
    {
        var root = Load();
        var @base = Assert.Single(root.Objects(), o => o.Name == "Base");

        Assert.True(InstanceArtifacts.IsAbstract(@base));
        Assert.False(InstanceArtifacts.EmitsInstanceArtifacts(@base));
    }

    [Fact]
    public void Concrete_entity_is_not_abstract_and_emits_instance_artifacts()
    {
        var root = Load();
        var concrete = Assert.Single(root.Objects(), o => o.Name == "Concrete");

        Assert.False(InstanceArtifacts.IsAbstract(concrete));
        Assert.True(InstanceArtifacts.EmitsInstanceArtifacts(concrete));
    }
}
