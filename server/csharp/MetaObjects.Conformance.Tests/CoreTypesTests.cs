using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class CoreTypesTests
{
    [Fact]
    public void Core_provider_registers_the_metamodel_vocabulary()
    {
        var reg = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        Assert.Equal("metaobjects-core-types", CoreTypes.CoreTypesProvider.Id);
        Assert.True(reg.Has("metadata", "root"));
        Assert.True(reg.Has("object", "entity"));
        Assert.True(reg.Has("field", "currency"));
        Assert.True(reg.Has("identity", "primary"));
        Assert.True(reg.Has("origin", "aggregate"));
        Assert.False(reg.Has("identity", "base")); // identity has NO base subtype
    }

    [Fact]
    public void Core_provider_factory_builds_the_right_node_class()
    {
        var reg = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var def = reg.Find("identity", "primary")!;
        var node = def.Factory(def.TypeId, "pk");
        Assert.IsType<MetaObjects.Meta.MetaPrimaryIdentity>(node);
    }

    [Fact]
    public void Core_provider_registers_exactly_70_types()
    {
        // Guard: if a subtype array gains an entry without a matching
        // FieldDataType / AttrDataType mapping, RegisterCoreTypeDefs throws and
        // this test catches the mismatch before it reaches downstream callers.
        // 70 = 64 + template.{base,prompt,output} + origin.collection + identity.reference (FR-003/004) + field.enum.
        var reg = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        Assert.Equal(70, reg.AllTypes().Count);
    }
}
