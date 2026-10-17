// ADR-0059 conformance gates, in every port:
//
//   Gate 1 — YAML twin. Every conformance fixture's input loads once as JSON and once with the
//            same texts read as YAML, in the same order. Both loads report the same ordered error
//            codes and, when clean, serialize identically (effective serialization too, where the
//            fixture has one). Exclusions live in the shared fixtures/conformance/
//            yaml-twin-exclusions.json, one reason per entry; there are no per-port divergences.
//   Gate 2 — Round trip. Every fixture's expected.json loads as the only input and serializes
//            back to itself. Exclusions live in fixtures/conformance/round-trip-exclusions.json.
//
// Mirrors server/typescript/packages/metadata/test/conformance-twin-roundtrip.test.ts.

using System.Text.Json;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class YamlTwinConformanceTests
{
    private static IReadOnlyDictionary<string, string> ReadExclusions(string fileName)
    {
        var path = Path.Combine(CorpusRoot.Path, fileName);
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty("exclusions").EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Value.GetString() ?? "", StringComparer.Ordinal);
    }

    private static readonly IReadOnlyDictionary<string, string> TwinExclusions = ReadExclusions("yaml-twin-exclusions.json");
    private static readonly IReadOnlyDictionary<string, string> RoundTripExclusions = ReadExclusions("round-trip-exclusions.json");

    private static IEnumerable<Fixture> Runnable() =>
        FixtureDiscovery.DiscoverFixtures(CorpusRoot.Path).Where(f => !f.IsDocsOnly && !f.IsContractOnly);

    public static IEnumerable<object[]> TwinFixtures() =>
        Runnable().Where(f => !TwinExclusions.ContainsKey(f.Name)).Select(f => new object[] { f });

    public static IEnumerable<object[]> RoundTripFixtures() =>
        Runnable().Where(f => f.HasExpected && !RoundTripExclusions.ContainsKey(f.Name)).Select(f => new object[] { f });

    /// <summary>The fixture's input files in load order, as in-memory sources of the given format
    /// (<c>null</c> keeps each file's own format; <c>Yaml</c> reads every file as YAML).</summary>
    private static List<IMetaDataSource> Sources(string inputDir, MetaDataFormat? forceFormat) =>
        new DirectorySource(inputDir).Expand()
            .Select(f => (IMetaDataSource)new InMemoryStringSource(
                f.Read(), f.Id, forceFormat is { } fmt && f.Format == MetaDataFormat.Json ? fmt : f.Format))
            .ToList();

    [Fact]
    public void ExclusionsNameRealFixtures()
    {
        var names = FixtureDiscovery.DiscoverFixtures(CorpusRoot.Path).Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var name in TwinExclusions.Keys.Concat(RoundTripExclusions.Keys))
            Assert.True(names.Contains(name), $"exclusion \"{name}\" names no fixture");
    }

    [Theory]
    [MemberData(nameof(TwinFixtures))]
    public void YamlTwin(Fixture fix)
    {
        var asJson = ConformanceAdapter.LoadSources(Sources(fix.InputDir, null), fix.Providers);
        var asYaml = ConformanceAdapter.LoadSources(Sources(fix.InputDir, MetaDataFormat.Yaml), fix.Providers);

        Assert.Equal(asJson.ErrorCodes, asYaml.ErrorCodes);
        if (asJson.ErrorCodes.Count != 0 || asJson.Tree is null) return;

        Assert.Equal(
            ConformanceAdapter.CanonicalSerialize(asJson.Tree).Trim(),
            ConformanceAdapter.CanonicalSerialize(asYaml.Tree).Trim());
        if (fix.HasExpectedEffective)
        {
            Assert.Equal(
                ConformanceAdapter.CanonicalSerializeEffective(asJson.Tree).Trim(),
                ConformanceAdapter.CanonicalSerializeEffective(asYaml.Tree).Trim());
        }
    }

    [Theory]
    [MemberData(nameof(RoundTripFixtures))]
    public void RoundTrip(Fixture fix)
    {
        string expected = File.ReadAllText(Path.Combine(fix.Dir, "expected.json"));
        var outcome = ConformanceAdapter.LoadSources(
            [new InMemoryStringSource(expected, "expected.json", MetaDataFormat.Json)], fix.Providers);

        Assert.Empty(outcome.ErrorCodes);
        Assert.Equal(expected.Trim(), ConformanceAdapter.CanonicalSerialize(outcome.Tree).Trim());
    }
}
