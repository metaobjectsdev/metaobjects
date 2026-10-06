using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Core.Requirement;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Cross-port requirement-gate conformance corpus: <c>fixtures/requirement-check-conformance/</c>.
/// See that directory's README.md for the fixture format. Every case is LOADED strict first, so
/// "this model loads today" is proven by the fixture, and only then checked. Mirrors the TypeScript
/// reference (<c>requirement-check-conformance.test.ts</c>); a mismatch here is a bug in THIS
/// port's gate, never in the fixture, and a committed <c>expected.json</c> is never edited to make
/// this port pass.
/// </summary>
public class RequirementCheckConformanceTests
{
    private static readonly string CorpusDir = ResolveCorpusDir();

    /// <summary>
    /// The whole of <c>options.json</c>. A key outside this list, or a value of the wrong type, is
    /// refused rather than ignored: a misspelt <c>requireImplementers</c>, or one written as the
    /// string "true", would otherwise run the case without the strict switch and pin the wrong
    /// severity.
    /// </summary>
    private static readonly string[] OptionKeys = ["libraries", "requireImplementers"];

    /// <summary>A case whose <c>input/</c> must be, file for file and byte for byte, another case's.</summary>
    private static readonly Dictionary<string, string> SameInputAs = new()
    {
        ["require-implementers"] = "nothing-implements-subtree",
    };

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures", "requirement-check-conformance");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not locate fixtures/requirement-check-conformance/ by walking up from " + AppContext.BaseDirectory);
    }

    private static List<string> Cases() =>
        Directory.GetDirectories(CorpusDir).Select(d => Path.GetFileName(d)!).OrderBy(n => n, StringComparer.Ordinal).ToList();

    public static IEnumerable<object[]> Fixtures() => Cases().Select(n => new object[] { n });

    private sealed record Options(string[] Libraries, bool RequireImplementers);

    private static Options ReadOptions(string caseDir)
    {
        var file = Path.Combine(caseDir, "options.json");
        if (!File.Exists(file)) return new Options([], false);

        using var doc = JsonDocument.Parse(File.ReadAllText(file));
        Assert.Equal(JsonValueKind.Object, doc.RootElement.ValueKind);
        var unknown = doc.RootElement.EnumerateObject().Select(p => p.Name).Except(OptionKeys).Order().ToList();
        Assert.True(unknown.Count == 0, $"{file}: unknown option(s) {string.Join(", ", unknown)}");

        var libraries = Array.Empty<string>();
        if (doc.RootElement.TryGetProperty("libraries", out var libs))
        {
            Assert.True(
                libs.ValueKind == JsonValueKind.Array && libs.EnumerateArray().All(x => x.ValueKind == JsonValueKind.String),
                $"{file}: 'libraries' must be an array of strings");
            libraries = libs.EnumerateArray().Select(x => x.GetString()!).ToArray();
        }

        var require = false;
        if (doc.RootElement.TryGetProperty("requireImplementers", out var req))
        {
            Assert.True(
                req.ValueKind is JsonValueKind.True or JsonValueKind.False,
                $"{file}: 'requireImplementers' must be a boolean");
            require = req.GetBoolean();
        }
        return new Options(libraries, require);
    }

    private static Dictionary<string, string> InputFiles(string name) =>
        Directory.GetFiles(Path.Combine(CorpusDir, name, "input"))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToDictionary(f => Path.GetFileName(f)!, File.ReadAllText);

    /// <summary>The corpus's JSON shape: <c>entities*</c> are absent unless coverage was measured.</summary>
    private static string SummaryJson(RequirementSummary? summary)
    {
        if (summary is null) return "null";
        var obj = new SortedDictionary<string, object>(StringComparer.Ordinal)
        {
            ["total"] = summary.Total,
            ["functional"] = summary.Functional,
            ["architectural"] = summary.Architectural,
            ["byStatus"] = new SortedDictionary<string, int>(summary.ByStatus.ToDictionary(kv => kv.Key, kv => kv.Value), StringComparer.Ordinal),
            ["undecided"] = summary.Undecided,
            ["deferredUntracked"] = summary.DeferredUntracked,
        };
        if (summary.EntitiesTotal is not null)
        {
            obj["entitiesClaimed"] = summary.EntitiesClaimed!.Value;
            obj["entitiesTotal"] = summary.EntitiesTotal.Value;
        }
        return JsonSerializer.Serialize(obj);
    }

    /// <summary>The expected summary, re-serialized through the same sorted shape so the two compare as text.</summary>
    private static string CanonicalJson(JsonElement element)
    {
        object? Convert(JsonElement e) => e.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.Object => new SortedDictionary<string, object?>(
                e.EnumerateObject().ToDictionary(p => p.Name, p => Convert(p.Value)), StringComparer.Ordinal),
            JsonValueKind.Number => e.GetInt32(),
            _ => throw new InvalidOperationException($"unexpected {e.ValueKind} in a summary"),
        };
        return JsonSerializer.Serialize(Convert(element));
    }

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

    /// <summary>
    /// Table A: the effective package is the node's own declared package, else the nearest
    /// enclosing node's, else the file's default, else "". A NESTED requirement without a package of
    /// its own takes its PARENT's, not the file's. The corpus's gate cases cannot see a wrong answer
    /// here unless a bare reference happens to resolve differently, so it is asserted directly.
    /// </summary>
    [Fact]
    public void Effective_package_of_a_nested_requirement_is_its_parents_not_the_files()
    {
        const string shop = """
            metadata:
              package: acme::shop
              children:
                - requirement.functional:
                    name: Orders
                    level: 3
                    status: planned
                    statement: Every placed order is kept.
                    counterexample: A placed order that is lost.
                    children:
                      - requirement.functional:
                          name: Recorded
                          level: 4
                          status: planned
                          statement: An order is recorded when it is placed.
                          counterexample: A placed order has no row.
                - requirement.functional:
                    name: Invoiced
                    package: acme::billing
                    level: 3
                    status: planned
                    statement: An invoice is raised for every order.
                    counterexample: An order with no invoice.
                    children:
                      - requirement.functional:
                          name: Numbered
                          level: 4
                          status: planned
                          statement: An invoice carries a number.
                          counterexample: An invoice nobody can quote back.
            """;
        var dir = Directory.CreateTempSubdirectory("mo-req-effective-package-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.shop.yaml"), shop);
            var load = MetaDataLoader.FromDirectory(dir, strict: true);
            Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

            var packages = RequirementCheck.CollectAddressed(load.Root)
                .ToDictionary(a => a.Path, a => RequirementCheck.EffectivePackage(a.Node));
            Assert.Equal("acme::shop", packages["Orders"]);
            Assert.Equal("acme::shop", packages["Orders.Recorded"]);
            Assert.Equal("acme::billing", packages["Invoiced"]);
            Assert.Equal("acme::billing", packages["Invoiced.Numbered"]);
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Fact]
    public void Effective_package_of_a_requirement_in_a_packageless_file_is_empty()
    {
        const string bare = """
            metadata:
              children:
                - requirement.functional:
                    name: Orders
                    level: 3
                    status: planned
                    statement: Every placed order is kept.
                    counterexample: A placed order that is lost.
                    children:
                      - requirement.functional:
                          name: Recorded
                          level: 4
                          status: planned
                          statement: An order is recorded when it is placed.
                          counterexample: A placed order has no row.
            """;
        var dir = Directory.CreateTempSubdirectory("mo-req-effective-package-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, "meta.bare.yaml"), bare);
            var load = MetaDataLoader.FromDirectory(dir, strict: true);
            Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

            Assert.All(RequirementCheck.CollectAddressed(load.Root), a => Assert.Equal("", RequirementCheck.EffectivePackage(a.Node)));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Fixture(string name)
    {
        var caseDir = Path.Combine(CorpusDir, name);
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "expected.json")));
        var options = ReadOptions(caseDir);

        if (SameInputAs.TryGetValue(name, out var twin))
            Assert.Equal(InputFiles(twin), InputFiles(name));

        // Strict, with the libraries options.json names; the files load in ascending file-name order.
        var load = MetaDataLoader.FromDirectory(Path.Combine(caseDir, "input"), options.Libraries, strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

        // No scope predicate and no forced coverage answer: both are the port's defaults.
        var scan = RequirementCheck.Scan(load.Root, requireImplementers: options.RequireImplementers);

        var actual = RequirementCheck.Check(load.Root, scan)
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

        Assert.Equal(CanonicalJson(doc.RootElement.GetProperty("summary")), SummaryJson(RequirementCheck.Summarise(load.Root, scan)));
    }
}
