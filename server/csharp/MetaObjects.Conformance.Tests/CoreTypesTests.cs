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

    // ------------------------------------------------------------------
    // Per-base-type subtype list assertions (replaces the single
    // hardcoded "exactly N type definitions" count that used to bump on
    // every new subtype). When a subtype is added, only the matching
    // family's test fails — the diff name points straight at the
    // affected family rather than a global integer.
    //
    // The constants (FIELD_SUBTYPES, OBJECT_SUBTYPES, etc.) come from
    // the metamodel-constants barrel in GlobalUsings.cs.
    // ------------------------------------------------------------------

    private static TypeRegistry ComposedRegistry() =>
        Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_metadata()
    {
        var reg = ComposedRegistry();
        Assert.Equal(METADATA_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_METADATA).OrderBy(s => s));
    }

    // The default-subType designations that let a bare `metadata:` / `object:`
    // YAML key desugar to `metadata.root` / `object.entity`. Regression guard for
    // the bootstrap path that, when broken, leaves these unset and makes a bare
    // `metadata:` root fail with "type 'metadata' has no default subType".
    [Fact]
    public void Core_provider_designates_default_subtypes_for_bare_keys()
    {
        var reg = ComposedRegistry();
        Assert.Equal(SUBTYPE_ROOT, reg.DefaultSubTypeOf(TYPE_METADATA));
        Assert.Equal(OBJECT_SUBTYPE_ENTITY, reg.DefaultSubTypeOf(TYPE_OBJECT));
        // A type with no designated default returns null (not an arbitrary subType).
        Assert.Null(reg.DefaultSubTypeOf(TYPE_FIELD));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_object()
    {
        var reg = ComposedRegistry();
        Assert.Equal(OBJECT_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_OBJECT).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_field()
    {
        var reg = ComposedRegistry();
        Assert.Equal(FIELD_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_FIELD).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_attr()
    {
        var reg = ComposedRegistry();
        Assert.Equal(ATTR_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_ATTR).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_validator()
    {
        var reg = ComposedRegistry();
        Assert.Equal(VALIDATOR_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_VALIDATOR).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_view()
    {
        var reg = ComposedRegistry();
        Assert.Equal(VIEW_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_VIEW).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_layout()
    {
        var reg = ComposedRegistry();
        Assert.Equal(LAYOUT_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_LAYOUT).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_identity()
    {
        var reg = ComposedRegistry();
        Assert.Equal(IDENTITY_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_IDENTITY).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_relationship()
    {
        var reg = ComposedRegistry();
        Assert.Equal(RELATIONSHIP_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_RELATIONSHIP).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_source()
    {
        var reg = ComposedRegistry();
        Assert.Equal(SOURCE_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_SOURCE).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_origin()
    {
        var reg = ComposedRegistry();
        Assert.Equal(ORIGIN_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_ORIGIN).OrderBy(s => s));
    }

    [Fact]
    public void Core_provider_registers_correct_subtypes_for_template()
    {
        var reg = ComposedRegistry();
        Assert.Equal(TEMPLATE_SUBTYPES.OrderBy(s => s),
                     reg.AllSubTypesOf(TYPE_TEMPLATE).OrderBy(s => s));
    }
}
