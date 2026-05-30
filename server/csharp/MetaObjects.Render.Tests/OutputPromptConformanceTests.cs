using System.Text.Json;
using MetaObjects.Render.Prompt;
using MetaObjects.Render.Recover;
using Xunit;
using RecoverEngine = MetaObjects.Render.Recover.Recover;

namespace MetaObjects.Render.Tests;

/// <summary>
/// Cross-language output-prompt-conformance corpus runner — FR-010 artifact-1 (output-format
/// prompt fragment) byte-identity gate. Each fixture dir under fixtures/output-prompt-conformance/ holds:
///   spec.json                 descriptor: { format, rootName, roundTrip?, fields:[{ name, kind, required,
///                             array?, example?, instruction?, enumValues?, enumDoc?, nested? }] }
///   expected.guide.txt        byte-exact reference render for the GUIDE style
///   expected.inline.txt       byte-exact reference render for the INLINE style
///   expected.exampleOnly.txt  byte-exact reference render for the EXAMPLE_ONLY style
///
/// The corpus (authored by the TS pilot) is the oracle — do NOT edit it. Each style render must be
/// byte-equal to its expected file; roundTrip cases additionally feed the exampleOnly fragment back
/// through the recover engine and assert no field is MALFORMED / LOST_*. Mirrors the TS runner
/// (server/typescript/packages/render/test/output-prompt-conformance.test.ts) exactly.
/// </summary>
public class OutputPromptConformanceTests
{
    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "output-prompt-conformance")))
        {
            string? parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/output-prompt-conformance not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "output-prompt-conformance");
    }

    public static IEnumerable<object[]> Cases()
    {
        string corpus = CorpusRoot();
        foreach (string dir in Directory.GetDirectories(corpus).OrderBy(d => d, StringComparer.Ordinal))
        {
            if (!File.Exists(Path.Combine(dir, "spec.json"))) continue;
            yield return new object[] { Path.GetFileName(dir) };
        }
    }

    [Fact]
    public void Discovers_all_output_prompt_conformance_cases()
    {
        // Count guard: a port silently skipping cases must fail CI rather than reduce coverage.
        // Mirrors the TS / Java / Python count guards.
        Assert.Equal(10, Cases().Count());
    }

    private static readonly (string Key, PromptStyle Style)[] Styles =
    {
        ("guide", PromptStyle.Guide),
        ("inline", PromptStyle.Inline),
        ("exampleOnly", PromptStyle.ExampleOnly),
    };

    [Theory]
    [MemberData(nameof(Cases))]
    public void ReproducesCorpusBytes(string caseName)
    {
        string dir = Path.Combine(CorpusRoot(), caseName);

        using JsonDocument specDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "spec.json")));
        CaseSpec spec = ParseCaseSpec(specDoc.RootElement);
        OutputFormatSpec ofs = BuildOutputSpec(spec);

        foreach (var (key, style) in Styles)
        {
            var overrides = new PromptOverrides(style, null, null);
            string actual = OutputFormatRenderer.Render(ofs, overrides);

            // Read expected file as raw UTF-8 (no newline translation). The TS-authored files use
            // "\n" line endings; File.ReadAllText preserves bytes; Assert.Equal on strings is ordinal.
            string expected = File.ReadAllText(Path.Combine(dir, $"expected.{key}.txt"));
            Assert.Equal(expected, actual); // zero-drift, byte-exact

            // determinism: identical across runs
            Assert.Equal(actual, OutputFormatRenderer.Render(ofs, overrides));
        }

        if (spec.RoundTrip)
        {
            string exampleFragment = File.ReadAllText(Path.Combine(dir, "expected.exampleOnly.txt"));
            RecoverOutcome outcome = RecoverEngine.Run(exampleFragment, BuildRecoverSchema(spec));

            // Skew guard: a field the renderer emitted must read back cleanly. Assert NO state is
            // MALFORMED or LOST_* (robust to DEFAULTED and to how a nested OBJECT-container path
            // classifies). Any such state means the renderer emitted an example recover cannot read.
            foreach (var (field, state) in outcome.Report.States())
            {
                bool bad = state is FieldRecovery.MALFORMED
                    or FieldRecovery.LOST_REQUIRED
                    or FieldRecovery.LOST_OPTIONAL;
                Assert.False(bad, $"{caseName}: field '{field}' read back as {state}");
            }
        }
    }

    // ─── BuildOutputSpec / BuildRecoverSchema (mirror the TS runner) ──────────

    private static OutputFormatSpec BuildOutputSpec(CaseSpec c)
    {
        var fields = c.Fields.Select(f => new PromptField(
            Name: f.Name,
            Kind: f.Kind,
            Required: f.Required,
            Array: f.Array,
            EnumValues: f.EnumValues,
            EnumDoc: f.EnumDoc,
            Example: f.Example,
            Instruction: f.Instruction,
            Nested: f.Nested is null ? null : BuildOutputSpec(f.Nested))).ToList();
        // Style is a placeholder; each render overrides it per style (matches TS).
        return new OutputFormatSpec(c.Format, c.RootName, PromptStyle.Guide, fields);
    }

    private static RecoverSchema BuildRecoverSchema(CaseSpec c)
    {
        var fields = c.Fields.Select(f => f.Kind switch
        {
            FieldKind.Enum => FieldSpec.EnumField(f.Name, f.Required, f.EnumValues, null),
            FieldKind.Object => FieldSpec.Object(
                f.Name, f.Required, f.Array,
                f.Nested is null ? null! : BuildRecoverSchema(f.Nested)),
            _ => FieldSpec.Scalar(f.Name, f.Kind, f.Required),
        }).ToList();
        return new RecoverSchema(c.Format, c.RootName, fields);
    }

    // ─── descriptor parsing (the spec.json shape) ────────────────────────────

    private sealed record CaseSpec(
        Format Format,
        string RootName,
        bool RoundTrip,
        IReadOnlyList<CaseField> Fields);

    private sealed record CaseField(
        string Name,
        FieldKind Kind,
        bool Required,
        bool Array,
        IReadOnlyList<string>? EnumValues,
        IReadOnlyDictionary<string, string>? EnumDoc,
        string? Example,
        string? Instruction,
        CaseSpec? Nested);

    private static CaseSpec ParseCaseSpec(JsonElement n)
    {
        Format format = ParseFormat(n.GetProperty("format").GetString()!);
        string rootName = n.GetProperty("rootName").GetString()!;
        bool roundTrip = n.TryGetProperty("roundTrip", out JsonElement rt) && rt.GetBoolean();
        var fields = new List<CaseField>();
        foreach (JsonElement f in n.GetProperty("fields").EnumerateArray())
            fields.Add(ParseCaseField(f));
        return new CaseSpec(format, rootName, roundTrip, fields);
    }

    private static CaseField ParseCaseField(JsonElement f)
    {
        string name = f.GetProperty("name").GetString()!;
        FieldKind kind = ParseFieldKind(f.GetProperty("kind").GetString()!);
        bool required = f.TryGetProperty("required", out JsonElement reqEl) && reqEl.GetBoolean();
        bool array = f.TryGetProperty("array", out JsonElement arrEl) && arrEl.GetBoolean();

        IReadOnlyList<string>? enumValues = null;
        if (f.TryGetProperty("enumValues", out JsonElement ev) && ev.ValueKind == JsonValueKind.Array)
            enumValues = ev.EnumerateArray().Select(x => x.GetString()!).ToList();

        IReadOnlyDictionary<string, string>? enumDoc = null;
        if (f.TryGetProperty("enumDoc", out JsonElement ed) && ed.ValueKind == JsonValueKind.Object)
        {
            var map = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (JsonProperty p in ed.EnumerateObject()) map[p.Name] = p.Value.GetString()!;
            enumDoc = map;
        }

        string? example = f.TryGetProperty("example", out JsonElement exEl) && exEl.ValueKind != JsonValueKind.Null
            ? exEl.GetString()
            : null;
        string? instruction = f.TryGetProperty("instruction", out JsonElement inEl) && inEl.ValueKind != JsonValueKind.Null
            ? inEl.GetString()
            : null;

        CaseSpec? nested = f.TryGetProperty("nested", out JsonElement nestEl) && nestEl.ValueKind == JsonValueKind.Object
            ? ParseCaseSpec(nestEl)
            : null;

        return new CaseField(name, kind, required, array, enumValues, enumDoc, example, instruction, nested);
    }

    private static Format ParseFormat(string s) => s switch
    {
        "json" => Format.Json,
        "xml" => Format.Xml,
        _ => throw new ArgumentException($"Unknown format: {s}"),
    };

    private static FieldKind ParseFieldKind(string s) => s switch
    {
        "STRING" => FieldKind.String,
        "INT" => FieldKind.Int,
        "LONG" => FieldKind.Long,
        "DOUBLE" => FieldKind.Double,
        "BOOLEAN" => FieldKind.Boolean,
        "ENUM" => FieldKind.Enum,
        "OBJECT" => FieldKind.Object,
        _ => throw new ArgumentException($"Unknown field kind: {s}"),
    };
}
