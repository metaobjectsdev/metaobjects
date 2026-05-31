// ScenarioLoader — parse a fixture YAML into a typed Scenario record.
//
//   fixtures/persistence-conformance/queries/*.yaml     → QueryScenario
//
// Relative metadata paths in YAML resolve against the scenario file's directory.

using YamlDotNet.Serialization;
using YamlDotNet.Serialization.NamingConventions;

namespace MetaObjects.IntegrationTests.Runner;

public static class ScenarioLoader
{
    private static readonly IDeserializer Yaml = new DeserializerBuilder()
        .WithNamingConvention(HyphenatedNamingConvention.Instance)
        .Build();

    /// <summary>Load every <c>*.yaml</c> in a directory as query scenarios.</summary>
    public static IReadOnlyList<QueryScenario> LoadQueries(string dir) =>
        Directory.EnumerateFiles(dir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(LoadQuery)
            .ToList();

    public static QueryScenario LoadQuery(string yamlPath)
    {
        var raw = Yaml.Deserialize<QueryYaml>(File.ReadAllText(yamlPath));
        return new QueryScenario(
            Name: raw.Name ?? throw new InvalidOperationException($"{yamlPath}: missing 'name'"),
            Description: raw.Description ?? "",
            SourcePath: yamlPath,
            SeedData: raw.SeedData,
            Queries: (raw.Queries ?? []).Select(q => new QuerySpec(
                Name: q.Name ?? throw new InvalidOperationException($"{yamlPath}: query missing 'name'"),
                Op: q.Op ?? throw new InvalidOperationException($"{yamlPath}: query missing 'op'"),
                Entity: q.Entity ?? throw new InvalidOperationException($"{yamlPath}: query missing 'entity'"),
                By: q.By,
                Filter: q.Filter,
                Sort: q.Sort?.Select(s => new SortSpec(s.Field ?? "", s.Dir ?? "asc")).ToList(),
                Limit: q.Limit,
                Offset: q.Offset,
                Expect: q.Expect)).ToList());
    }

    // ---------- YAML wire shapes (lower-cased + hyphenated via the naming convention) ----------

    private sealed class QueryYaml
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public string? SeedData { get; set; }
        public List<QuerySpecYaml>? Queries { get; set; }
    }

    private sealed class QuerySpecYaml
    {
        public string? Name { get; set; }
        public string? Op { get; set; }
        public string? Entity { get; set; }
        public Dictionary<string, object?>? By { get; set; }
        public Dictionary<string, object?>? Filter { get; set; }
        public List<SortYaml>? Sort { get; set; }
        public int? Limit { get; set; }
        public int? Offset { get; set; }
        public object? Expect { get; set; }
    }

    private sealed class SortYaml
    {
        public string? Field { get; set; }
        public string? Dir { get; set; }
    }
}
