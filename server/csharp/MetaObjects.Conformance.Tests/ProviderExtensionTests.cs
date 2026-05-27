// ProviderExtensionTests — C# parity with TS sdk/test/memory-providers.test.ts.
//
// Verifies the cross-port provider-extension contract:
//   - composing a custom provider on top of the core bundle registers
//     the new subtype, AND keeps the core subtypes recognized.
//   - duplicate ids / missing deps / cycles surface the stable error
//     codes via Provider.ComposeRegistry.
//
// The C# port has no LoadMemory-style SDK wrapper — its supported entry
// is MetaDataLoader.FromDirectory(dir, registry). The same provider model
// applies; this test exercises the composition layer end-to-end.

using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ProviderExtensionTests
{
    /// <summary>A minimal third-party provider that registers a new field subtype.</summary>
    private sealed class GeoProvider : IMetaDataTypeProvider
    {
        public string Id => "test-geo";
        public IReadOnlyList<string> Dependencies => new[] { "metaobjects-core-types" };

        public void RegisterTypes(TypeRegistry registry)
        {
            registry.Register(new TypeDefinition(
                typeId: new TypeId("field", "geopoint"),
                description: "A geographic point field",
                childRules: new List<ChildRule>(),
                factory: (typeId, name) => new MetaField(typeId, name),
                attributes: new List<AttrSchema>()));
        }
    }

    private sealed class NoopProvider(string id, params string[] deps) : IMetaDataTypeProvider
    {
        public string Id { get; } = id;
        public IReadOnlyList<string> Dependencies { get; } = deps;
        public void RegisterTypes(TypeRegistry registry) { }
    }

    [Fact]
    public void Composing_custom_provider_on_top_of_core_registers_new_subtype()
    {
        var providers = new IMetaDataTypeProvider[]
        {
            CoreTypes.CoreTypesProvider,
            new GeoProvider(),
        };
        var registry = Provider.ComposeRegistry(providers);

        Assert.True(registry.Has("field", "geopoint"));
        // Core subtypes still recognized.
        Assert.True(registry.Has("field", "string"));
        Assert.True(registry.Has("object", "entity"));
    }

    [Fact]
    public void Composing_only_third_party_provider_does_not_register_core_subtypes()
    {
        // The third-party provider declares a dep on metaobjects-core-types, so
        // composing it alone surfaces ERR_PROVIDER_MISSING_DEPENDENCY.
        var ex = Assert.Throws<MetaModelException>(() =>
            Provider.ComposeRegistry(new IMetaDataTypeProvider[] { new GeoProvider() }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY, ex.Code);
    }

    [Fact]
    public void Duplicate_provider_id_surfaces_ERR_PROVIDER_DUPLICATE_ID()
    {
        var ex = Assert.Throws<MetaModelException>(() =>
            Provider.ComposeRegistry(new IMetaDataTypeProvider[]
            {
                new NoopProvider("dup"),
                new NoopProvider("dup"),
            }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_DUPLICATE_ID, ex.Code);
    }

    [Fact]
    public void Missing_dependency_surfaces_ERR_PROVIDER_MISSING_DEPENDENCY()
    {
        var ex = Assert.Throws<MetaModelException>(() =>
            Provider.ComposeRegistry(new IMetaDataTypeProvider[]
            {
                new NoopProvider("needs-x", "does-not-exist"),
            }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY, ex.Code);
    }

    [Fact]
    public void Dependency_cycle_surfaces_ERR_PROVIDER_DEPENDENCY_CYCLE()
    {
        var ex = Assert.Throws<MetaModelException>(() =>
            Provider.ComposeRegistry(new IMetaDataTypeProvider[]
            {
                new NoopProvider("cycle-a", "cycle-b"),
                new NoopProvider("cycle-b", "cycle-a"),
            }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE, ex.Code);
    }

    [Fact]
    public void Conformance_adapter_accepts_provider_id_list_and_threads_through()
    {
        // The ConformanceAdapter's PROVIDERS map is the public seam tests
        // exercise; LoadFixture(inputDir, providerIds) resolves ids to providers
        // and composes via ComposeRegistry. An unknown id throws — same as TS.
        var ex = Assert.Throws<ArgumentException>(() =>
            ConformanceAdapter.LoadFixture(
                AppContext.BaseDirectory,
                new[] { "does-not-exist-provider" }));
        Assert.Contains("does-not-exist-provider", ex.Message);
    }
}
