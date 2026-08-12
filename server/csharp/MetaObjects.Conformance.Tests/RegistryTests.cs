using System.Linq;
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

    // ADR-0050 — a concern provider may only PROJECT OPTIONAL attributes onto a
    // type it does not own (via Extend). A required attr projected this way makes
    // the target type's validity depend on a provider that can be composed out —
    // exactly how FR-033 broke template.*'s @payloadRef in all five ports. Mirrors
    // TS's "extends with a REQUIRED attr -> throws" test in provider-data.test.ts.

    private static TypeRegistry RegistryWithFieldString()
    {
        var reg = new TypeRegistry();
        reg.Register(new TypeDefinition(
            new TypeId("field", "string"), "test field.string",
            new List<ChildRule>(), (id, n) => throw new System.NotImplementedException(),
            new List<AttrSchema>()));
        return reg;
    }

    [Fact]
    public void Extend_with_a_required_attr_throws_ERR_EXTEND_REQUIRED_ATTR()
    {
        var reg = RegistryWithFieldString();

        var ex = Assert.Throws<MetaModelException>(() => reg.Extend(
            "field",
            "string",
            attributes: new[]
            {
                new AttrSchema("mustBeThere", "string", Required: true,
                    Description: "A required attr a concern has no business projecting."),
            }));

        Assert.Equal(ErrorCode.ERR_EXTEND_REQUIRED_ATTR, ex.Code);
        // Fails CLOSED — the attr must not be half-applied.
        Assert.DoesNotContain(
            reg.Find("field", "string")!.Attributes,
            a => a.Name == "mustBeThere");
    }

    [Fact]
    public void Extend_with_an_optional_attr_applies_normally()
    {
        var reg = RegistryWithFieldString();

        reg.Extend(
            "field",
            "string",
            attributes: new[]
            {
                new AttrSchema("storage", "string", Required: false,
                    Default: "jsonb",
                    AllowedValues: new[] { "flattened", "jsonb", "subdocument" },
                    Description: "Storage strategy."),
            });

        var attr = reg.Find("field", "string")!.Attributes.Single(a => a.Name == "storage");
        Assert.False(attr.Required);
        Assert.Equal("jsonb", attr.Default);
        Assert.Equal(
            new[] { "flattened", "jsonb", "subdocument" },
            attr.AllowedValues!.Cast<string>());
    }
}

/// <summary>Test-only provider whose registerTypes is a no-op.</summary>
file sealed class DelegateProvider(string id, string[] deps) : IMetaDataTypeProvider
{
    public string Id => id;
    public IReadOnlyList<string> Dependencies => deps;
    public void RegisterTypes(TypeRegistry registry) { }
}
