// FixtureDiscovery — port of typescript/packages/conformance/src/fixture.ts.
//
// Discovers every scenario directory under a corpus root, sorted by name.
// Each scenario becomes a Fixture record with presence-flags for each
// expectation file (expected.json, expected-effective.json, expected-errors.json,
// expected-warnings.json, script.json).

using System.Text.Json;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// A discovered conformance scenario.
/// </summary>
/// <param name="Name">Scenario directory name.</param>
/// <param name="Dir">Absolute path to the scenario directory.</param>
/// <param name="InputDir">Absolute path to the input/ directory.</param>
/// <param name="Providers">Provider ids to compose for this fixture.</param>
/// <param name="HasExpected">Whether expected.json is present.</param>
/// <param name="HasExpectedEffective">Whether expected-effective.json is present.</param>
/// <param name="HasExpectedErrors">Whether expected-errors.json is present.</param>
/// <param name="HasExpectedWarnings">Whether expected-warnings.json is present.</param>
/// <param name="HasScript">Whether script.json is present.</param>
public sealed record Fixture(
    string Name,
    string Dir,
    string InputDir,
    IReadOnlyList<string> Providers,
    bool HasExpected,
    bool HasExpectedEffective,
    bool HasExpectedErrors,
    bool HasExpectedWarnings,
    bool HasScript);

/// <summary>
/// Discovers all conformance fixtures under a corpus root.
/// </summary>
public static class FixtureDiscovery
{
    private static readonly IReadOnlyList<string> DefaultProviders =
        new[] { "metaobjects-core-types" };

    /// <summary>
    /// Discover every scenario directory under <paramref name="corpusRoot"/>,
    /// sorted by name. Throws if any fixture is missing an <c>input/</c> directory.
    /// </summary>
    public static IReadOnlyList<Fixture> DiscoverFixtures(string corpusRoot)
    {
        var entries = Directory
            .GetDirectories(corpusRoot)
            .Select(d => System.IO.Path.GetFileName(d))
            .Order(StringComparer.Ordinal)
            .ToList();

        var fixtures = new List<Fixture>(entries.Count);
        foreach (var name in entries)
        {
            var dir = System.IO.Path.Combine(corpusRoot, name);
            var inputDir = System.IO.Path.Combine(dir, "input");
            if (!Directory.Exists(inputDir))
                throw new InvalidOperationException(
                    $"Fixture '{name}' has no input/ directory");

            // Read providers.json if present; else default to core types.
            IReadOnlyList<string> providers = DefaultProviders;
            var providersPath = System.IO.Path.Combine(dir, "providers.json");
            if (File.Exists(providersPath))
            {
                var raw = File.ReadAllText(providersPath);
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                if (parsed.ValueKind != JsonValueKind.Array ||
                    parsed.EnumerateArray().Any(e => e.ValueKind != JsonValueKind.String))
                {
                    throw new InvalidOperationException(
                        $"Fixture '{name}': providers.json must be a JSON array of strings");
                }
                providers = parsed.EnumerateArray()
                    .Select(e => e.GetString()!)
                    .ToList();
            }

            fixtures.Add(new Fixture(
                Name: name,
                Dir: dir,
                InputDir: inputDir,
                Providers: providers,
                HasExpected: File.Exists(System.IO.Path.Combine(dir, "expected.json")),
                HasExpectedEffective: File.Exists(System.IO.Path.Combine(dir, "expected-effective.json")),
                HasExpectedErrors: File.Exists(System.IO.Path.Combine(dir, "expected-errors.json")),
                HasExpectedWarnings: File.Exists(System.IO.Path.Combine(dir, "expected-warnings.json")),
                HasScript: File.Exists(System.IO.Path.Combine(dir, "script.json"))));
        }

        return fixtures;
    }
}
