// Int-backed-enum-values plan, Task 6 — C# port of field.enum's @intValueMap.
//
// Mirrors the TS reference (Task 1/2/3): a new attr.intMap subtype (object-shaped,
// all-integer values) plus field.enum-specific content-rule validation (key-set
// equals @values, no duplicate values), reusing ERR_BAD_ATTR_VALUE.

using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class EnumIntValueMapTests
{
    private static string Model(string extra) => """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "status", "@values": ["DRAFT","PUBLISHED","ARCHIVED"] EXTRA_PLACEHOLDER } },
        { "identity.primary": { "name": "pk", "@fields": ["id"] } }
      ]}}
    ]}}
    """.Replace("EXTRA_PLACEHOLDER", extra);

    private static LoadResult TryLoad(string json)
    {
        var registry = FullCoreRegistry.Compose();
        var loader = new MetaDataLoader(registry);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "test.json"),
        });
    }

    [Fact]
    public void Valid_intValueMap_with_matching_keys_and_unique_ints_loads_clean()
    {
        var res = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}"""));
        Assert.Empty(res.Errors);
    }

    [Fact]
    public void No_intValueMap_still_loads_clean_string_backed_default()
    {
        var res = TryLoad(Model(""));
        Assert.Empty(res.Errors);
    }

    [Fact]
    public void Missing_member_key_is_rejected()
    {
        var res = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}"""));
        Assert.Contains(res.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("ARCHIVED"));
    }

    [Fact]
    public void Extra_key_not_in_values_is_rejected()
    {
        var res = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9, "RETRACTED": 12}"""));
        Assert.Contains(res.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("RETRACTED"));
    }

    [Fact]
    public void Non_integer_value_is_rejected()
    {
        var res = TryLoad(Model(""", "@intValueMap": {"DRAFT": "zero", "PUBLISHED": 5, "ARCHIVED": 9}"""));
        Assert.Contains(res.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    [Fact]
    public void Duplicate_int_value_across_members_is_rejected()
    {
        var res = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 0, "ARCHIVED": 9}"""));
        Assert.Contains(res.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE
            && e.Message.Contains("DRAFT") && e.Message.Contains("PUBLISHED"));
    }
}
