using System.Text.Json;
using MetaObjects.Render.Extract;
using Xunit;
using ExtractEngine = MetaObjects.Render.Extract.ExtractEngine;

namespace MetaObjects.Render.Tests.Extract;

/// <summary>
/// Cross-language extract-conformance corpus runner — FR-010 + FR-011 correctness gate.
/// Each fixture dir under fixtures/extract-conformance/ holds:
///   schema.json   { "format": "JSON"|"XML", "rootName": "...", "fields": [...] }
///   input.txt     the raw (possibly dirty) LLM output
///   expected.json { "empty": bool, "states": { field: FieldExtraction }, "data": { field: value } }
///
/// All corpus cases must pass. The corpus is the oracle — do not weaken assertions.
/// Mirrors the cross-port extract-conformance runner exactly.
/// </summary>
public class ExtractConformanceTests
{
    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "extract-conformance")))
        {
            string? parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/extract-conformance not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "extract-conformance");
    }

    public static IEnumerable<object[]> Cases()
    {
        string corpus = CorpusRoot();
        foreach (string dir in Directory.GetDirectories(corpus).OrderBy(d => d, StringComparer.Ordinal))
        {
            // Skip README or any non-fixture entry (must have schema.json)
            if (!File.Exists(Path.Combine(dir, "schema.json"))) continue;
            yield return new object[] { Path.GetFileName(dir) };
        }
    }

    [Fact]
    public void Discovers_all_extract_conformance_cases()
    {
        // FR-011: lock the corpus size so a deleted fixture fails CI rather than
        // silently reducing coverage. Mirrors the TS / Java / Python count guards.
        Assert.Equal(30, Cases().Count());
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void ClassificationAndCanonicalValueMatch(string caseName)
    {
        string caseDir = Path.Combine(CorpusRoot(), caseName);

        // Parse schema.json → ExtractSchema
        using JsonDocument schemaDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "schema.json")));
        ExtractSchema schema = ParseSchema(schemaDoc.RootElement);

        // Read input
        string input = File.ReadAllText(Path.Combine(caseDir, "input.txt"));

        // Parse expected.json
        using JsonDocument expectedDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "expected.json")));
        JsonElement expected = expectedDoc.RootElement;

        // Optional per-fixture parse option: "rootless": true → the XML response has no wrapper
        // root element; parse its top-level elements directly. Mirrors the Java / Python runners.
        ExtractOptions opts = ExtractOptions.Defaults();
        if (schemaDoc.RootElement.TryGetProperty("rootless", out JsonElement rootlessEl)
            && rootlessEl.ValueKind == JsonValueKind.True)
        {
            opts = opts.WithRootless(true);
        }

        // Run the engine
        ExtractionOutcome outcome = ExtractEngine.Run(input, schema, opts);

        // Assert: empty flag
        bool expectedEmpty = expected.GetProperty("empty").GetBoolean();
        Assert.Equal(expectedEmpty, outcome.Report.IsEmpty);

        // Assert: per-field states (value check)
        JsonElement expectedStates = expected.GetProperty("states");
        foreach (JsonProperty stateProp in expectedStates.EnumerateObject())
        {
            string path = stateProp.Name;
            string expectedState = stateProp.Value.GetString()!;
            IReadOnlyDictionary<string, FieldExtraction> actualStates = outcome.Report.States();
            Assert.True(actualStates.ContainsKey(path),
                $"{caseName}: state key '{path}' missing from actual states");
            Assert.Equal(expectedState, actualStates[path].ToString());
        }

        // Assert: states key-set exhaustive (no extra keys in actual)
        {
            var expectedKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty p in expectedStates.EnumerateObject()) expectedKeys.Add(p.Name);
            var actualKeys = new HashSet<string>(outcome.Report.States().Keys, StringComparer.Ordinal);
            Assert.Equal(expectedKeys, actualKeys);
        }

        // Assert: data as a flat DOTTED-LEAF map (mirroring states). Nested objects and arrays
        // are flattened to leaf paths (meta.score, items[0].label, tags[0], …) and every leaf
        // VALUE is asserted — including scalar-array elements and nested-object leaves.
        var actualLeaves = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, object?> kv in outcome.Data)
            FlattenLeaves(kv.Key, kv.Value, actualLeaves);

        JsonElement expectedData = expected.GetProperty("data");
        foreach (JsonProperty dataProp in expectedData.EnumerateObject())
        {
            string path = dataProp.Name;
            Assert.True(actualLeaves.ContainsKey(path),
                $"{caseName}: data leaf '{path}' missing from actual data");
            AssertCanonical(caseName, path, dataProp.Value, actualLeaves[path]);
        }

        // Assert: data leaf-set exhaustive (no extra leaves in actual)
        {
            var expectedKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty p in expectedData.EnumerateObject()) expectedKeys.Add(p.Name);
            var actualKeys = new HashSet<string>(actualLeaves.Keys, StringComparer.Ordinal);
            Assert.Equal(expectedKeys, actualKeys);
        }
    }

    /// <summary>
    /// Flatten an assembled-data value into dotted leaf paths: dictionaries recurse by key
    /// (prefix.key), lists recurse by index (prefix[i]), and every terminal scalar is recorded.
    /// Mirrors the engine's per-field state enumeration so data leaves line up with state leaves.
    /// </summary>
    private static void FlattenLeaves(string prefix, object? value, IDictionary<string, object?> outMap)
    {
        switch (value)
        {
            case IDictionary<string, object?> map:
                foreach (KeyValuePair<string, object?> e in map)
                {
                    string key = prefix.Length == 0 ? e.Key : $"{prefix}.{e.Key}";
                    FlattenLeaves(key, e.Value, outMap);
                }
                break;

            case System.Collections.IEnumerable seq when value is not string:
                int i = 0;
                foreach (object? item in seq)
                    FlattenLeaves($"{prefix}[{i++}]", item, outMap);
                break;

            default:
                outMap[prefix] = value;
                break;
        }
    }

    /// <summary>Canonical leaf comparison: numbers within 1e-9 tolerance; booleans by canonical
    /// lowercase token; else string-equal.</summary>
    private static void AssertCanonical(string caseName, string path, JsonElement expected, object? actual)
    {
        if (expected.ValueKind == JsonValueKind.Number)
        {
            double expectedNum = expected.GetDouble();
            double actualNum = Convert.ToDouble(actual);
            Assert.True(
                Math.Abs(expectedNum - actualNum) <= 1e-9,
                $"{caseName} data[{path}]: expected {expectedNum} but got {actualNum}");
        }
        else if (expected.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            // The engine coerces a BOOLEAN field to a native bool; compare on the canonical
            // lowercase token so "true"/"false" line up regardless of the actual's runtime type.
            string expectedBool = expected.GetBoolean() ? "true" : "false";
            string actualBool = Convert.ToString(actual)?.ToLowerInvariant() ?? "";
            Assert.Equal(expectedBool, actualBool);
        }
        else
        {
            string expectedStr = expected.GetString() ?? expected.ToString();
            Assert.Equal(expectedStr, Convert.ToString(actual));
        }
    }

    // ─── Schema parser (test-only) ──────────────────────────────────────────

    private static ExtractSchema ParseSchema(JsonElement n)
    {
        Format format = ParseFormat(n.GetProperty("format").GetString()!);
        string rootName = n.GetProperty("rootName").GetString()!;
        var fields = new List<FieldSpec>();
        foreach (JsonElement f in n.GetProperty("fields").EnumerateArray())
            fields.Add(ParseField(f));
        return new ExtractSchema(format, rootName, fields);
    }

    private static Format ParseFormat(string s) => s switch
    {
        "JSON" => Format.Json,
        "XML"  => Format.Xml,
        _      => throw new ArgumentException($"Unknown format: {s}"),
    };

    private static FieldKind ParseFieldKind(string s) => s switch
    {
        "STRING"  => FieldKind.String,
        "INT"     => FieldKind.Int,
        "LONG"    => FieldKind.Long,
        "DOUBLE"  => FieldKind.Double,
        "BOOLEAN" => FieldKind.Boolean,
        "ENUM"    => FieldKind.Enum,
        "OBJECT"  => FieldKind.Object,
        _         => throw new ArgumentException($"Unknown field kind: {s}"),
    };

    private static FieldSpec ParseField(JsonElement f)
    {
        string name = f.GetProperty("name").GetString()!;
        FieldKind kind = ParseFieldKind(f.GetProperty("kind").GetString()!);
        bool required = f.TryGetProperty("required", out JsonElement reqProp) && reqProp.GetBoolean();

        if (kind == FieldKind.Enum)
        {
            var values = new List<string>();
            if (f.TryGetProperty("enumValues", out JsonElement ev))
                foreach (JsonElement v in ev.EnumerateArray())
                    values.Add(v.GetString()!);

            var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
            if (f.TryGetProperty("enumAlias", out JsonElement ea))
                foreach (JsonProperty e in ea.EnumerateObject())
                    aliases[e.Name] = e.Value.GetString()!;

            // FR-011: optional coerceDefault / normalize / default keys.
            string? coerceDefault = f.TryGetProperty("coerceDefault", out JsonElement cd) ? cd.GetString() : null;
            NormalizeMode normalize = ParseNormalize(
                f.TryGetProperty("normalize", out JsonElement nm) ? nm.GetString() : null);
            string? defaultValue = f.TryGetProperty("default", out JsonElement dv) ? dv.GetString() : null;

            // Phase B (array-of-enum): kind:"ENUM" + array:true → List<enum>, each element
            // coerced through the enum pipeline and classified by indexed path.
            bool enumArray = f.TryGetProperty("array", out JsonElement arr) && arr.GetBoolean();
            return enumArray
                ? FieldSpec.EnumArray(name, required, values, aliases, coerceDefault, normalize, defaultValue)
                : FieldSpec.EnumField(name, required, values, aliases, coerceDefault, normalize, defaultValue);
        }

        if (kind == FieldKind.Object)
        {
            bool array = f.TryGetProperty("array", out JsonElement arrEl) && arrEl.GetBoolean();
            ExtractSchema? nested = null;
            if (f.TryGetProperty("fields", out JsonElement nestedFields))
            {
                var childSpecs = new List<FieldSpec>();
                foreach (JsonElement nf in nestedFields.EnumerateArray())
                    childSpecs.Add(ParseField(nf));
                nested = new ExtractSchema(Format.Json, name, childSpecs);
            }
            return FieldSpec.Object(name, required, array, nested!);
        }

        if (f.TryGetProperty("min", out JsonElement minEl) || f.TryGetProperty("max", out JsonElement maxEl))
        {
            double? min = f.TryGetProperty("min", out JsonElement minEl2) ? minEl2.GetDouble() : (double?)null;
            double? max = f.TryGetProperty("max", out JsonElement maxEl2) ? maxEl2.GetDouble() : (double?)null;
            return FieldSpec.Range(name, kind, required, min, max);
        }

        // @xmlText: a scalar field that receives its element's text content (the #text sentinel).
        if (f.TryGetProperty("textContent", out JsonElement tc) && tc.GetBoolean())
        {
            return FieldSpec.TextContentField(name, kind, required);
        }

        // Phase B: a scalar field may carry a generalized @default absent-fill string.
        string? scalarDefault = f.TryGetProperty("default", out JsonElement sd) ? sd.GetString() : null;
        return FieldSpec.Scalar(name, kind, required, scalarDefault);
    }

    /// <summary>FR-011: parse the @normalize mode string; absent → the global default "strip".</summary>
    private static NormalizeMode ParseNormalize(string? s) => s switch
    {
        null       => NormalizeMode.Strip,
        "none"     => NormalizeMode.None,
        "collapse" => NormalizeMode.Collapse,
        "strip"    => NormalizeMode.Strip,
        _          => throw new ArgumentException($"Unknown normalize mode: {s}"),
    };
}
