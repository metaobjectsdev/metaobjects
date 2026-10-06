using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Core.Requirement;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Cross-port requirement-test identity corpus: <c>fixtures/requirement-test-identity-conformance/</c>.
/// See that directory's README.md for the fixture format. Every case is LOADED strict first (in
/// file-name order, asserting no load error), and only then are its test identities computed through
/// the port's PUBLIC seams: the grain when <c>options.json</c> sets one, and the filter when it names
/// one. An option the case does not set is not passed, so the port's own default applies. Mirrors the
/// TypeScript reference (<c>requirement-test-identity-conformance.test.ts</c>); a mismatch here is a
/// bug in THIS port, never in the fixture, and a committed <c>expected.json</c> is never edited to make
/// this port pass.
/// </summary>
public class RequirementTestIdentityConformanceTests
{
    /// <summary>
    /// The corpus holds 26 cases. A floor, asserted in this class, so an empty or mislocated corpus
    /// (a walk that found some other directory, a checkout that lost the fixtures) cannot pass by
    /// running nothing.
    /// </summary>
    private const int ExpectedCaseFloor = 26;

    /// <summary>
    /// The whole of <c>options.json</c>. A key outside this list is refused rather than ignored: a
    /// misspelt <c>grain</c> would otherwise run the case under the default and pin the wrong tests.
    /// </summary>
    private static readonly string[] OptionKeys = ["grain", "filter"];

    private static readonly string CorpusDir = ResolveCorpusDir();

    private static string ResolveCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "fixtures", "requirement-test-identity-conformance");
            if (Directory.Exists(candidate)) return candidate;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException(
            "Could not locate fixtures/requirement-test-identity-conformance/ by walking up from " + AppContext.BaseDirectory);
    }

    private static List<string> Cases() =>
        Directory.GetDirectories(CorpusDir).Select(d => Path.GetFileName(d)!).OrderBy(n => n, StringComparer.Ordinal).ToList();

    public static IEnumerable<object[]> Fixtures() => Cases().Select(n => new object[] { n });

    /// <summary>The closed list of named predicates of the corpus README: exactly eight rows.</summary>
    private sealed class NamedFilter(string name, Func<RequirementView, bool> predicate) : IRequirementTestFilter
    {
        public string Name { get; } = name;
        public bool Include(RequirementView view) => predicate(view);
    }

    private static readonly Dictionary<string, Func<RequirementView, bool>> Predicates = new(StringComparer.Ordinal)
    {
        ["all"] = _ => true,
        ["architectural"] = v => v.SubType == "architectural",
        ["live"] = v => v.Status == "live",
        ["level-5"] = v => v.Level == 5,
        ["package-acme-shop"] = v => v.Package == "acme::shop",
        ["path-under-Shop"] = v => v.Path == "Shop" || v.Path.StartsWith("Shop.", StringComparison.Ordinal),
        ["claims-entity"] = v => v.ImplementedByTypes.Contains("object.entity"),
        ["unlevelled"] = v => v.Level is null,
    };

    private static IRequirementTestFilter FilterNamed(string name)
    {
        Assert.True(Predicates.TryGetValue(name, out var predicate), $"unknown named filter '{name}': the corpus names one of {string.Join(", ", Predicates.Keys)}");
        return new NamedFilter(name, predicate!);
    }

    private sealed record Options(RequirementTestGrain? Grain, IRequirementTestFilter? Filter);

    private static Options ReadOptions(string caseDir)
    {
        var file = Path.Combine(caseDir, "options.json");
        if (!File.Exists(file)) return new Options(null, null);

        using var doc = JsonDocument.Parse(File.ReadAllText(file));
        Assert.Equal(JsonValueKind.Object, doc.RootElement.ValueKind);
        var unknown = doc.RootElement.EnumerateObject().Select(p => p.Name).Except(OptionKeys).Order().ToList();
        Assert.True(unknown.Count == 0, $"{file}: unknown option(s) {string.Join(", ", unknown)}");

        RequirementTestGrain? grain = null;
        if (doc.RootElement.TryGetProperty("grain", out var g))
        {
            Assert.True(g.ValueKind == JsonValueKind.String, $"{file}: 'grain' must be a string");
            grain = RequirementTestGrains.Parse(g.GetString());
        }
        IRequirementTestFilter? filter = null;
        if (doc.RootElement.TryGetProperty("filter", out var f))
        {
            Assert.True(f.ValueKind == JsonValueKind.String, $"{file}: 'filter' must be a string");
            filter = FilterNamed(f.GetString()!);
        }
        return new Options(grain, filter);
    }

    private static List<string> DocumentedCases()
    {
        var readme = File.ReadAllText(Path.Combine(CorpusDir, "README.md"));
        var section = Regex.Split(readme, "^## ", RegexOptions.Multiline).FirstOrDefault(s => s.StartsWith("Cases\n", StringComparison.Ordinal));
        Assert.NotNull(section);
        return Regex.Matches(section!, @"^\| `([^`]+)` \|", RegexOptions.Multiline).Select(m => m.Groups[1].Value).ToList();
    }

    [Fact]
    public void The_corpus_has_at_least_the_26_cases_it_was_built_with()
    {
        var cases = Cases();
        Assert.True(cases.Count >= ExpectedCaseFloor, $"found {cases.Count} case(s) in {CorpusDir}, expected at least {ExpectedCaseFloor}");
    }

    [Fact]
    public void Every_case_on_disk_is_documented_in_the_readme_and_nothing_else_is() =>
        Assert.Equal(Cases(), DocumentedCases().Order(StringComparer.Ordinal).ToList());

    [Fact]
    public void A_filter_name_outside_the_closed_list_fails_the_case()
    {
        Assert.Equal(8, Predicates.Count);
        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => FilterNamed("no-such-filter"));
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Fixture(string name)
    {
        var caseDir = Path.Combine(CorpusDir, name);
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "expected.json")));
        var options = ReadOptions(caseDir);

        // Strict, files in ascending file-name order, and no load error.
        var load = MetaDataLoader.FromDirectory(Path.Combine(caseDir, "input"), strict: true);
        Assert.Empty(load.Errors.Select(e => e.Code + ": " + e.Message));

        // The grain and the filter go in only when the case sets them.
        var actual = RequirementTestIdentities.Identities(load.Root, options.Grain, options.Filter);

        static string Line(string id, string pkg, string path, string unit, string key, string? status, string? skip, string digest) =>
            $"{id} | package={pkg} | path={path} | unit={unit} | key={key} | status={status ?? "<none>"} | skip={skip ?? "<none>"} | digest={digest}";

        var actualLines = actual
            .OrderBy(t => t.Id, StringComparer.Ordinal)
            .Select(t => Line(t.Id, t.Package, t.Path, t.Unit, t.WitnessKey, t.Status, t.Skip, t.Digest))
            .ToList();
        var wantedLines = doc.RootElement.GetProperty("tests").EnumerateArray()
            .Select(t => (
                Id: t.GetProperty("id").GetString()!,
                Line: Line(
                    t.GetProperty("id").GetString()!,
                    t.GetProperty("package").GetString()!,
                    t.GetProperty("path").GetString()!,
                    t.GetProperty("unit").GetString()!,
                    t.GetProperty("witnessKey").GetString()!,
                    t.GetProperty("status").GetString(),
                    t.GetProperty("skip").GetString(),
                    t.GetProperty("digest").GetString()!)))
            .OrderBy(t => t.Id, StringComparer.Ordinal)
            .Select(t => t.Line)
            .ToList();
        Assert.Equal(wantedLines, actualLines);

        var actualCollisions = RequirementTestIdentities.WitnessKeyCollisions(actual)
            .Select(p => $"{p.First} <> {p.Second}").ToList();
        var wantedCollisions = doc.RootElement.GetProperty("collisions").EnumerateArray()
            .Select(p =>
            {
                var pair = p.EnumerateArray().Select(x => x.GetString()!).Order(StringComparer.Ordinal).ToList();
                return (First: pair[0], Second: pair[1]);
            })
            .OrderBy(p => p.First, StringComparer.Ordinal).ThenBy(p => p.Second, StringComparer.Ordinal)
            .Select(p => $"{p.First} <> {p.Second}")
            .ToList();
        Assert.Equal(wantedCollisions, actualCollisions);
    }

    // ----------------------------------------------------------------------------------------
    // What the corpus cannot pin: the loaders are not known to agree on a non-ASCII requirement name,
    // so no input declares one. The key function is held to the rule directly instead.
    // ----------------------------------------------------------------------------------------

    /// <summary>
    /// The mangle class is ASCII <c>[A-Za-z0-9]</c> and excludes <c>_</c>. <c>char.IsLetterOrDigit</c>
    /// (and Regex's <c>\w</c>) keep an accented letter, so a port that used either gives
    /// <c>req_acme_shop_Café_Réglé</c> here and nothing else in the suite would notice.
    /// </summary>
    [Fact]
    public void The_witness_key_replaces_a_non_ASCII_letter_like_any_other_character()
    {
        // each é is the single code point U+00E9
        Assert.Equal("req_acme_shop_Caf_R_gl_", RequirementTestIdentities.WitnessKeyOf("acme::shop::Café.Réglé", "*"));
        Assert.Equal("req_acme_shop_Orders_Recorded__object_entity",
            RequirementTestIdentities.WitnessKeyOf("acme::shop::Orders.Recorded", "object.entity"));
        Assert.Equal("req_Sales_Orders", RequirementTestIdentities.WitnessKeyOf("Sales__Orders", "*"));
    }

    [Fact]
    public void An_unknown_grain_is_refused_with_a_clear_error_wherever_it_enters()
    {
        var text = Assert.Throws<ArgumentException>(() => RequirementTestGrains.Parse("hybrid"));
        Assert.Contains("unknown requirement-test grain \"hybrid\"", text.Message);
        Assert.Contains("\"concern\" or \"member\"", text.Message);
        Assert.Throws<ArgumentException>(() => RequirementTestGrains.Parse(null));
        Assert.Throws<ArgumentException>(() => RequirementTestGrains.Parse("Concern"));

        // An undefined enum value is legal C#, and the branch that tests for Member would run it as a
        // hybrid. It is refused over any model, even one with no requirement at all.
        var undefined = (RequirementTestGrain)5;
        var load = MetaDataLoader.FromDirectory(Path.Combine(CorpusDir, "worked-example", "input"), strict: true);
        Assert.Empty(load.Errors);
        var refused = Assert.Throws<ArgumentException>(() => RequirementTestIdentities.Identities(load.Root, undefined));
        Assert.Contains("unknown requirement-test grain 5", refused.Message);
        var walked = RequirementTestIdentities.Walk(load.Root)[0];
        Assert.Throws<ArgumentException>(() => RequirementTestIdentities.Units(walked, undefined));
        Assert.Throws<ArgumentException>(() => RequirementTestGrains.Text(undefined));
    }

    [Fact]
    public void A_view_level_is_absent_for_an_unlevelled_requirement_and_a_number_for_level_0_and_minus_1()
    {
        var load = MetaDataLoader.FromDirectory(Path.Combine(CorpusDir, "filter-by-absent-level", "input"), strict: true);
        Assert.Empty(load.Errors);
        var levels = RequirementTestIdentities.Walk(load.Root).ToDictionary(w => w.View.Path, w => w.View.Level);
        Assert.Contains(levels, kv => kv.Value is null);
        Assert.Contains(levels, kv => kv.Value == 0);
        Assert.Contains(levels, kv => kv.Value == -1);
    }
}
