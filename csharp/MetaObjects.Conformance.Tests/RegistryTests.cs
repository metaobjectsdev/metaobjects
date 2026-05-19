using MetaObjects;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class RegistryTests
{
    [Fact]
    public void Register_then_find_round_trips()
    {
        var reg = new TypeRegistry();
        var def = new TypeDefinition(
            new TypeId("object", "entity"), "test", new List<ChildRule>(),
            (id, name) => throw new System.NotImplementedException(),
            new List<AttrSchema>());
        reg.Register(def);
        Assert.True(reg.Has("object", "entity"));
        Assert.Equal(new[] { "entity" }, reg.AllSubTypesOf("object"));
        Assert.Same(def, reg.Find("object", "entity"));
    }

    [Fact]
    public void Register_duplicate_throws()
    {
        var reg = new TypeRegistry();
        TypeDefinition Make() => new(new TypeId("object", "entity"), "t",
            new List<ChildRule>(), (id, n) => throw new System.NotImplementedException(),
            new List<AttrSchema>());
        reg.Register(Make());
        Assert.Throws<System.InvalidOperationException>(() => reg.Register(Make()));
    }

    [Fact]
    public void ComposeRegistry_detects_a_dependency_cycle()
    {
        var a = new DelegateProvider("a", new[] { "b" });
        var b = new DelegateProvider("b", new[] { "a" });
        var ex = Assert.Throws<MetaModelException>(() => Provider.ComposeRegistry(new[] { a, b }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE, ex.Code);
    }
}

/// <summary>Test-only provider whose registerTypes is a no-op.</summary>
file sealed class DelegateProvider(string id, string[] deps) : IMetaDataTypeProvider
{
    public string Id => id;
    public IReadOnlyList<string> Dependencies => deps;
    public void RegisterTypes(TypeRegistry registry) { }
}
