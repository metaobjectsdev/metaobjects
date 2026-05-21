// ExpectedFailures — port of typescript/packages/conformance/src/expected-failures.ts.
//
// Three-rule classifier:
//   listed + fail  → "known-gap"
//   listed + pass  → "fixed-but-listed"
//   unlisted + fail → "fail"
//   unlisted + pass → "pass"

using System.Text.Json;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Expected-failures ledger loaded from conformance-expected-failures.json.
/// </summary>
public static class ExpectedFailures
{
    /// <summary>
    /// Classify a fixture's raw pass/fail status against the ledger.
    /// </summary>
    /// <param name="passed">Whether all conformance checks for the fixture passed.</param>
    /// <param name="name">The fixture name.</param>
    /// <returns>
    /// One of: <c>"pass"</c>, <c>"known-gap"</c>, <c>"fail"</c>, <c>"fixed-but-listed"</c>.
    /// </returns>
    public static string Classify(bool passed, string name)
    {
        var listed = Ledger.Contains(name, StringComparer.Ordinal);
        if (!passed) return listed ? "known-gap" : "fail";
        return listed ? "fixed-but-listed" : "pass";
    }

    /// <summary>
    /// The loaded ledger — fixture names that are known to fail for this port.
    /// </summary>
    private static readonly IReadOnlyList<string> Ledger = LoadLedger();

    private static IReadOnlyList<string> LoadLedger()
    {
        // Look for the ledger file next to the test assembly.
        var ledgerPath = System.IO.Path.Combine(
            AppContext.BaseDirectory, "conformance-expected-failures.json");

        if (!File.Exists(ledgerPath))
            return Array.Empty<string>();

        try
        {
            var raw = File.ReadAllText(ledgerPath);
            var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
            if (parsed.TryGetProperty("fixtures", out var fixtures) &&
                fixtures.ValueKind == JsonValueKind.Array)
            {
                return fixtures.EnumerateArray()
                    .Where(e => e.ValueKind == JsonValueKind.String)
                    .Select(e => e.GetString()!)
                    .ToList();
            }
        }
        catch
        {
            // Missing or malformed ledger → empty.
        }

        return Array.Empty<string>();
    }
}
