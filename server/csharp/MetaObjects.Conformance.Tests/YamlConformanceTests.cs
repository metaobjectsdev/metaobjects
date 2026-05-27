// YamlConformanceTests — parametric YAML conformance runner over fixtures/yaml-conformance/.
//
// C# port of:
//   server/typescript/packages/metadata/test/yaml-conformance.test.ts        (reference)
//   server/python/tests/conformance/test_yaml_conformance.py                  (sibling)
//   server/java/metadata/src/test/java/com/metaobjects/conformance/YamlConformanceTest.java
//
// Per ADR-0006 D4. Each fixture under fixtures/yaml-conformance/ contains:
//   - input.yaml           (required)
//   - expected.json        (happy path — canonical serialization must match)
//   OR
//   - expected-errors.json (error path — emitted ERR_* code set must match)
//
// Adding a directory under fixtures/yaml-conformance/ auto-creates a parametric test.
// The corpus is shared across every port; C# is one of four (TS, Python, Java, C#).
//
// Per-language ledger lives at yaml-conformance-expected-failures.json next to this file.
// C# gates the v2-vocabulary-dependent coercion fixtures as known-gap (C# v1 metadata
// vocabulary doesn't declare @column on field.string, so the YAML coercion guard has
// no schema to compare against). Other fixtures (including the v2 happy-paths) pass
// because the canonical parser accepts unknown attrs (open policy) and re-emits them.

using System.Text.Json;
using MetaObjects.Loader;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// A discovered YAML conformance fixture.
/// </summary>
public sealed record YamlFixture(
    string Name,
    string Dir,
    bool HasExpected,
    bool HasExpectedErrors)
{
    public override string ToString() => Name;
}

public class YamlConformanceTests
{
    // -------------------------------------------------------------------------
    // Corpus discovery
    // -------------------------------------------------------------------------

    /// <summary>
    /// Absolute path to <c>fixtures/yaml-conformance/</c>. Honors the
    /// <c>METAOBJECTS_YAML_CONFORMANCE_CORPUS</c> env var; otherwise walks up
    /// from the test binary's base directory.
    /// </summary>
    public static string CorpusPath { get; } = LocateYamlCorpus();

    private static string LocateYamlCorpus()
    {
        var env = Environment.GetEnvironmentVariable("METAOBJECTS_YAML_CONFORMANCE_CORPUS");
        if (!string.IsNullOrEmpty(env))
        {
            if (!Directory.Exists(env))
                throw new DirectoryNotFoundException(
                    $"METAOBJECTS_YAML_CONFORMANCE_CORPUS points to a non-existent directory: {env}");
            return env;
        }

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = System.IO.Path.Combine(dir.FullName, "fixtures", "yaml-conformance");
            if (Directory.Exists(candidate))
                return candidate;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate fixtures/yaml-conformance/ by walking up from " +
            AppContext.BaseDirectory +
            ". Set METAOBJECTS_YAML_CONFORMANCE_CORPUS to point directly to the corpus.");
    }

    /// <summary>xUnit MemberData source — one entry per discovered fixture.</summary>
    public static IEnumerable<object[]> Fixtures() => DiscoverFixtures(CorpusPath)
        .Select(f => new object[] { f });

    /// <summary>
    /// Discover every YAML fixture directory under <paramref name="corpusRoot"/>,
    /// sorted by name. Each must have <c>input.yaml</c> and exactly one of
    /// <c>expected.json</c> / <c>expected-errors.json</c>.
    /// </summary>
    public static IReadOnlyList<YamlFixture> DiscoverFixtures(string corpusRoot)
    {
        var entries = Directory.GetDirectories(corpusRoot)
            .Select(d => System.IO.Path.GetFileName(d))
            .Order(StringComparer.Ordinal)
            .ToList();

        var fixtures = new List<YamlFixture>(entries.Count);
        foreach (var name in entries)
        {
            var dir = System.IO.Path.Combine(corpusRoot, name);
            bool hasExpected = File.Exists(System.IO.Path.Combine(dir, "expected.json"));
            bool hasErrors = File.Exists(System.IO.Path.Combine(dir, "expected-errors.json"));
            if (hasExpected && hasErrors)
                throw new InvalidOperationException(
                    $"Fixture '{name}' has both expected.json and expected-errors.json — one only.");
            if (!hasExpected && !hasErrors)
                throw new InvalidOperationException(
                    $"Fixture '{name}' has neither expected.json nor expected-errors.json.");
            if (!File.Exists(System.IO.Path.Combine(dir, "input.yaml")))
                throw new InvalidOperationException(
                    $"Fixture '{name}' is missing input.yaml.");

            fixtures.Add(new YamlFixture(name, dir, hasExpected, hasErrors));
        }
        return fixtures;
    }

    // -------------------------------------------------------------------------
    // Per-language YAML ledger
    // -------------------------------------------------------------------------

    private static readonly IReadOnlyList<string> Ledger = LoadLedger();

    private static IReadOnlyList<string> LoadLedger()
    {
        var ledgerPath = System.IO.Path.Combine(
            AppContext.BaseDirectory, "yaml-conformance-expected-failures.json");

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

    private static string Classify(bool passed, string name)
    {
        bool listed = Ledger.Contains(name, StringComparer.Ordinal);
        if (!passed) return listed ? "known-gap" : "fail";
        return listed ? "fixed-but-listed" : "pass";
    }

    // -------------------------------------------------------------------------
    // The test
    // -------------------------------------------------------------------------

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void Conformance(YamlFixture fix)
    {
        var failures = new List<string>();
        RunChecks(fix, failures);
        bool passed = failures.Count == 0;

        string status = Classify(passed, fix.Name);
        string detail = passed ? "(no failures)" : string.Join("; ", failures);

        Assert.True(
            status is "pass" or "known-gap",
            $"{fix.Name} [{status}]: {detail}");
    }

    // -------------------------------------------------------------------------
    // Per-fixture pipeline
    // -------------------------------------------------------------------------

    private static void RunChecks(YamlFixture fix, List<string> failures)
    {
        string yaml;
        try
        {
            yaml = File.ReadAllText(System.IO.Path.Combine(fix.Dir, "input.yaml"));
        }
        catch (Exception ex)
        {
            failures.Add($"input.yaml read error: {ex.Message}");
            return;
        }

        // Compose a registry mirroring the canonical conformance harness — every
        // YAML fixture uses the standard core-types registry.
        var registry = Provider.ComposeRegistry([CoreTypes.CoreTypesProvider]);
        var parseOpts = new ParseOptions(registry)
        {
            SourceName = "input.yaml",
        };

        var codesSeen = new HashSet<string>(StringComparer.Ordinal);
        var orderedCodes = new List<string>();
        var orderedEnvelopes = new List<ErrorEnvelopeRecord>();
        void AddCode(string c)
        {
            if (codesSeen.Add(c)) orderedCodes.Add(c);
        }
        void AddEnvelope(MetaError err)
        {
            if (codesSeen.Add(err.Code.ToString()))
            {
                orderedCodes.Add(err.Code.ToString());
                orderedEnvelopes.Add(BuildYamlEnvelope(err));
            }
        }

        // 1. Desugar — collect every desugar diagnostic (multi-error path).
        YamlParseCollectingResult? desugared = null;
        try
        {
            desugared = ParserYaml.ParseYamlCollecting(yaml, parseOpts);
        }
        catch (ParseException ex)
        {
            AddCode(ex.Code.ToString());
            orderedEnvelopes.Add(BuildYamlEnvelopeFromException(ex));
        }

        if (desugared is not null)
        {
            foreach (var err in desugared.Errors)
            {
                // YAML desugar errors don't carry an envelope yet — synthesize a
                // root-level YAML envelope so cross-port assertions still apply.
                var code = (err.Code ?? ErrorCode.ERR_MALFORMED_YAML).ToString();
                if (codesSeen.Add(code))
                {
                    orderedCodes.Add(code);
                    orderedEnvelopes.Add(new ErrorEnvelopeRecord(code, "yaml", new[] { "input.yaml" }, "$"));
                }
            }

            // 2. Hand the canonical (regardless of desugar errors) to Parser.ParseJson
            //    and then run the loader's post-parse validation passes. This mirrors
            //    the Java runner: desugar errors do NOT short-circuit the build-tree
            //    pipeline, so the harness can union YAML-side codes with downstream
            //    canonical-parse + validation codes (e.g. ERR_BAD_ATTR_VALUE on a
            //    coerced enum value where the bad element survived stringification).
            string canonicalJson = desugared.Canonical.ToJsonString();
            try
            {
                var result = Parser.ParseJson(canonicalJson, parseOpts);
                foreach (var e in result.Errors) AddEnvelope(e);

                // 3. Run the post-load validation passes against the parsed tree —
                //    mirrors what MetaDataLoader.Load() does after each source.
                //    We call them directly because Load() would short-circuit on
                //    ParseException from a coercion-flagged desugar.
                MetaData root = result.Root;
                foreach (var e in ValidationPasses.ValidateSubtypeRules(root).Errors) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateDataGridSortFields(root)) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateOriginPaths(root)) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateAttrSchema(root, registry).Errors) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateDataGridFilterValues(root)) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateFieldObjectStorage(root)) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateTemplatePayloadRefs(root)) AddEnvelope(e);
                foreach (var e in ValidationPasses.ValidateEnumValues(root)) AddEnvelope(e);
            }
            catch (ParseException ex)
            {
                AddCode(ex.Code.ToString());
                orderedEnvelopes.Add(BuildYamlEnvelopeFromException(ex));
            }
        }

        // -- expected-errors check ------------------------------------------
        if (fix.HasExpectedErrors)
        {
            OperationScriptParser.ExpectedErrorsEnvelope? envelope = null;
            try
            {
                var raw = File.ReadAllText(System.IO.Path.Combine(fix.Dir, "expected-errors.json"));
                var parsed = JsonSerializer.Deserialize<JsonElement>(raw);
                envelope = OperationScriptParser.ParseExpectedErrorsEnvelope(parsed);
            }
            catch (Exception ex)
            {
                failures.Add($"expected-errors.json parse error: {ex.Message}");
            }

            if (envelope is not null)
            {
                // Code-set check (order-independent) — legacy semantics.
                var wantCodes = envelope.Errors.Select(e => e.Code).Order(StringComparer.Ordinal).ToList();
                var gotCodes = orderedCodes.Order(StringComparer.Ordinal).ToList();
                if (!wantCodes.SequenceEqual(gotCodes, StringComparer.Ordinal))
                    failures.Add(
                        $"expected codes [{string.Join(", ", wantCodes)}], " +
                        $"got [{string.Join(", ", gotCodes)}]");

                // FR5a — per-error envelope assertion (in declaration order).
                if (!envelope.Legacy)
                {
                    if (envelope.Errors.Count != orderedEnvelopes.Count)
                    {
                        failures.Add(
                            $"envelope length mismatch: expected {envelope.Errors.Count}, " +
                            $"got {orderedEnvelopes.Count}");
                    }
                    else
                    {
                        for (int i = 0; i < envelope.Errors.Count; i++)
                        {
                            var w = envelope.Errors[i];
                            var g = orderedEnvelopes[i];
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
                        }
                    }
                }
            }
            return;
        }

        // -- happy-path canonical serialization check ----------------------
        if (orderedCodes.Count > 0)
        {
            failures.Add(
                $"load produced errors [{string.Join(", ", orderedCodes)}]" +
                " — cannot compare canonical output");
            return;
        }
        if (!fix.HasExpected)
        {
            failures.Add("fixture declares no expectation files");
            return;
        }

        string want2;
        try
        {
            want2 = File.ReadAllText(System.IO.Path.Combine(fix.Dir, "expected.json")).Trim();
        }
        catch (Exception ex)
        {
            failures.Add($"expected.json read error: {ex.Message}");
            return;
        }

        // Load to a tree and canonical-serialize. Use a fresh loader so the
        // post-passes apply (single-source load of the YAML input).
        var loader2 = new MetaDataLoader(registry);
        var loadResult2 = loader2.Load(new[] {
            (IMetaDataSource)new InMemoryStringSource(yaml, "input.yaml", MetaDataFormat.Yaml)
        });
        if (loadResult2.Errors.Count > 0)
        {
            failures.Add(
                $"loader produced errors [{string.Join(", ", loadResult2.Errors.Select(e => e.Code))}]" +
                " — cannot compare canonical output");
            return;
        }

        string got = SerializerJson.CanonicalSerialize(loadResult2.Root).Trim();
        if (want2 != got)
        {
            failures.Add(
                $"canonical serialization mismatch:\n--- expected ---\n{want2}\n--- got ---\n{got}");
        }
    }

    /// <summary>
    /// Build a cross-port envelope record from a YAML-runner MetaError. The
    /// YAML fixtures' file token is always "input.yaml" (the authoring file
    /// the consumer sees), not the per-port internal source id.
    /// </summary>
    private static ErrorEnvelopeRecord BuildYamlEnvelope(MetaError err) =>
        BuildYamlEnvelope(err.Code.ToString(), err.Envelope);

    private static ErrorEnvelopeRecord BuildYamlEnvelopeFromException(ParseException ex) =>
        BuildYamlEnvelope(ex.Code.ToString(), ex.Envelope);

    private static ErrorEnvelopeRecord BuildYamlEnvelope(string code, ErrorSource? envelope) =>
        envelope switch
        {
            JsonSource js     => new ErrorEnvelopeRecord(code, "json",     new[] { "input.yaml" }, js.JsonPath),
            YamlSource ys     => new ErrorEnvelopeRecord(code, "yaml",     new[] { "input.yaml" }, ys.JsonPath),
            MergedSource ms   => new ErrorEnvelopeRecord(code, "merged",   ms.Files, ms.JsonPath),
            ResolvedSource rs => new ErrorEnvelopeRecord(code, "resolved", rs.Files, rs.JsonPath),
            CodeSource        => new ErrorEnvelopeRecord(code, "code",     Array.Empty<string>(), null),
            _                 => new ErrorEnvelopeRecord(code, "yaml",     new[] { "input.yaml" }, "$"),
        };
}
