// ScenarioLoader — parse a fixture YAML into a typed Scenario record.
//
// Two scenario kinds are distinguished by their file location:
//   fixtures/persistence-conformance/migrations/*.yaml  → MigrationScenario
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

    /// <summary>Load every <c>*.yaml</c> in a directory as scenarios of the given kind.</summary>
    public static IReadOnlyList<MigrationScenario> LoadMigrations(string dir) =>
        Directory.EnumerateFiles(dir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(LoadMigration)
            .ToList();

    public static IReadOnlyList<QueryScenario> LoadQueries(string dir) =>
        Directory.EnumerateFiles(dir, "*.yaml", SearchOption.TopDirectoryOnly)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(LoadQuery)
            .ToList();

    public static MigrationScenario LoadMigration(string yamlPath)
    {
        var raw = Yaml.Deserialize<MigrationYaml>(File.ReadAllText(yamlPath));
        var dir = Path.GetDirectoryName(yamlPath)!;
        return new MigrationScenario(
            Name: raw.Name ?? throw new InvalidOperationException($"{yamlPath}: missing 'name'"),
            Description: raw.Description ?? "",
            SourcePath: yamlPath,
            SeedMetadataDir: Resolve(dir, raw.SeedMetadata),
            SeedData: raw.SeedData,
            TargetMetadataDir: Resolve(dir, raw.TargetMetadata),
            TargetMetadataInline: raw.TargetMetadataInline,
            Expect: new MigrationExpect(
                Blocked: (raw.Expect?.Blocked ?? []).Select(b => new BlockedChange(b.Kind ?? "", b.ReasonContains ?? "")).ToList(),
                UpContains: raw.Expect?.UpContains ?? [],
                UpEmpty: raw.Expect?.UpEmpty,
                ApplyUpThenQuery: raw.Expect?.ApplyUpThenQuery is { } q
                    ? new ApplyUpThenQuery(q.Sql ?? "", q.Rows ?? [])
                    : null));
    }

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

    private static string? Resolve(string baseDir, string? rel) =>
        string.IsNullOrEmpty(rel) ? null : Path.GetFullPath(Path.Combine(baseDir, rel));

    // ---------- YAML wire shapes (lower-cased + hyphenated via the naming convention) ----------

    private sealed class MigrationYaml
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public string? SeedMetadata { get; set; }
        public string? SeedData { get; set; }
        public string? TargetMetadata { get; set; }
        public string? TargetMetadataInline { get; set; }
        public MigrationExpectYaml? Expect { get; set; }
    }

    private sealed class MigrationExpectYaml
    {
        public List<BlockedYaml>? Blocked { get; set; }
        public List<string>? UpContains { get; set; }
        public bool? UpEmpty { get; set; }
        public ApplyUpThenQueryYaml? ApplyUpThenQuery { get; set; }
    }

    private sealed class BlockedYaml
    {
        public string? Kind { get; set; }
        public string? ReasonContains { get; set; }
    }

    private sealed class ApplyUpThenQueryYaml
    {
        public string? Sql { get; set; }
        public List<Dictionary<string, object?>>? Rows { get; set; }
    }

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
