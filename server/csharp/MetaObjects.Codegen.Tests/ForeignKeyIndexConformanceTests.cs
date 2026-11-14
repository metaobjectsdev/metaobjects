// The shared foreign-key index corpus, fixtures/foreign-key-index-conformance/: which foreign
// keys `migrate.foreignKeyIndexes` indexes and under what name, per dialect. The TypeScript
// migrate suite writes and passes the same expected files, so the EF model declares exactly the
// indexes `meta migrate` creates.

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
}
