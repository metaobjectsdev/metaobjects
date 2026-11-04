// ADR-0062 — the registry records which provider registered each attribute and refuses a
// second provider's claim on the same name. The cross-port scenarios live in
// fixtures/provider-composition-conformance/; this file pins what the shared corpus cannot
// (message text, no-trace-on-refusal, unowned registrations, the shipped core).

using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public sealed class AttrOwnershipTests
{
    private sealed class Probe : IMetaDataTypeProvider
    {
        private readonly Action<TypeRegistry> _register;

        public Probe(string id, Action<TypeRegistry> register, params string[] dependencies)
        {
            Id = id;
            Dependencies = dependencies;
            _register = register;
        }

        public string Id { get; }
        public IReadOnlyList<string> Dependencies { get; }
        public void RegisterTypes(TypeRegistry registry) => _register(registry);
    }

    private static TypeDefinition Def(string subType, params string[] names) =>
        new(
            typeId: new TypeId("template", subType),
            description: "test",
            childRules: new List<ChildRule>(),
            factory: (typeId, name) => new MetaTemplate(typeId, name),
            attributes: names.Select(n => new AttrSchema(n, "string", Required: false, Description: n)).ToList());

    [Fact]
    public void ShadowingRegistrationNamesBothProvidersAndTheAttribute()
    {
        var ex = Assert.Throws<MetaModelException>(() => Provider.ComposeRegistry(new IMetaDataTypeProvider[]
        {
            new Probe("owner-a", r => r.Register(Def("base", "physicalName"))),
            new Probe("owner-b", r => r.Register(Def("probe", "physicalName")), "owner-a"),
        }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_ATTR_SHADOW, ex.Code);
        Assert.Contains("owner-a", ex.Message);
        Assert.Contains("owner-b", ex.Message);
        Assert.Contains("physicalName", ex.Message);
    }

    [Fact]
    public void ExtendOntoTheSharedRootCollidesWithASubtypeName()
    {
        var ex = Assert.Throws<MetaModelException>(() => Provider.ComposeRegistry(new IMetaDataTypeProvider[]
        {
            new Probe("owner-a", r =>
            {
                r.Register(Def("base", "other"));
                r.Register(Def("probe", "physicalName"));
            }),
            new Probe("owner-b", r => r.Extend("template", "base",
                attributes: new List<AttrSchema> { new("physicalName", "string", Required: false, Description: "x") }), "owner-a"),
        }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_ATTR_SHADOW, ex.Code);
    }

    [Fact]
    public void SameSlotExtendByAnotherProviderKeepsAttrConflictAndNamesTheOwner()
    {
        var ex = Assert.Throws<MetaModelException>(() => Provider.ComposeRegistry(new IMetaDataTypeProvider[]
        {
            new Probe("owner-a", r => r.Register(Def("probe", "physicalName"))),
            new Probe("owner-b", r => r.Extend("template", "probe",
                attributes: new List<AttrSchema> { new("physicalName", "string", Required: false, Description: "x") }), "owner-a"),
        }));
        Assert.Equal(ErrorCode.ERR_PROVIDER_ATTR_CONFLICT, ex.Code);
        Assert.Contains("owner-a", ex.Message);
        Assert.Contains("owner-b", ex.Message);
    }

    [Fact]
    public void SiblingSubtypesMayUseOneName()
    {
        var registry = Provider.ComposeRegistry(new IMetaDataTypeProvider[]
        {
            new Probe("owner-a", r => r.Register(Def("probe-a", "physicalName"))),
            new Probe("owner-b", r => r.Register(Def("probe-b", "physicalName")), "owner-a"),
        });
        Assert.Equal("owner-a", registry.AttrOrigin("template", "probe-a", "physicalName"));
        Assert.Equal("owner-b", registry.AttrOrigin("template", "probe-b", "physicalName"));
    }

    [Fact]
    public void RegistrationOutsideAProviderTurnClaimsNothingAndCollidesWithNothing()
    {
        var registry = Provider.ComposeRegistry(new IMetaDataTypeProvider[]
        {
            new Probe("owner-a", r => r.Register(Def("base", "physicalName"))),
        });

        // After compose no provider is running: this registration is unowned, so it is not
        // refused even though owner-a holds the same name on the type's shared root.
        registry.Register(Def("probe", "physicalName"));

        Assert.Equal("owner-a", registry.AttrOrigin("template", "base", "physicalName"));
        Assert.Equal(TypeRegistry.LibrarySentinel, registry.AttrOrigin("template", "probe", "physicalName"));
    }

    [Fact]
    public void RefusedRegistrationLeavesNoTrace()
    {
        bool refused = false;
        var registry = Provider.ComposeRegistry(new IMetaDataTypeProvider[]
        {
            new Probe("owner-a", r => r.Register(Def("base", "physicalName"))),
            new Probe("owner-b", r =>
            {
                try
                {
                    r.Register(Def("probe", "physicalName"));
                }
                catch (MetaModelException)
                {
                    refused = true;
                }
            }, "owner-a"),
        });

        Assert.True(refused);
        Assert.Null(registry.Find("template", "probe"));
        Assert.Equal(TypeRegistry.LibrarySentinel, registry.AttrOrigin("template", "probe", "physicalName"));
    }

    [Fact]
    public void ShippedCoreProvidersComposeWithNoCollisionAndEveryAttrHasAnOwner()
    {
        var registry = Provider.ComposeRegistry(CoreTypes.LibraryProviders);
        var unowned = new List<string>();
        foreach (var id in registry.AllTypes())
        {
            foreach (var attr in registry.AttrsOf(id.Type, id.SubType))
            {
                if (registry.AttrOrigin(id.Type, id.SubType, attr.Name) == TypeRegistry.LibrarySentinel)
                    unowned.Add($"{id}.{attr.Name}");
            }
        }
        Assert.Empty(unowned);
    }
}
