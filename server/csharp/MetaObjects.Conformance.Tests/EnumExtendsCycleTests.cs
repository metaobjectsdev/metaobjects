// A cyclic `extends` between two field.enum nodes that declare no @values must load to the
// loader's ordinary errors. Reading the effective @values of either node walks the chain, and
// the C# loader does not reject a cycle before the validation passes run, so an unguarded walk
// overflows the stack and takes the process down with no diagnostic.
//
// The expected codes are the TypeScript reference loader's answer for this same input:
// ERR_MISSING_REQUIRED_ATTR (neither node resolves a @values) and ERR_BAD_ATTR_VALUE (the
// @default is not a member of an empty set).

using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class EnumExtendsCycleTests
{
    private const string CyclicEnums = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "A", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "x", "extends": "acme::B.y", "@default": "Q" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } },
          { "object.entity": { "name": "B", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "y", "extends": "acme::A.x" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ] } }
        ] } }
        """;

    [Fact]
    public void Cyclic_enum_extends_loads_to_ordinary_errors()
    {
        var result = MetaDataLoader.FromString(CyclicEnums, MetaDataFormat.Json);

        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_MISSING_REQUIRED_ATTR);
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Effective_enum_values_of_a_cyclic_chain_is_null()
    {
        var result = MetaDataLoader.FromString(CyclicEnums, MetaDataFormat.Json);

        var cyclic = result.Root!.Objects()
            .SelectMany(o => o.Children())
            .OfType<MetaField>()
            .Where(f => f.Name is "x" or "y")
            .ToList();
        Assert.Equal(2, cyclic.Count);
        Assert.All(cyclic, f => Assert.Null(f.EffectiveEnumValues));
    }
}
