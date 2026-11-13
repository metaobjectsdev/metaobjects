using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Config;
using MetaObjects.Core.Transition;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Cross-port business-rules gate conformance corpus (ADR-0063): <c>fixtures/rules-check-conformance/</c>.
/// See that directory's README.md for the fixture format. Every case is LOADED strict first, so "this
/// model loads today" is proven by the fixture, and only then checked. <c>options.json</c> holds the
/// <c>rules</c> and <c>verify</c> blocks of <c>.metaobjects/config.json</c>, so it is run through this
/// port's own config reader. Mirrors the TypeScript reference (<c>rules-check-conformance.test.ts</c>);
/// a mismatch here is a bug in THIS port's gate, never in the fixture.
/// </summary>
public class RulesCheckConformanceTests
{
    private static readonly string CorpusDir = ResolveCorpusDir();

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures", "rules-check-conformance");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not locate fixtures/rules-check-conformance/ by walking up from " + AppContext.BaseDirectory);
    }

    private static List<string> Cases() =>
        Directory.GetDirectories(CorpusDir).Select(d => Path.GetFileName(d)!).OrderBy(n => n, StringComparer.Ordinal).ToList();

    public static IEnumerable<object[]> Fixtures() => Cases().Select(n => new object[] { n });

    /// <summary>Read <c>options.json</c> through the port's own config reader, as a project's config.json.</summary>
    private static RulesSettings ReadSettings(string caseDir)
    {
        var file = Path.Combine(caseDir, "options.json");
        if (!File.Exists(file)) return RulesSettings.Default;
        return ReadConfigBlocks(File.ReadAllText(file));
    }

    private static RulesSettings ReadConfigBlocks(string blocksJson)
    {
        var dir = Directory.CreateTempSubdirectory("mo-rules-config-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
            // The blocks sit beside a minimal config: a key the reader does not know fails the case.
            using var blocks = JsonDocument.Parse(blocksJson);
            var merged = new Dictionary<string, object> { ["schema_version"] = 1 };
            foreach (var p in blocks.RootElement.EnumerateObject()) merged[p.Name] = p.Value.Clone();
            File.WriteAllText(Path.Combine(dir, ".metaobjects", "config.json"), JsonSerializer.Serialize(merged));
            return NeutralConfig.Read(dir)!.Rules;
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static string SummaryJson(RulesSummary? summary) => summary is null
        ? "null"
        : JsonSerializer.Serialize(new SortedDictionary<string, int>(StringComparer.Ordinal)
        {
            ["operations"] = summary.Operations,
            ["lifecycles"] = summary.Lifecycles,
            ["transitions"] = summary.Transitions,
        });

    private static string CanonicalJson(JsonElement element) => element.ValueKind == JsonValueKind.Null
        ? "null"
        : JsonSerializer.Serialize(new SortedDictionary<string, int>(
            element.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetInt32()), StringComparer.Ordinal));

    private static List<string> DocumentedCases()
    {
        var readme = File.ReadAllText(Path.Combine(CorpusDir, "README.md"));
        var section = Regex.Split(readme, "^## ", RegexOptions.Multiline).FirstOrDefault(s => s.StartsWith("Cases\n", StringComparison.Ordinal));
        Assert.NotNull(section);
        return Regex.Matches(section!, @"^\| `([^`]+)` \|", RegexOptions.Multiline).Select(m => m.Groups[1].Value).ToList();
    }

    [Fact]
    public void Discovers_the_corpus() => Assert.NotEmpty(Cases());

    [Fact]
    public void Every_case_on_disk_is_documented_in_the_readme_and_nothing_else_is() =>
        Assert.Equal(Cases(), DocumentedCases().Order(StringComparer.Ordinal).ToList());

    [Fact]
    public void An_absent_block_is_every_default()
    {
        Assert.Equal(RulesSettings.Default, ReadConfigBlocks("{}"));
        Assert.Equal(new RulesSettings("derive", "initial", "unclaimed", "warn"), RulesSettings.Default);
    }

    [Theory]
    [InlineData("""{ "rules": { "permissions": { "names": "loud" } } }""")]
    [InlineData("""{ "rules": { "permissions": { "name": "advise" } } }""")]
    [InlineData("""{ "rules": { "lifecycle": { "create": "never" } } }""")]
    [InlineData("""{ "rules": { "lifecycle": { "commands": "some" } } }""")]
    [InlineData("""{ "rules": { "audit": {} } }""")]
    [InlineData("""{ "rules": [] }""")]
    [InlineData("""{ "verify": { "lifecycle": { "unreachable": "ignore" } } }""")]
    [InlineData("""{ "verify": { "lifecycle": { "reachable": "warn" } } }""")]
    [InlineData("""{ "verify": { "other": {} } }""")]
    [InlineData("""{ "verify": "warn" }""")]
    public void An_unknown_key_or_value_is_refused(string blocks) =>
        Assert.Throws<MetaModelException>(() => ReadConfigBlocks(blocks));

    [Fact]
    public void Every_documented_value_is_read()
    {
        var settings = ReadConfigBlocks("""
            { "rules": { "permissions": { "names": "require" }, "lifecycle": { "create": "any", "commands": "all" } },
              "verify": { "lifecycle": { "unreachable": "off" } } }
            """);
        Assert.Equal(new RulesSettings("require", "any", "all", "off"), settings);
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Fixture(string name)
    {
        var caseDir = Path.Combine(CorpusDir, name);
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "expected.json")));
        var settings = ReadSettings(caseDir);

        // Strict; the files load in ascending file-name order.
        var load = MetaDataLoader.FromDirectory(Path.Combine(caseDir, "input"), strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

        var result = RulesCheck.Check(load.Root, settings);
        var actual = result.Diagnostics
            .Select(d => (d.Severity, d.Code, d.Path ?? "", d.Message))
            .Order().ToList();
        var wanted = doc.RootElement.GetProperty("diagnostics").EnumerateArray()
            .Select(d => (
                d.GetProperty("severity").GetString()!,
                d.GetProperty("code").GetString()!,
                d.TryGetProperty("path", out var p) ? p.GetString()! : "",
                d.GetProperty("message").GetString()!))
            .Order().ToList();
        Assert.Equal(wanted, actual);

        Assert.Equal(CanonicalJson(doc.RootElement.GetProperty("summary")), SummaryJson(result.Summary));
    }
}
