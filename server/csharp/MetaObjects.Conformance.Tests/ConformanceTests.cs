// ConformanceTests — two [Theory] tests over every corpus fixture.
//
// Ports typescript/packages/metadata/test/conformance.test.ts + conformance/src/runner.ts.
//
// Lint(fixture)        — corpus-integrity only, adapter-independent.
// Conformance(fixture) — runs the full check suite through ConformanceAdapter.

using System.Text.Json;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ConformanceTests
{
    // -------------------------------------------------------------------------
    // Fixture discovery (shared)
    // -------------------------------------------------------------------------

    /// <summary>
    /// xUnit MemberData source — one entry per discovered fixture. Docs-only
    /// fixtures (an <c>expected/*.md</c> directory, no strict expectation files)
    /// drive the docs-conformance runner only and are skipped here.
    /// </summary>
    public static IEnumerable<object[]> Fixtures() =>
        FixtureDiscovery.DiscoverFixtures(CorpusRoot.Path)
            .Where(f => !f.IsDocsOnly)
            .Select(f => new object[] { f });

    // -------------------------------------------------------------------------
    // Error codes — loaded once from corpus ERROR-CODES.json
    // -------------------------------------------------------------------------

    private static readonly IReadOnlyList<string> ErrorCodes = LoadErrorCodes();

    private static IReadOnlyList<string> LoadErrorCodes()
    {
        var path = System.IO.Path.Combine(CorpusRoot.Path, "ERROR-CODES.json");
        var raw = File.ReadAllText(path);
        var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
        // ERROR-CODES.json has the form { "codes": { "ERR_xxx": "...", ... } }
        if (parsed.TryGetProperty("codes", out var codes) &&
            codes.ValueKind == JsonValueKind.Object)
        {
            return codes.EnumerateObject().Select(p => p.Name).ToList();
        }
        throw new InvalidOperationException(
            "ERROR-CODES.json does not contain the expected { \"codes\": { ... } } shape.");
    }

    // -------------------------------------------------------------------------
    // Lint test — corpus integrity, adapter-independent
    // -------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Lint(Fixture fix)
    {
        var problems = FixtureLint.LintFixture(fix, ErrorCodes);
        Assert.Empty(problems);
    }

    // -------------------------------------------------------------------------
    // Conformance test — full check suite through ConformanceAdapter
    // -------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Conformance(Fixture fix)
    {
        var outcome = ConformanceAdapter.LoadFixture(fix.InputDir, fix.Providers);
        var passed = RunChecks(fix, outcome, out var detail);
        var status = ExpectedFailures.Classify(passed, fix.Name);
        Assert.True(
            status is "pass" or "known-gap",
            $"{fix.Name} [{status}]: {detail}");
    }

    // -------------------------------------------------------------------------
    // RunChecks — mirrors runner.ts check ordering exactly
    // -------------------------------------------------------------------------

    /// <summary>
    /// Execute every check the fixture declares. Returns true if all passed.
    /// <paramref name="detail"/> receives a human-readable summary of failures.
    /// </summary>
    private static bool RunChecks(Fixture fix, LoadOutcome outcome, out string detail)
    {
        var failures = new List<string>();

        // ── expected-errors check ──────────────────────────────────────────────
        if (fix.HasExpectedErrors)
        {
            OperationScriptParser.ExpectedErrorsEnvelope? envelope = null;
            try
            {
                var raw = File.ReadAllText(
                    System.IO.Path.Combine(fix.Dir, "expected-errors.json"));
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                envelope = OperationScriptParser.ParseExpectedErrorsEnvelope(parsed);
            }
            catch (Exception ex)
            {
                failures.Add($"expected-errors.json parse error: {ex.Message}");
            }

            if (envelope != null)
            {
                // Code-set check (order-independent) — legacy semantics, always run.
                var wantCodes = envelope.Errors.Select(e => e.Code).Order(StringComparer.Ordinal).ToList();
                var gotCodes = outcome.ErrorCodes.Order(StringComparer.Ordinal).ToList();
                if (!wantCodes.SequenceEqual(gotCodes, StringComparer.Ordinal))
                    failures.Add(
                        $"expected codes [{string.Join(", ", wantCodes)}], " +
                        $"got [{string.Join(", ", gotCodes)}]");

                // FR5a / ADR-0009 — when the fixture uses the envelope shape,
                // assert per-error source.format / source.files / source.jsonPath
                // in declaration order.
                if (!envelope.Legacy)
                {
                    if (envelope.Errors.Count != outcome.Errors.Count)
                    {
                        failures.Add(
                            $"envelope length mismatch: expected {envelope.Errors.Count}, " +
                            $"got {outcome.Errors.Count}");
                    }
                    else
                    {
                        for (int i = 0; i < envelope.Errors.Count; i++)
                        {
                            var w = envelope.Errors[i];
                            var g = outcome.Errors[i];
                            if (w.Code != g.Code)
                            {
                                failures.Add(
                                    $"envelope[{i}].code: expected '{w.Code}', got '{g.Code}'");
                                continue;
                            }
                            if (w.Source is null) continue;
                            if (w.Source.Format != g.Format)
                                failures.Add(
                                    $"envelope[{i}].source.format: expected '{w.Source.Format}', got '{g.Format}'");
                            if (!w.Source.Files.SequenceEqual(g.Files, StringComparer.Ordinal))
                                failures.Add(
                                    $"envelope[{i}].source.files: expected [{string.Join(",", w.Source.Files)}], " +
                                    $"got [{string.Join(",", g.Files)}]");
                            if (w.Source.JsonPath != null && w.Source.JsonPath != g.JsonPath)
                                failures.Add(
                                    $"envelope[{i}].source.jsonPath: expected '{w.Source.JsonPath}', got '{g.JsonPath}'");
                            // FR5d — assert referrer / target for format=resolved envelopes.
                            if (w.Source.Referrer != null && w.Source.Referrer != g.Referrer)
                                failures.Add(
                                    $"envelope[{i}].source.referrer: expected '{w.Source.Referrer}', got '{g.Referrer}'");
                            if (w.Source.Target != null && w.Source.Target != g.Target)
                                failures.Add(
                                    $"envelope[{i}].source.target: expected '{w.Source.Target}', got '{g.Target}'");
                        }
                    }
                }
                // FR5c-finalize — warnings: when the fixture's envelope declares
                // warning entries with `source`, assert per-warning envelope shape
                // (same algorithm as errors above). When the fixture declares only
                // counts (warnings: [{code}] without source) or empty `[]`, the
                // length check still runs; the per-element source assertion is
                // skipped element-by-element when expected.source is null.
                if (!envelope.Legacy)
                {
                    var expectedW = envelope.Warnings;
                    var gotW = outcome.WarningEnvelopes;
                    if (expectedW.Count != outcome.Warnings.Count)
                    {
                        failures.Add(
                            $"warnings count: expected {expectedW.Count}, " +
                            $"got {outcome.Warnings.Count}");
                    }
                    else if (expectedW.Count == gotW.Count)
                    {
                        for (int i = 0; i < expectedW.Count; i++)
                        {
                            var w = expectedW[i];
                            var g = gotW[i];
                            if (w.Code != g.Code)
                            {
                                failures.Add(
                                    $"warning[{i}].code: expected '{w.Code}', got '{g.Code}'");
                                continue;
                            }
                            if (w.Source is null) continue;
                            if (w.Source.Format != g.Format)
                                failures.Add(
                                    $"warning[{i}].source.format: expected '{w.Source.Format}', got '{g.Format}'");
                            if (!w.Source.Files.SequenceEqual(g.Files, StringComparer.Ordinal))
                                failures.Add(
                                    $"warning[{i}].source.files: expected [{string.Join(",", w.Source.Files)}], " +
                                    $"got [{string.Join(",", g.Files)}]");
                            if (w.Source.JsonPath != null && w.Source.JsonPath != g.JsonPath)
                                failures.Add(
                                    $"warning[{i}].source.jsonPath: expected '{w.Source.JsonPath}', got '{g.JsonPath}'");
                            // FR5d — assert referrer / target for format=resolved envelopes.
                            if (w.Source.Referrer != null && w.Source.Referrer != g.Referrer)
                                failures.Add(
                                    $"warning[{i}].source.referrer: expected '{w.Source.Referrer}', got '{g.Referrer}'");
                            if (w.Source.Target != null && w.Source.Target != g.Target)
                                failures.Add(
                                    $"warning[{i}].source.target: expected '{w.Source.Target}', got '{g.Target}'");
                        }
                    }
                }
            }
        }

        // ── tree-required checks: guard with a synthetic failure if tree absent ─
        // Mirror the TS reference runner (runner.ts): the ONLY condition that
        // blocks the tree-dependent checks is a genuinely-absent tree (the
        // provider-composition-error path, where the adapter returns Tree: null!).
        // A load that collected non-fatal errors but still built a tree gets its
        // tree compared — canonical serialization emits whatever subtree the loader
        // built, and the comparison surfaces any real divergence. This is the
        // cross-port-aligned behavior: under ADR-0022 strict load a fixture using
        // tolerated-but-undeclared vocabulary (no expected-errors.json) collects
        // ERR_UNKNOWN_ATTR yet still serializes its tree identically to TS/Python,
        // so it must NOT be force-failed here (TS/Python skip the error-set check
        // when there is no expected-errors.json and run the tree check regardless).
        bool treeCheckBlocked =
            outcome.Tree is null &&
            (fix.HasExpected || fix.HasExpectedEffective || fix.HasScript);

        if (treeCheckBlocked)
        {
            failures.Add(
                "load produced no tree — cannot run tree-dependent checks");
        }

        // ── expected.json check ───────────────────────────────────────────────
        if (fix.HasExpected && !treeCheckBlocked)
        {
            string? want = null;
            try
            {
                want = File.ReadAllText(
                    System.IO.Path.Combine(fix.Dir, "expected.json")).Trim();
            }
            catch (Exception ex)
            {
                failures.Add($"expected.json read error: {ex.Message}");
            }

            if (want != null)
            {
                var got = ConformanceAdapter.CanonicalSerialize(outcome.Tree).Trim();
                if (want != got)
                    failures.Add("canonical serialization mismatch");
            }
        }

        // ── expected-effective.json check ─────────────────────────────────────
        if (fix.HasExpectedEffective && !treeCheckBlocked)
        {
            string? want = null;
            try
            {
                want = File.ReadAllText(
                    System.IO.Path.Combine(fix.Dir, "expected-effective.json")).Trim();
            }
            catch (Exception ex)
            {
                failures.Add($"expected-effective.json read error: {ex.Message}");
            }

            if (want != null)
            {
                var got = ConformanceAdapter.CanonicalSerializeEffective(outcome.Tree).Trim();
                if (want != got)
                    failures.Add("effective serialization mismatch");
            }
        }

        // ── expected-warnings.json check ─────────────────────────────────────
        // NOTE: The TS conformance runner currently does NOT check warnings (a
        // known TS-side gap). The C# runner DOES check them per the corpus spec.
        // This is a deliberate divergence — keep the warnings check.
        if (fix.HasExpectedWarnings)
        {
            IReadOnlyList<string>? want = null;
            try
            {
                var raw = File.ReadAllText(
                    System.IO.Path.Combine(fix.Dir, "expected-warnings.json"));
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                if (parsed.ValueKind != JsonValueKind.Array)
                    throw new InvalidOperationException(
                        "expected-warnings.json must be a JSON array");
                want = parsed.EnumerateArray()
                    .Select(e => e.GetString() ??
                        throw new InvalidOperationException("Warning entry is not a string"))
                    .ToList();
            }
            catch (Exception ex)
            {
                failures.Add($"expected-warnings.json parse error: {ex.Message}");
            }

            if (want != null)
            {
                var wantSorted = want.Order(StringComparer.Ordinal).ToList();
                var gotSorted = outcome.Warnings.Order(StringComparer.Ordinal).ToList();
                if (!wantSorted.SequenceEqual(gotSorted, StringComparer.Ordinal))
                    failures.Add(
                        $"expected warnings [{string.Join(", ", wantSorted)}], " +
                        $"got [{string.Join(", ", gotSorted)}]");
            }
        }
        else if (!fix.HasExpectedWarnings && !fix.HasExpectedErrors && fix.HasExpected && !treeCheckBlocked)
        {
            // Happy-path fixture with no expected-warnings.json — assert no warnings.
            if (outcome.Warnings.Count > 0)
                failures.Add(
                    $"unexpected warnings: [{string.Join(", ", outcome.Warnings)}]");
        }

        // ── script.json check ────────────────────────────────────────────────
        if (fix.HasScript && !treeCheckBlocked)
        {
            OperationScript? script = null;
            try
            {
                var raw = File.ReadAllText(
                    System.IO.Path.Combine(fix.Dir, "script.json"));
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                script = OperationScriptParser.ParseOperationScript(parsed);
            }
            catch (Exception ex)
            {
                failures.Add($"script.json parse error: {ex.Message}");
            }

            if (script is not null)
            {
                for (int i = 0; i < script.Operations.Count; i++)
                {
                    var op = script.Operations[i];
                    var node = ConformanceAdapter.Navigate(outcome.Tree, op.Navigate);
                    if (node is null)
                    {
                        failures.Add(
                            $"operation {i}: navigate [{string.Join(", ", op.Navigate)}] did not resolve");
                        continue;
                    }

                    NormalizedResult actual;
                    var args = op.Args
                        ?? (IReadOnlyDictionary<string, object?>)
                            new Dictionary<string, object?>(StringComparer.Ordinal);
                    try
                    {
                        actual = ConformanceAdapter.Invoke(node, op.Invoke, args);
                    }
                    catch (UnknownCapabilityException)
                    {
                        failures.Add($"operation {i}: unbound capability '{op.Invoke}'");
                        continue;
                    }
                    catch (Exception ex)
                    {
                        failures.Add($"operation {i}: invoke threw: {ex.Message}");
                        continue;
                    }

                    var expect = NormalizedResult.FromJson(op.Expect);
                    if (!ResultsEqual.Equal(actual, expect))
                    {
                        failures.Add(
                            $"operation {i}: expected {op.Expect.GetRawText()}, " +
                            $"got {actual.Node.ToJsonString()}");
                    }
                }
            }
        }

        // ── no expectation files at all — configuration error ─────────────────
        if (!fix.HasExpected &&
            !fix.HasExpectedEffective &&
            !fix.HasExpectedErrors &&
            !fix.HasExpectedWarnings &&
            !fix.HasScript &&
            failures.Count == 0)
        {
            failures.Add("fixture declares no expectation files");
        }

        detail = string.Join("; ", failures);
        return failures.Count == 0;
    }
}
