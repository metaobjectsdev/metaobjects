// The shared foreign-key index corpus, fixtures/foreign-key-index-conformance/: which foreign
// keys `migrate.foreignKeyIndexes` indexes and under what name, per dialect. The TypeScript
// migrate suite writes and passes the same expected files, so the EF model declares exactly the
// indexes `meta migrate` creates. `declared.<dialect>.json` pins the database name of every
// identity.secondary and index.lookup, so a declared name over 63 bytes is cut on Postgres the
// way migrate cuts it, in the EF model as in the database.

using System.Text.Json;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ForeignKeyIndexConformanceTests
{
    private static string Corpus()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "foreign-key-index-conformance");
    }

    public static TheoryData<string, string> Cases => new()
    {
        { "expected.postgres.json", "postgres" },
        { "expected.sqlite.json", "sqlite" },
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void The_indexes_are_meta_migrates(string file, string dialect)
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(Corpus(), "input"));
        Assert.Empty(load.Errors);
        var config = new GenConfig { OutDir = "/unused", Namespace = "Acme", ForeignKeyIndexes = true, Dialect = dialect };
        var actual = load.Root.Objects()
            .Where(o => o.IsEntity() && o.DbTable is not null)
            .Select(o => (Table: CSharpNaming.Table(o), Indexes: ForeignKeyIndexes.For(o, TphPlanBuilder.For(o, load.Root), config)))
            .Where(t => t.Indexes.Count > 0)
            .ToDictionary(t => t.Table, t => t.Indexes.Select(i => $"{i.Name}({string.Join(",", i.Columns)})").ToList());

        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Corpus(), file)));
        var expected = doc.RootElement.EnumerateObject().ToDictionary(
            t => t.Name,
            t => t.Value.EnumerateArray()
                .Select(i => $"{i.GetProperty("name").GetString()}({string.Join(",", i.GetProperty("columns").EnumerateArray().Select(c => c.GetString()))})")
                .ToList());

        Assert.Equal(expected.Keys.OrderBy(k => k, StringComparer.Ordinal), actual.Keys.OrderBy(k => k, StringComparer.Ordinal));
        foreach (var (table, indexes) in expected)
            Assert.Equal(indexes, actual[table]);
    }

    public static TheoryData<string, string> DeclaredCases => new()
    {
        { "declared.postgres.json", "postgres" },
        { "declared.sqlite.json", "sqlite" },
    };

    [Theory]
    [MemberData(nameof(DeclaredCases))]
    public void Declared_index_names_are_meta_migrates(string file, string dialect)
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(Corpus(), "input"));
        Assert.Empty(load.Errors);
        var actual = new Dictionary<string, List<string>>();
        foreach (var o in load.Root.Objects().Where(o => o.IsEntity() && o.DbTable is not null))
        {
            var nodes = o.SecondaryIdentities().Select(i => ((MetaData)i, i.Fields))
                .Concat(o.LookupIndexes().Select(i => ((MetaData)i, i.Fields)));
            var names = nodes
                .Select(n => $"{ForeignKeyIndexes.DeclaredIndexName(n.Item1, dialect)}({string.Join(",", n.Fields.Select(f => CSharpNaming.Column(o.FindField(f)!, ColumnNamingStrategy.SnakeCase)))})")
                .ToList();
            if (names.Count > 0) actual[CSharpNaming.Table(o)] = names;
        }

        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Corpus(), file)));
        var expected = doc.RootElement.EnumerateObject().ToDictionary(
            t => t.Name,
            t => t.Value.EnumerateArray()
                .Select(i => $"{i.GetProperty("name").GetString()}({string.Join(",", i.GetProperty("columns").EnumerateArray().Select(c => c.GetString()))})")
                .ToList());

        Assert.Equal(expected.Keys.OrderBy(k => k, StringComparer.Ordinal), actual.Keys.OrderBy(k => k, StringComparer.Ordinal));
        foreach (var (table, indexes) in expected)
            Assert.Equal(indexes, actual[table]);
    }

    [Theory]
    [InlineData("postgres", "customer_order_line_item_allocations_by_region_region_code_look", "allocation_order_reference_lines_by_customer_and_region_order_r")]
    [InlineData("sqlite", "customer_order_line_item_allocations_by_region_region_code_lookup", "allocation_order_reference_lines_by_customer_and_region_order_ref_unique")]
    public void The_EF_model_declares_the_name_the_database_stores(string dialect, string lookup, string unique)
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(Corpus(), "input"));
        Assert.Empty(load.Errors);
        // A @unique field on a long table: its `<table>_<column>_unique` name is cut the same way.
        var extra = new MetaDataLoader().Load([new InMemoryStringSource("""
            { "metadata.root": { "package": "acme", "children": [
              { "object.entity": { "name": "Long", "children": [
                { "source.rdb": { "@table": "allocation_order_reference_lines_by_customer_and_region" } },
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "orderRef", "@column": "order_ref", "@unique": true } },
                { "identity.primary": { "name": "pk", "@fields": "id" } }
              ] } }
            ] } }
            """, id: "long.json")]);
        Assert.Empty(extra.Errors);
        string Render(MetaObjects.Meta.MetaRoot root) => string.Join("\n", new DbContextGenerator().Generate(new GenContext
        {
            Entities = root.Objects(), Root = root, Warn = _ => { },
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme", Dialect = dialect },
        }).Select(f => f.Content));
        var context = Render(load.Root);
        Assert.Contains($".HasDatabaseName(\"{lookup}\");", context);
        Assert.Contains($".HasDatabaseName(\"{unique}\");", Render(extra.Root));
    }
}
