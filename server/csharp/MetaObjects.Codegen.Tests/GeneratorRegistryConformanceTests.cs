using System.Text.Json;
using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port conformance for the C# generator registry (ADR-0021 D3). Validates
/// <see cref="GeneratorRegistry"/> against the CANONICAL stable-name manifest at
/// <c>fixtures/generator-registry-conformance/registry.json</c> — the single
/// cross-port source of truth every port's registry is checked against.
///
/// Contract for the <c>csharp</c> port:
///   (1) every stable name the C# registry exposes appears in the manifest;
///   (2) presence both ways — every manifest entry whose <c>ports</c> includes
///       <c>csharp</c> IS in the C# registry, and the C# registry exposes NO name
///       whose manifest <c>ports</c> omits <c>csharp</c> (i.e. the two sets are EQUAL);
///   (3) tier agreement — every native manifest name is non-neutral in the registry
///       (C# has no neutral generators per the manifest).
///
/// On mismatch this REPORTS the exact diff (extras / missing / tier) so the manifest
/// and registry can be reconciled. It never mutates either.
/// </summary>
public sealed class GeneratorRegistryConformanceTests
{
    private const string Port = "csharp";

    // Walk upward from the test assembly to the repo root (contains the manifest dir),
    // mirroring RenderHelperConformanceTests.Corpus().
    private static string ManifestPath()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !Directory.Exists(Path.Combine(dir, "fixtures", "generator-registry-conformance")))
            dir = Directory.GetParent(dir)?.FullName;
        if (dir is null)
            throw new InvalidOperationException(
                "fixtures/generator-registry-conformance not found walking up from " + AppContext.BaseDirectory);
        return Path.Combine(dir, "fixtures", "generator-registry-conformance", "registry.json");
    }

    private sealed record ManifestEntry(string Name, string Tier, IReadOnlyList<string> Ports);

    private static IReadOnlyList<ManifestEntry> LoadManifest()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(ManifestPath()));
        var generators = doc.RootElement.GetProperty("generators");
        var entries = new List<ManifestEntry>();
        foreach (var prop in generators.EnumerateObject())
        {
            var tier = prop.Value.GetProperty("tier").GetString()!;
            var ports = prop.Value.GetProperty("ports").EnumerateArray()
                .Select(p => p.GetString()!).ToList();
            entries.Add(new ManifestEntry(prop.Name, tier, ports));
        }
        return entries;
    }

    /// <summary>(1)+(2): the manifest's csharp slice equals the C# registry's stable names.</summary>
    [Fact]
    public void RegistryStableNames_EqualManifestCsharpSlice()
    {
        var manifest = LoadManifest();

        var expected = manifest
            .Where(e => e.Ports.Contains(Port))
            .Select(e => e.Name)
            .ToHashSet(StringComparer.Ordinal);

        var actual = GeneratorRegistry.Entries.Keys.ToHashSet(StringComparer.Ordinal);

        var missing = expected.Except(actual).OrderBy(n => n, StringComparer.Ordinal).ToList();
        var extras = actual.Except(expected).OrderBy(n => n, StringComparer.Ordinal).ToList();

        Assert.True(
            missing.Count == 0 && extras.Count == 0,
            $"C# generator registry disagrees with the canonical manifest's `{Port}` slice " +
            $"(fixtures/generator-registry-conformance/registry.json).\n" +
            $"  MISSING (manifest says `{Port}` exposes it, but the registry does not): " +
            $"[{string.Join(", ", missing)}]\n" +
            $"  EXTRA  (registry exposes it, but the manifest omits `{Port}` for it):    " +
            $"[{string.Join(", ", extras)}]\n" +
            "Reconcile by editing the manifest AND the registry together — do not force one to match.");
    }

    /// <summary>(3): every native manifest name is non-neutral (Native) in the C# registry.</summary>
    [Fact]
    public void TierAgreement_NativeManifestNames_AreNativeInRegistry()
    {
        var manifest = LoadManifest();

        var tierMismatches = manifest
            .Where(e => e.Ports.Contains(Port))
            .Where(e => GeneratorRegistry.Entries.TryGetValue(e.Name, out var reg)
                        && !TierMatches(e.Tier, reg.Tier))
            .Select(e =>
                $"{e.Name}: manifest tier=`{e.Tier}` but registry tier=`{GeneratorRegistry.Entries[e.Name].Tier}`")
            .ToList();

        Assert.True(
            tierMismatches.Count == 0,
            "C# generator registry tier disagrees with the canonical manifest:\n  " +
            string.Join("\n  ", tierMismatches));
    }

    private static bool TierMatches(string manifestTier, GeneratorTier registryTier) =>
        manifestTier switch
        {
            "native" => registryTier == GeneratorTier.Native,
            "neutral" => registryTier == GeneratorTier.Neutral,
            _ => false,
        };
}
