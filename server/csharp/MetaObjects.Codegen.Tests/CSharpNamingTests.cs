// CSharpNaming — field-subtype → C# scalar binding.
//
// These pin the engine-independent native-type binding that survived the
// migrate-engine removal: the logical field subtype maps to a fixed C# type
// regardless of any physical @dbColumnType override (ADR-0013).

using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class CSharpNamingTests
{
    [Fact]
    public void Field_uuid_binds_to_native_Guid()
    {
        Assert.Equal("Guid", CSharpNaming.ScalarFor(FIELD_SUBTYPE_UUID));
        Assert.True(CSharpNaming.IsValueType("Guid"));
    }

    [Fact]
    public void Field_string_stays_a_string_native_binding()
    {
        // The logical subtype field.string → C# `string`, even when a physical
        // @dbColumnType:uuid override shifts only the DB column type (ADR-0013).
        Assert.Equal("string", CSharpNaming.ScalarFor(FIELD_SUBTYPE_STRING));
    }

    // ---- RoutePath: the cross-port collection-URL spelling -------------------
    //
    // One rule in all five ports: the ENTITY NAME snake_cased, then pluralized.
    // The multi-word and consonant+y axes are also gated end-to-end by
    // fixtures/api-contract-conformance/m2m/. The ACRONYM case is not — no corpus
    // entity carries one — so it is pinned here, against the same rule.

    private static MetaObject Entity(string name)
    {
        var json = $@"{{ ""metadata.root"": {{ ""package"": ""test"", ""children"": [
            {{ ""object.entity"": {{ ""name"": ""{name}"", ""children"": [
                {{ ""source.rdb"": {{ ""@table"": ""irrelevant_physical_name"" }} }},
                {{ ""field.long"": {{ ""name"": ""id"" }} }},
                {{ ""identity.primary"": {{ ""name"": ""pk"", ""@fields"": ""id"" }} }}
            ] }} }} ] }} }}";
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "test.json")]);
        Assert.Empty(r.Errors);
        return r.Root.Objects().Single(o => o.Name == name);
    }

    [Theory]
    // Single regular word — every port's old rule already agreed here, which is
    // why four different spellings shipped green.
    [InlineData("Author", "authors")]
    [InlineData("Post", "posts")]
    [InlineData("Person", "persons")]
    // Multi-word: the capitals carry the word boundary, so lowercasing without
    // separating used to yield "postcategories".
    [InlineData("PostCategory", "post_categories")]
    [InlineData("OrderSummary", "order_summaries")]
    // consonant + y -> ies, and a sibilant takes -es.
    [InlineData("Category", "categories")]
    [InlineData("Address", "addresses")]
    // Acronym: the run of capitals stays together until the final one that
    // begins a word, so this is http_servers and never h_t_t_p_servers.
    [InlineData("HTTPServer", "http_servers")]
    public void RoutePath_is_the_entity_name_snake_cased_then_pluralized(string name, string expected)
    {
        Assert.Equal(expected, CSharpNaming.RoutePath(Entity(name)));
    }

    [Fact]
    public void RoutePath_ignores_the_physical_table_name()
    {
        // The fixture above declares @table "irrelevant_physical_name"; the route
        // must derive from the entity name regardless.
        Assert.Equal("post_categories", CSharpNaming.RoutePath(Entity("PostCategory")));
    }
}
