// FixtureLint — port of typescript/packages/conformance/src/fixture-lint.ts.
//
// Validates fixture corpus integrity, independent of any language adapter.
// Every expected-errors.json code must be registered; script.json must parse;
// navigate colon-segments must name nodes present in expected.json.

using System.Text.Json;
using System.Text.RegularExpressions;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// Corpus-integrity linter for conformance fixtures.
/// </summary>
public static class FixtureLint
{
    // Colon segment: type:name  (name has no '[')
    private static readonly Regex ColonSeg =
        new(@"^[a-z][a-z0-9-]*:[^\[]+$", RegexOptions.Compiled);

    // Bracket segment: type[subType]
    private static readonly Regex BracketSeg =
        new(@"^[a-z][a-z0-9-]*\[[a-zA-Z][a-zA-Z0-9-]*\]$", RegexOptions.Compiled);

    /// <summary>
    /// Lint one fixture. Returns a list of problem strings; empty = clean.
    /// </summary>
    /// <param name="fix">The fixture to lint.</param>
    /// <param name="errorCodes">All registered error codes from ERROR-CODES.json.</param>
    public static IReadOnlyList<string> LintFixture(Fixture fix, IReadOnlyList<string> errorCodes)
    {
        var problems = new List<string>();

        if (fix.HasExpectedErrors)
        {
            IReadOnlyList<string> codes;
            try
            {
                var raw = File.ReadAllText(System.IO.Path.Combine(fix.Dir, "expected-errors.json"));
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                codes = OperationScriptParser.ParseExpectedErrors(parsed);
            }
            catch (Exception ex)
            {
                problems.Add($"{fix.Name}: malformed expected-errors.json — {ex.Message}");
                return problems;
            }

            foreach (var code in codes)
            {
                if (!errorCodes.Contains(code, StringComparer.Ordinal))
                    problems.Add($"{fix.Name}: unregistered error code '{code}'");
            }
        }

        if (fix.HasScript)
        {
            OperationScript script;
            try
            {
                var raw = File.ReadAllText(System.IO.Path.Combine(fix.Dir, "script.json"));
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                script = OperationScriptParser.ParseOperationScript(parsed);
            }
            catch (Exception ex)
            {
                problems.Add($"{fix.Name}: malformed script.json — {ex.Message}");
                return problems;
            }

            if (fix.HasExpected)
            {
                // Collect all "name" values in expected.json as the over-approximation
                // set of known node names.
                var known = new HashSet<string>(StringComparer.Ordinal);
                try
                {
                    var raw = File.ReadAllText(System.IO.Path.Combine(fix.Dir, "expected.json"));
                    var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                    CollectNames(parsed, known);
                }
                catch
                {
                    // If expected.json can't be read/parsed we can't check navigate — skip.
                }

                foreach (var op in script.Operations)
                {
                    foreach (var segment in op.Navigate)
                    {
                        if (BracketSeg.IsMatch(segment))
                        {
                            // Bracket segments address nameless nodes — accepted as-is.
                            continue;
                        }

                        if (!ColonSeg.IsMatch(segment))
                        {
                            problems.Add(
                                $"{fix.Name}: navigate segment '{segment}' has malformed syntax " +
                                "(expected 'type:name' or 'type[subType]')");
                            continue;
                        }

                        // Colon segment — check the named node exists in expected.json.
                        var colonIdx = segment.IndexOf(':');
                        var nodeName = segment[(colonIdx + 1)..];
                        if (!known.Contains(nodeName))
                        {
                            problems.Add(
                                $"{fix.Name}: navigate segment '{segment}' names a node " +
                                "absent from expected.json");
                        }
                    }
                }
            }
        }

        return problems;
    }

    /// <summary>
    /// Recursively collect every "name" string value in a JSON element.
    /// Mirrors the TS <c>namesIn</c> function — an over-approximation that
    /// never produces false positives.
    /// </summary>
    private static void CollectNames(JsonElement element, HashSet<string> acc)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                    CollectNames(item, acc);
                break;

            case JsonValueKind.Object:
                foreach (var prop in element.EnumerateObject())
                {
                    if (prop.Name == "name" && prop.Value.ValueKind == JsonValueKind.String)
                        acc.Add(prop.Value.GetString()!);
                    else
                        CollectNames(prop.Value, acc);
                }
                break;
        }
    }
}
