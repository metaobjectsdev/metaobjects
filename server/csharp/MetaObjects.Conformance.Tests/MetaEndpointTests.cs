using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class MetaEndpointTests
{
    [Fact]
    public void MetaRoutePath_is_the_cross_port_contract_value()
    {
        Assert.Equal("/_meta", MetaEndpoint.MetaRoutePath);
    }

    [Fact]
    public void MetaJson_returns_the_effective_canonical_serialization()
    {
        var root = LoadExtendsFixture();
        Assert.Empty(root.Errors);

        var expected = SerializerJson.CanonicalSerializeEffective(root.Root);
        var actual = MetaEndpoint.MetaJson(root.Root);

        Assert.Equal(expected, actual);
    }

    private static LoadResult LoadExtendsFixture()
    {
        // Load the extends-abstract-base conformance fixture.
        // This fixture has a BaseEntity with inherited fields (id, createdAt)
        // and a Subscriber that extends it, allowing us to verify the effective
        // serialization materializes the super-chain merge.
        // Walk up from AppContext.BaseDirectory to find fixtures/conformance/
        string root = System.AppContext.BaseDirectory;
        while (!System.IO.Directory.Exists(System.IO.Path.Combine(root, "fixtures", "conformance")))
        {
            var parent = System.IO.Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new System.InvalidOperationException("fixtures/conformance not found walking up from " + System.AppContext.BaseDirectory);
            root = parent;
        }

        var fixtureDir = System.IO.Path.Combine(root, "fixtures", "conformance", "extends-abstract-base", "input");
        return MetaDataLoader.FromDirectory(fixtureDir);
    }
}
