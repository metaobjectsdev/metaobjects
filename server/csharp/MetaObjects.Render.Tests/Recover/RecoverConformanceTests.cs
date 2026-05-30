using System.Text.Json;
using MetaObjects.Render.Recover;
using Xunit;
using RecoverEngine = MetaObjects.Render.Recover.Recover;

namespace MetaObjects.Render.Tests.Recover;

/// <summary>
/// Cross-language recover-conformance corpus runner — FR-010 correctness gate.
/// Each fixture dir under fixtures/recover-conformance/ holds:
///   schema.json   { "format": "JSON"|"XML", "rootName": "...", "fields": [...] }
///   input.txt     the raw (possibly dirty) LLM output
///   expected.json { "empty": bool, "states": { field: FieldRecovery }, "data": { field: value } }
///
/// All 10 cases must pass. The corpus is the oracle — do not weaken assertions.
/// Mirrors RecoverConformanceTest.java exactly.
/// </summary>
public class RecoverConformanceTests
{
    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "recover-conformance")))
        {
            string? parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/recover-conformance not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "recover-conformance");
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

    [Theory]
    [MemberData(nameof(Cases))]
    public void ClassificationAndCanonicalValueMatch(string caseName)
    {
        string caseDir = Path.Combine(CorpusRoot(), caseName);

        // Parse schema.json → RecoverSchema
        using JsonDocument schemaDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "schema.json")));
        RecoverSchema schema = ParseSchema(schemaDoc.RootElement);

        // Read input
        string input = File.ReadAllText(Path.Combine(caseDir, "input.txt"));

        // Parse expected.json
        using JsonDocument expectedDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(caseDir, "expected.json")));
        JsonElement expected = expectedDoc.RootElement;

        // Run the engine
        RecoverOutcome outcome = RecoverEngine.Run(input, schema);

        // Assert: empty flag
        bool expectedEmpty = expected.GetProperty("empty").GetBoolean();
        Assert.Equal(expectedEmpty, outcome.Report.IsEmpty);

        // Assert: per-field states (value check)
        JsonElement expectedStates = expected.GetProperty("states");
        foreach (JsonProperty stateProp in expectedStates.EnumerateObject())
        {
            string path = stateProp.Name;
            string expectedState = stateProp.Value.GetString()!;
            IReadOnlyDictionary<string, FieldRecovery> actualStates = outcome.Report.States();
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

        // Assert: per-field data (canonical value check)
        JsonElement expectedData = expected.GetProperty("data");
        foreach (JsonProperty dataProp in expectedData.EnumerateObject())
        {
            string field = dataProp.Name;
            Assert.True(outcome.Data.ContainsKey(field),
                $"{caseName}: data key '{field}' missing from actual data");
            AssertCanonical(caseName, field, dataProp.Value, outcome.Data[field]);
        }

        // Assert: data key-set exhaustive (no extra keys in actual)
        {
            var expectedKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty p in expectedData.EnumerateObject()) expectedKeys.Add(p.Name);
            var actualKeys = new HashSet<string>(outcome.Data.Keys, StringComparer.Ordinal);
            Assert.Equal(expectedKeys, actualKeys);
        }
    }

    /// <summary>
    /// Canonical comparison: numbers within 1e-9 tolerance; everything else string-equal.
    /// Mirrors RecoverConformanceTest.java assertCanonical.
    /// </summary>
    private static void AssertCanonical(string caseName, string field, JsonElement expected, object? actual)
    {
        if (expected.ValueKind == JsonValueKind.Number)
        {
            double expectedNum = expected.GetDouble();
            double actualNum = Convert.ToDouble(actual);
            Assert.True(
                Math.Abs(expectedNum - actualNum) <= 1e-9,
                $"{caseName} data[{field}]: expected {expectedNum} but got {actualNum}");
        }
        else
        {
            string expectedStr = expected.GetString() ?? expected.ToString();
            Assert.Equal(expectedStr, Convert.ToString(actual));
        }
    }

    // ─── Schema parser (test-only) ──────────────────────────────────────────

    private static RecoverSchema ParseSchema(JsonElement n)
    {
        Format format = ParseFormat(n.GetProperty("format").GetString()!);
        string rootName = n.GetProperty("rootName").GetString()!;
        var fields = new List<FieldSpec>();
        foreach (JsonElement f in n.GetProperty("fields").EnumerateArray())
            fields.Add(ParseField(f));
        return new RecoverSchema(format, rootName, fields);
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

            return FieldSpec.EnumField(name, required, values, aliases);
        }

        if (f.TryGetProperty("min", out JsonElement minEl) || f.TryGetProperty("max", out JsonElement maxEl))
        {
            double? min = f.TryGetProperty("min", out JsonElement minEl2) ? minEl2.GetDouble() : (double?)null;
            double? max = f.TryGetProperty("max", out JsonElement maxEl2) ? maxEl2.GetDouble() : (double?)null;
            return FieldSpec.Range(name, kind, required, min, max);
        }

        return FieldSpec.Scalar(name, kind, required);
    }
}
