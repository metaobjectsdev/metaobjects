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

    // Final-review fix: the eventual DB column for an int-backed enum is a
    // 32-bit Postgres/SQLite `integer` (design doc D5) — a value outside that
    // range can never actually be persisted, so it must be rejected at load
    // time. Mirrors Java's IntMapAttribute#setValueAsString bound check
    // (this port's generic type check parses integral JSON numbers as
    // `long`, which has no fixed 32-bit width on its own).
    [Fact]
    public void Value_outside_32bit_range_is_rejected()
    {
        var res = TryLoad(Model(""", "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9999999999}"""));
        Assert.Contains(res.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE);
    }

    // An int-backed enum ARRAY loads: this port persists it element-wise (an EF Core
    // primitive collection whose element converter is the @intValueMap pair), so there is
    // no reason to refuse it here.
    [Fact]
    public void An_array_with_its_own_intValueMap_loads_clean()
    {
        var res = TryLoad(Model(""", "isArray": true, "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9}"""));
        Assert.Empty(res.Errors);
    }

    // The shape adopters write: the map on a shared abstract enum, inherited by an array field.
    [Fact]
    public void An_array_inheriting_a_shared_intValueMap_loads_clean()
    {
        var res = TryLoad("""
        { "metadata.root": { "package": "acme", "children": [
          { "field.enum": { "name": "Status", "abstract": true,
              "@values": ["DRAFT","PUBLISHED","ARCHIVED"],
              "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9} } },
          { "object.entity": { "name": "Order", "children": [
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "extends": "acme::Status" } },
            { "field.enum": { "name": "history", "extends": "acme::Status", "isArray": true } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
          ]}}
        ]}}
        """);
        Assert.Empty(res.Errors);
    }

    // The content rules still apply to an array: being an array exempts nothing.
    [Fact]
    public void An_array_with_a_mismatched_intValueMap_is_still_rejected()
    {
        var res = TryLoad(Model(""", "isArray": true, "@intValueMap": {"DRAFT": 0, "PUBLISHED": 5}"""));
        Assert.Contains(res.Errors, e => e.Code == ErrorCode.ERR_BAD_ATTR_VALUE && e.Message.Contains("ARCHIVED"));
    }
}
