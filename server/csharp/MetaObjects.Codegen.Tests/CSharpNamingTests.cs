// CSharpNaming — field-subtype → C# scalar binding.
//
// These pin the engine-independent native-type binding that survived the
// migrate-engine removal: the logical field subtype maps to a fixed C# type
// regardless of any physical @dbColumnType override (ADR-0013).

using System.IO;
using System.Text.Json;
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

    // ---- Pluralize: already-plural detection --------------------
    //
    // An already-plural entity name used to double (ProgramPurchaseStats ->
    // ProgramPurchaseStatses) in every API-surface spelling that goes through
    // this function: DbSet property names, the route collection segment, and
    // reverse-finder names. Mirrors the TS fix in metadata/src/naming.ts exactly
    // (same four-letter exclusion set before a final "s").

    [Theory]
    [InlineData("Stats", "Stats")]
    [InlineData("Settings", "Settings")]
    [InlineData("Details", "Details")]
    [InlineData("News", "News")]
    [InlineData("Analytics", "Analytics")]
    [InlineData("Series", "Series")]
    [InlineData("Photos", "Photos")]
    [InlineData("ProgramPurchaseStats", "ProgramPurchaseStats")]
    public void Pluralize_leaves_an_already_plural_word_unchanged(string input, string expected)
    {
        Assert.Equal(expected, CSharpNaming.Pluralize(input));
    }

    [Theory]
    [InlineData("Status", "Statuses")]
    [InlineData("Address", "Addresses")]
    [InlineData("Bonus", "Bonuses")]
    [InlineData("Alias", "Aliases")]
    [InlineData("Gas", "Gases")]
    // Documented pre-existing imperfection, explicitly out of scope — not "Analyses".
    [InlineData("Analysis", "Analysises")]
    public void Pluralize_keeps_existing_behavior_for_s_u_i_a_plus_s_endings(string input, string expected)
    {
        Assert.Equal(expected, CSharpNaming.Pluralize(input));
    }

    [Fact]
    public void Pluralize_documented_known_miss_Lens_reads_as_already_plural()
    {
        // Correct plural is "Lenses"; this heuristic is not a dictionary. See the
        // function's doc comment.
        Assert.Equal("Lens", CSharpNaming.Pluralize("Lens"));
    }

    [Fact]
    public void RoutePath_does_not_double_pluralize_an_already_plural_entity_name()
    {
        Assert.Equal("program_purchase_stats", CSharpNaming.RoutePath(Entity("ProgramPurchaseStats")));
    }

    [Fact]
    public void DbSetName_does_not_double_pluralize_an_already_plural_entity_name()
    {
        Assert.Equal("ProgramPurchaseStats", CSharpNaming.DbSetName(Entity("ProgramPurchaseStats")));
    }

    // -- fixtures/naming-conformance/ — the shared cross-port data proving every
    // port's API-surface pluralizer and frozen legacy pluralizer agree on the
    // SAME inputs. See that corpus's README for the schema and the other ports'
    // runners. The legacy half goes through the PUBLIC MetaSource.PhysicalName
    // (an entity with an empty source.rdb — step 4, same shape as
    // Fr016SourceNameAndKindAliasesTests' Step4 test) rather than calling
    // SourceNaming.Pluralize directly: that class is `internal` to MetaObjects
    // and this test project has no InternalsVisibleTo grant.

    private static MetaObject EntityWithEmptySource(string name)
    {
        var json = $@"{{ ""metadata.root"": {{ ""package"": ""test"", ""children"": [
            {{ ""object.entity"": {{ ""name"": ""{name}"", ""children"": [
                {{ ""source.rdb"": {{ }} }},
                {{ ""field.long"": {{ ""name"": ""id"" }} }},
                {{ ""identity.primary"": {{ ""name"": ""pk"", ""@fields"": ""id"" }} }}
            ] }} }} ] }} }}";
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "naming-conformance.json")]);
        Assert.Empty(r.Errors);
        return r.Root.Objects().Single(o => o.Name == name);
    }

    public sealed record NamingCase(string Name, string ApiPlural, string LegacyPlural);

    public static TheoryData<NamingCase> NamingConformanceCases()
    {
        var path = Path.Combine(
            CorpusPaths.RepoRoot(), "fixtures", "naming-conformance", "already-plural-pluralize.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var data = new TheoryData<NamingCase>();
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(new NamingCase(
                c.GetProperty("name").GetString()!,
                c.GetProperty("apiPlural").GetString()!,
                c.GetProperty("legacyPlural").GetString()!));
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(NamingConformanceCases))]
    public void NamingConformance_apiAndLegacyPluralsMatch(NamingCase c)
    {
        Assert.Equal(c.ApiPlural, CSharpNaming.Pluralize(c.Name));
        var entity = EntityWithEmptySource(c.Name);
        var source = entity.Children().OfType<MetaSource>().Single();
        // physical_name snake_cases first; every fixture case is a single PascalCase
        // word, so lowercasing is byte-equivalent to snake_casing it (no word boundary
        // to insert "_" at) — avoids depending on CSharpNaming's private ToSnakeCase.
        Assert.Equal(c.LegacyPlural.ToLowerInvariant(), source.PhysicalName);
    }

    // -- AssertNoCollectionNameCollisions --------------------------

    private static IReadOnlyList<MetaObject> MultiEntityRoot(params (string Name, bool IsValue)[] specs)
    {
        var children = string.Join(",\n", specs.Select(s => s.IsValue
            ? $@"{{ ""object.value"": {{ ""name"": ""{s.Name}"", ""children"": [
                    {{ ""field.string"": {{ ""name"": ""text"" }} }}
                ] }} }}"
            : $@"{{ ""object.entity"": {{ ""name"": ""{s.Name}"", ""children"": [
                    {{ ""source.rdb"": {{ ""@table"": ""{s.Name.ToLowerInvariant()}"" }} }},
                    {{ ""field.long"": {{ ""name"": ""id"" }} }},
                    {{ ""identity.primary"": {{ ""@fields"": ""id"" }} }}
                ] }} }}"));
        var json = $@"{{ ""metadata.root"": {{ ""package"": ""acme"", ""children"": [{children}] }} }}";
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "multi.json")]);
        Assert.Empty(r.Errors);
        return r.Root.Objects();
    }

    [Fact]
    public void AssertNoCollectionNameCollisions_doesNotThrow_forDistinctPlurals()
    {
        var entities = MultiEntityRoot(("Post", false), ("Author", false), ("Category", false));
        CSharpNaming.AssertNoCollectionNameCollisions(entities); // does not throw
    }

    [Fact]
    public void AssertNoCollectionNameCollisions_throws_forAddressAndAddresses()
    {
        var entities = MultiEntityRoot(("Address", false), ("Addresses", false));
        var ex = Assert.Throws<InvalidOperationException>(
            () => CSharpNaming.AssertNoCollectionNameCollisions(entities));
        Assert.Contains("Address", ex.Message);
        Assert.Contains("Addresses", ex.Message);
    }

    [Fact]
    public void AssertNoCollectionNameCollisions_throws_forOrderAndOrders()
    {
        var entities = MultiEntityRoot(("Order", false), ("Orders", false));
        Assert.Throws<InvalidOperationException>(
            () => CSharpNaming.AssertNoCollectionNameCollisions(entities));
    }

    [Fact]
    public void AssertNoCollectionNameCollisions_excludesValueObjects()
    {
        // "Address" (entity) legacy-pluralizes to "Addresses"; an unrelated object.value
        // named "Addresses" never gets a DbSet/route/finder, so it must not trip this.
        var entities = MultiEntityRoot(("Address", false), ("Addresses", true));
        CSharpNaming.AssertNoCollectionNameCollisions(entities); // does not throw
    }

    public sealed record CollisionCase(string EntityA, string EntityB);

    public static TheoryData<CollisionCase> NamingConformanceCollisionCases()
    {
        var path = Path.Combine(
            CorpusPaths.RepoRoot(), "fixtures", "naming-conformance", "already-plural-pluralize.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        var data = new TheoryData<CollisionCase>();
        foreach (var c in doc.RootElement.GetProperty("collisionCases").EnumerateArray())
        {
            data.Add(new CollisionCase(
                c.GetProperty("entityA").GetString()!,
                c.GetProperty("entityB").GetString()!));
        }
        return data;
    }

    [Theory]
    [MemberData(nameof(NamingConformanceCollisionCases))]
    public void NamingConformance_collisionCasesAreRefused(CollisionCase c)
    {
        var entities = MultiEntityRoot((c.EntityA, false), (c.EntityB, false));
        Assert.Throws<InvalidOperationException>(
            () => CSharpNaming.AssertNoCollectionNameCollisions(entities));
    }
}
