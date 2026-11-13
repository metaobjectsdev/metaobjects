// CSharpNaming — field-subtype → C# scalar binding.
//
// These pin the engine-independent native-type binding that survived the
// migrate-engine removal: the logical field subtype maps to a fixed C# type
// regardless of any physical @dbColumnType override (ADR-0013).

using System.IO;
using System.Text.Json;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
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

    // -- collection names collide only inside the scope that carries them -------------------
    //
    // There is no run-wide check: the generated context refuses two DbSets of one name, a routes
    // entry two objects that serve one segment. An object that emits nothing never takes part.
    // fixtures/naming-conformance/already-plural-pluralize.json drives the shared cases.

    private static MetaRoot MultiEntityRoot(params (string Name, bool IsValue)[] specs)
    {
        // Each entity its own table: the pairs below collide on a generated name, not on a relation.
        var children = string.Join(",\n", specs.Select((s, i) => s.IsValue
            ? $@"{{ ""object.value"": {{ ""name"": ""{s.Name}"", ""children"": [
                    {{ ""field.string"": {{ ""name"": ""text"" }} }}
                ] }} }}"
            : $@"{{ ""object.entity"": {{ ""name"": ""{s.Name}"", ""children"": [
                    {{ ""source.rdb"": {{ ""@table"": ""{s.Name.ToLowerInvariant()}_{i}"" }} }},
                    {{ ""field.long"": {{ ""name"": ""id"" }} }},
                    {{ ""identity.primary"": {{ ""@fields"": ""id"" }} }}
                ] }} }}"));
        var json = $@"{{ ""metadata.root"": {{ ""package"": ""acme"", ""children"": [{children}] }} }}";
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "multi.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    public sealed record NamedObject(string Package, string Name, bool Abstract, bool Source, string? Schema = null, string? DbSetName = null);

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
    private static MetaRoot PackagedObjects(params NamedObject[] objects)
    {
        var sources = objects.Select((o, i) =>
        {
            var objAttrs = (o.Abstract ? "\"abstract\": true, " : "") + (o.DbSetName is { } d ? $"\"@collectionName\": \"{d}\", " : "");
            var schema = o.Schema is { } sc ? $@", ""@schema"": ""{sc}""" : "";
            var source = o.Source
                ? $@"{{ ""source.rdb"": {{ ""@table"": ""{o.Name.ToLowerInvariant()}s""{schema} }} }},"
                : "";
            var json = $@"{{ ""metadata.root"": {{ ""package"": ""{o.Package}"", ""children"": [
                {{ ""object.entity"": {{ ""name"": ""{o.Name}"", {objAttrs}""children"": [
                    {source}
                    {{ ""field.long"": {{ ""name"": ""id"" }} }},
                    {{ ""identity.primary"": {{ ""@fields"": ""id"" }} }}
                ] }} }}
            ] }} }}";
            return (IMetaDataSource)new InMemoryStringSource(json, id: $"{o.Package}-{i}.json");
        }).ToList();
        var r = new MetaDataLoader().Load(sources);
        Assert.Empty(r.Errors.Select(e => e.Code + ": " + e.Message));
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig
        {
            OutDir = "/unused", Namespace = "Acme.Generated",
            OutputLayout = OutputLayout.Package, PackageNamespacesFromMetadata = true,
            PackageNamespaces = new() { ["enterprise"] = "Acme.Enterprise", ["core"] = "Acme.Core" },
        },
    };

    private static List<EmittedFile> Run(IGenerator g, MetaRoot root) => g.Generate(Ctx(root)).ToList();

    private static Func<MetaObject, bool> InPackage(string pkg) =>
        o => o.ResolutionKey().StartsWith(pkg + "::", StringComparison.Ordinal);

    [Fact]
    public void Distinct_plurals_share_one_context_and_one_routes_entry()
    {
        var root = MultiEntityRoot(("Post", false), ("Author", false), ("Category", false));
        Run(new DbContextGenerator(), root);
        Run(new RoutesGenerator(), root);
    }

    [Fact]
    public void A_value_object_named_like_an_entitys_plural_claims_no_DbSet()
    {
        var root = MultiEntityRoot(("Address", false), ("Addresses", true));
        Run(new DbContextGenerator(), root);
        Run(new RoutesGenerator(), root);
    }

    public sealed record CollisionCase(string EntityA, string EntityB, string CollidesOn);

    public static TheoryData<CollisionCase> NamingConformanceCollisionCases()
    {
        var data = new TheoryData<CollisionCase>();
        foreach (var c in NamingCorpus("collisionCases").EnumerateArray())
            data.Add(new CollisionCase(c.GetProperty("entityA").GetString()!, c.GetProperty("entityB").GetString()!,
                c.GetProperty("collidesOn").GetString()!));
        return data;
    }

    [Theory]
    [MemberData(nameof(NamingConformanceCollisionCases))]
    public void NamingConformance_collisionCases_are_refused_in_the_scope_they_share(CollisionCase c)
    {
        // One package, so one context and one routes entry: each pair collides on its DbSet
        // name (Address/Addresses) or its route segment (ApiKey/APIKey).
        var root = MultiEntityRoot((c.EntityA, false), (c.EntityB, false));
        var ex = Record.Exception(() => { Run(new DbContextGenerator(), root); Run(new RoutesGenerator(), root); });
        var refusal = Assert.IsType<InvalidOperationException>(ex);
        Assert.Contains($"\"{c.CollidesOn}\"", refusal.Message);
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
    public void NamingConformance_an_object_that_emits_nothing_claims_no_name(string note)
    {
        var c = NamingCorpus("shapeOnlyCases").EnumerateArray().Single(x => x.GetProperty("note").GetString() == note);
        foreach (var root in new[] {
            PackagedObjects(ReadObject(c.GetProperty("shapeOnly")), ReadObject(c.GetProperty("emitting"))),
            PackagedObjects(ReadObject(c.GetProperty("emitting")), ReadObject(c.GetProperty("shapeOnly"))) })
        {
            Run(new DbContextGenerator(), root);
            Run(new RoutesGenerator(), root);
        }
    }

    [Fact]
    public void NamingConformance_two_emitting_entities_in_one_context_are_refused_by_DbSet_name()
    {
        foreach (var c in NamingCorpus("crossPackageCollisionCases").EnumerateArray())
        {
            var root = PackagedObjects(ReadObject(c.GetProperty("entityA")), ReadObject(c.GetProperty("entityB")));
            var ex = Assert.Throws<InvalidOperationException>(() => Run(new DbContextGenerator(), root));
            Assert.Contains("ERR_COLLECTION_NAME_COLLISION", ex.Message);
            Assert.Contains($"both generate \"{c.GetProperty("collidesOn").GetString()}\" in the DbSet properties", ex.Message);
            Assert.Contains("@collectionName", ex.Message);
        }
    }

    [Fact]
    public void Two_emitting_entities_in_one_routes_entry_are_refused_by_segment()
    {
        var root = PackagedObjects(new("enterprise", "Payer", false, true, "enterprise"), new("core", "Payer", false, true, "core"));
        var ex = Assert.Throws<InvalidOperationException>(() => Run(new RoutesGenerator(), root));
        Assert.Contains("ERR_COLLECTION_NAME_COLLISION", ex.Message);
        Assert.Contains("both generate \"payers\" in the REST collection segments", ex.Message);
    }

    [Fact]
    public void One_name_in_two_packages_two_schemas_two_contexts_and_two_route_entries_passes_schema_qualified()
    {
        var root = PackagedObjects(new("enterprise", "Payer", false, true, "enterprise"), new("core", "Payer", false, true, "core"));
        foreach (var pkg in new[] { "enterprise", "core" })
        {
            var context = Assert.Single(Run(new DbContextGenerator { Include = InPackage(pkg) }, root)).Content;
            Assert.Contains("Payers { get; set; }", context);
            Assert.NotEmpty(Run(new RoutesGenerator { Include = InPackage(pkg) }, root));
        }
        var entities = Run(new EntityGenerator(), root).Select(f => f.Content).ToList();
        Assert.Contains(entities, c => c.Contains("[Table(\"payers\", Schema = \"enterprise\")]") && c.Contains("namespace Acme.Enterprise"));
        Assert.Contains(entities, c => c.Contains("[Table(\"payers\", Schema = \"core\")]") && c.Contains("namespace Acme.Core"));
    }

    [Fact]
    public void DbSetName_names_the_property_and_resolves_a_same_context_collision()
    {
        var root = PackagedObjects(
            new("enterprise", "Payer", false, true, "enterprise", DbSetName: "EnterprisePayers"),
            new("core", "Payer", false, true, "core"));
        var context = Assert.Single(Run(new DbContextGenerator(), root)).Content;
        Assert.Contains("EnterprisePayers { get; set; }", context);
        Assert.Contains("Payers { get; set; }", context);
    }

    // A @collectionName that is no C# identifier, or names a DbContext member, would fail at compile
    // time (or hide Database / Model); codegen refuses it by name.
    [Theory]
    [InlineData("Payer Rows")]
    [InlineData("1Payers")]
    [InlineData("Database")]
    [InlineData("Model")]
    public void A_dbSetName_that_cannot_be_the_property_is_refused_at_codegen(string bad)
    {
        var root = PackagedObjects(new NamedObject("core", "Payer", false, true, DbSetName: bad));
        var ex = Assert.Throws<InvalidOperationException>(() => Run(new DbContextGenerator(), root));
        Assert.Contains("@collectionName", ex.Message);
        Assert.Contains($"\"{bad}\"", ex.Message);
    }

    // One context, one relation per (schema, name). Two objects that map to one table would
    // silently share it; the DbSet rule no longer catches them once @collectionName splits the
    // property names.
    [Theory]
    [InlineData("billing")]
    [InlineData(null)]
    public void Two_objects_mapping_one_relation_in_one_context_are_refused_naming_both(string? schema)
    {
        var root = PackagedObjects(
            new("enterprise", "Payer", false, true, schema, DbSetName: "EnterprisePayers"),
            new("core", "Payer", false, true, schema));
        var ex = Assert.Throws<InvalidOperationException>(() => Run(new DbContextGenerator(), root));
        Assert.Contains("ERR_DUPLICATE_SQL_NAME", ex.Message);
        Assert.Contains("\"enterprise::Payer\"", ex.Message);
        Assert.Contains("\"core::Payer\"", ex.Message);
        Assert.Contains(schema is null ? "\"payers\"" : "\"billing.payers\"", ex.Message);
    }

    [Fact]
    public void Two_objects_mapping_one_routine_in_one_context_are_refused_naming_both()
    {
        const string json = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Alpha", "children": [
                { "source.rdb": { "@role": "primary", "@kind": "table", "@table": "alphas" } },
                { "source.rdb": { "@role": "replica", "@kind": "storedProc", "@proc": "refresh_totals" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } } ] } },
              { "object.entity": { "name": "Beta", "children": [
                { "source.rdb": { "@role": "primary", "@kind": "table", "@table": "betas" } },
                { "source.rdb": { "@role": "replica", "@kind": "storedProc", "@proc": "refresh_totals" } },
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } } ] } }
            ] } }
            """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "routine.json")]);
        Assert.Empty(r.Errors);
        var ex = Assert.Throws<InvalidOperationException>(() => Run(new DbContextGenerator(), r.Root));
        Assert.Contains("ERR_DUPLICATE_SQL_NAME", ex.Message);
        Assert.Contains("acme::Alpha", ex.Message);
        Assert.Contains("acme::Beta", ex.Message);
        Assert.Contains("refresh_totals", ex.Message);
    }

    [Fact]
    public void One_table_name_in_two_schemas_in_one_context_passes_schema_qualified()
    {
        var root = PackagedObjects(
            new("enterprise", "Payer", false, true, "enterprise", DbSetName: "EnterprisePayers"),
            new("core", "Payer", false, true, "core"));
        Assert.Single(Run(new DbContextGenerator(), root));
        var entities = Run(new EntityGenerator(), root).Select(f => f.Content).ToList();
        Assert.Contains(entities, c => c.Contains("[Table(\"payers\", Schema = \"enterprise\")]"));
        Assert.Contains(entities, c => c.Contains("[Table(\"payers\", Schema = \"core\")]"));
    }

    [Fact]
    public void An_abstract_sourceless_shape_beside_a_concrete_entity_runs_end_to_end()
    {
        // The layered-model shape: enterprise::Payer is abstract and sourceless, core::Payer
        // concrete. Through the real entry point, with the stock generators.
        var root = PackagedObjects(new("enterprise", "Payer", true, false), new("core", "Payer", false, true, "core"));
        var config = new GenConfig { OutDir = Path.Combine(Path.GetTempPath(), "mo-" + Guid.NewGuid().ToString("N")), Namespace = "Acme.Generated" };
        try
        {
            CodegenRunner.Run(config, root, [new EntityGenerator(), new DbContextGenerator(), new RoutesGenerator(), new NamesGenerator()]);
        }
        finally
        {
            if (Directory.Exists(config.OutDir)) Directory.Delete(config.OutDir, recursive: true);
        }
    }

    [Fact]
    public void A_view_mapping_carries_its_schema()
    {
        const string json = """
            { "metadata.root": { "package": "acme", "children": [
              { "object.projection": { "name": "PayerSummary", "children": [
                { "source.rdb": { "@kind": "view", "@view": "v_payer_summary", "@schema": "reporting" } },
                { "field.long": { "name": "id" } }
              ] } }
            ] } }
            """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(json, id: "view.json")]);
        Assert.Empty(r.Errors);
        var context = Assert.Single(Run(new DbContextGenerator(), r.Root)).Content;
        Assert.Contains(".ToView(\"v_payer_summary\", \"reporting\")", context);
    }
}
