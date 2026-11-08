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
    public void Pluralize_keeps_existing_behavior_for_s_u_i_a_plus_s_endings(string input, string expected)
    {
        Assert.Equal(expected, CSharpNaming.Pluralize(input));
    }

    // A Greek "-sis" noun takes "-ses" (Diagnosis -> Diagnoses), not the sibilant "+es" that
    // produced "Diagnosises" in every DbSet and finder name. The other common endings are pinned
    // beside it so the new rule cannot widen past "-sis".
    [Theory]
    [InlineData("Diagnosis", "Diagnoses")]
    [InlineData("Analysis", "Analyses")]
    [InlineData("Basis", "Bases")]
    [InlineData("OrderAnalysis", "OrderAnalyses")]
    [InlineData("Notification", "Notifications")]
    [InlineData("Reservation", "Reservations")]
    [InlineData("Category", "Categories")]
    [InlineData("Day", "Days")]
    [InlineData("Key", "Keys")]
    [InlineData("Status", "Statuses")]
    [InlineData("Bus", "Buses")]
    public void Pluralize_handles_sis_tion_y_and_s_endings(string input, string expected)
    {
        Assert.Equal(expected, CSharpNaming.Pluralize(input));
    }

    [Fact]
    public void DbSetName_and_reverse_finder_name_use_the_sis_plural()
    {
        Assert.Equal("Diagnoses", CSharpNaming.DbSetName(Entity("Diagnosis")));
        Assert.Equal("FindDiagnosesByPatient", CSharpNaming.ReverseFinderName(Entity("Diagnosis"), "patientId"));
    }

    [Fact]
    public void RoutePath_keeps_the_cross_port_rule_for_a_sis_noun()
    {
        // The REST collection segment is a wire contract every port spells the same way
        // (fixtures/naming-conformance); the "-sis" rule is a C# identifier fix only, so the
        // route does not move until every port moves with it.
        Assert.Equal("diagnosises", CSharpNaming.RoutePath(Entity("Diagnosis")));
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

    [Fact]
    public void AssertNoCollectionNameCollisions_throws_forRouteSegmentTwins()
    {
        // ApiKey / APIKey pluralize to different names but both snake_case to /api_keys.
        var entities = MultiEntityRoot(("ApiKey", false), ("APIKey", false));
        var ex = Assert.Throws<InvalidOperationException>(
            () => CSharpNaming.AssertNoCollectionNameCollisions(entities));
        Assert.Contains("\"ApiKey\"", ex.Message);
        Assert.Contains("\"APIKey\"", ex.Message);
        Assert.Contains("api_keys", ex.Message);
    }

    // -- An object that emits no collection never claims a collection name ----------------
    //
    // fixtures/naming-conformance/already-plural-pluralize.json → shapeOnlyCases: an abstract
    // or sourceless object gets no DbSet, route or finder, so a same-named concrete entity in
    // another package is not a collision. crossPackageCollisionCases is the control.

    public sealed record NamedObject(string Package, string Name, bool Abstract, bool Source);

    private static JsonElement NamingCorpus(string section)
    {
        var path = Path.Combine(
            CorpusPaths.RepoRoot(), "fixtures", "naming-conformance", "already-plural-pluralize.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty(section).Clone();
    }

    private static NamedObject ReadObject(JsonElement o) => new(
        o.GetProperty("package").GetString()!,
        o.GetProperty("name").GetString()!,
        o.TryGetProperty("abstract", out var a) && a.GetBoolean(),
        !o.TryGetProperty("source", out var s) || s.GetBoolean());

    // Each object in its own package (one source file per package), declaring an `id` key.
    private static IReadOnlyList<MetaObject> PackagedObjects(params NamedObject[] objects)
    {
        var sources = objects.Select((o, i) =>
        {
            var abstractAttr = o.Abstract ? "\"abstract\": true, " : "";
            var source = o.Source
                ? $@"{{ ""source.rdb"": {{ ""@table"": ""{o.Package}_{o.Name.ToLowerInvariant()}"" }} }},"
                : "";
            var json = $@"{{ ""metadata.root"": {{ ""package"": ""{o.Package}"", ""children"": [
                {{ ""object.entity"": {{ ""name"": ""{o.Name}"", {abstractAttr}""children"": [
                    {source}
                    {{ ""field.long"": {{ ""name"": ""id"" }} }},
                    {{ ""identity.primary"": {{ ""@fields"": ""id"" }} }}
                ] }} }}
            ] }} }}";
            return (MetaObjects.Loader.IMetaDataSource)new InMemoryStringSource(json, id: $"{o.Package}-{i}.json");
        }).ToList();
        var r = new MetaDataLoader().Load(sources);
        Assert.Empty(r.Errors);
        return r.Root.Objects();
    }

    public static TheoryData<string> ShapeOnlyCaseNotes()
    {
        var data = new TheoryData<string>();
        foreach (var c in NamingCorpus("shapeOnlyCases").EnumerateArray())
            data.Add(c.GetProperty("note").GetString()!);
        return data;
    }

    [Theory]
    [MemberData(nameof(ShapeOnlyCaseNotes))]
    public void NamingConformance_anObjectThatEmitsNoCollectionClaimsNoName(string note)
    {
        var c = NamingCorpus("shapeOnlyCases").EnumerateArray().Single(x => x.GetProperty("note").GetString() == note);
        var shapeOnly = ReadObject(c.GetProperty("shapeOnly"));
        var emitting = ReadObject(c.GetProperty("emitting"));
        // In both orders: the first-seen object owns a name, so order must not matter.
        CSharpNaming.AssertNoCollectionNameCollisions(PackagedObjects(shapeOnly, emitting));
        CSharpNaming.AssertNoCollectionNameCollisions(PackagedObjects(emitting, shapeOnly));
    }

    [Fact]
    public void NamingConformance_twoEmittingEntitiesInTwoPackagesStillCollide()
    {
        foreach (var c in NamingCorpus("crossPackageCollisionCases").EnumerateArray())
        {
            var entities = PackagedObjects(ReadObject(c.GetProperty("entityA")), ReadObject(c.GetProperty("entityB")));
            var ex = Assert.Throws<InvalidOperationException>(
                () => CSharpNaming.AssertNoCollectionNameCollisions(entities));
            Assert.Contains(c.GetProperty("collidesOn").GetString()!, ex.Message);
        }
    }
}
