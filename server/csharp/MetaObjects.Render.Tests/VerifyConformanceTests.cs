using System.Text.Json;
using Xunit;

namespace MetaObjects.Render.Tests;

/// <summary>
/// Verify-conformance corpus runner — the cross-language template-drift guarantee.
/// Each fixture dir under fixtures/verify-conformance/ holds:
///   payload.json         the payload FIELD-TREE (PayloadField[], declared shape — not render data)
///   template.mustache    the template text whose vars are drift-checked
///   partials/*.mustache  optional partial bodies, referenced as `partials/&lt;name&gt;`
///   options.json         optional { "requiredSlots"?: string[], "provider"?: "with" | "without" }
///   expected-drift.json  array of { "code", "path" } findings (compared as a sorted multiset)
/// The same (payload-tree + template + options) MUST yield the same drift set in TS and C#.
/// Mirrors typescript/packages/render/test/verify-conformance.test.ts and the sibling
/// RenderConformanceTests.cs.
/// </summary>
public class VerifyConformanceTests
{
    // The three stable verify codes a fixture may legitimately expect
    // (documented in fixtures/conformance/ERROR-CODES.json). Anything else is a typo.
    private static readonly HashSet<string> VerifyCodes = new(StringComparer.Ordinal)
    {
        Verify.ERR_VAR_NOT_ON_PAYLOAD,
        Verify.ERR_PARTIAL_UNRESOLVED,
        Verify.ERR_REQUIRED_SLOT_UNUSED,
    };

    private static string CorpusRoot()
    {
        string root = AppContext.BaseDirectory;
        while (!Directory.Exists(Path.Combine(root, "fixtures", "verify-conformance")))
        {
            var parent = Directory.GetParent(root)?.FullName;
            if (parent is null || parent == root)
                throw new InvalidOperationException("fixtures/verify-conformance not found");
            root = parent;
        }
        return Path.Combine(root, "fixtures", "verify-conformance");
    }

    public static IEnumerable<object[]> Fixtures()
    {
        var corpus = CorpusRoot();
        foreach (var dir in Directory.GetDirectories(corpus).OrderBy(d => d, StringComparer.Ordinal))
            yield return new object[] { Path.GetFileName(dir) };
    }

    private static InMemoryProvider ProviderFromPartials(string dir)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var pdir = Path.Combine(dir, "partials");
        if (Directory.Exists(pdir))
        {
            foreach (var f in Directory.GetFiles(pdir, "*.mustache"))
            {
                var name = Path.GetFileNameWithoutExtension(f);
                map[$"partials/{name}"] = File.ReadAllText(f);
            }
        }
        return new InMemoryProvider(map);
    }

    private static IReadOnlyList<PayloadField> ParseFields(JsonElement array) =>
        array.EnumerateArray().Select(ParseField).ToList();

    private static PayloadField ParseField(JsonElement el)
    {
        var name = el.GetProperty("name").GetString()!;
        return el.TryGetProperty("fields", out var fields) && fields.ValueKind == JsonValueKind.Array
            ? new PayloadField(name, ParseFields(fields))
            : new PayloadField(name);
    }

    // (code, path) ordinal order, so the comparison is a sorted multiset independent of
    // the order verify happens to emit findings.
    private static IEnumerable<VerifyError> Sorted(IEnumerable<VerifyError> errs) =>
        errs.OrderBy(e => e.Code, StringComparer.Ordinal).ThenBy(e => e.Path, StringComparer.Ordinal);

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void VerifyMatchesExpected(string name)
    {
        var dir = Path.Combine(CorpusRoot(), name);

        var fields = ParseFields(JsonDocument.Parse(
            File.ReadAllText(Path.Combine(dir, "payload.json"))).RootElement);
        var template = File.ReadAllText(Path.Combine(dir, "template.mustache"));

        // options.json (optional): requiredSlots + provider toggle.
        string[]? requiredSlots = null;
        string? providerMode = null;
        var optionsPath = Path.Combine(dir, "options.json");
        if (File.Exists(optionsPath))
        {
            var opts = JsonDocument.Parse(File.ReadAllText(optionsPath)).RootElement;
            if (opts.TryGetProperty("requiredSlots", out var rs) && rs.ValueKind == JsonValueKind.Array)
                requiredSlots = rs.EnumerateArray().Select(e => e.GetString()!).ToArray();
            if (opts.TryGetProperty("provider", out var p) && p.ValueKind == JsonValueKind.String)
                providerMode = p.GetString();
        }

        // Provider: "with" → build from partials/ (empty map if none); "without" → none.
        // Default: "with" iff a partials/ dir exists. The unresolved-partial case sets
        // provider:"with" with no partials/ dir (an empty provider resolves nothing).
        var mode = providerMode ?? (Directory.Exists(Path.Combine(dir, "partials")) ? "with" : "without");
        IProvider? provider = mode == "with" ? ProviderFromPartials(dir) : null;

        var expected = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "expected-drift.json")))
            .RootElement.EnumerateArray()
            .Select(e => new VerifyError(e.GetProperty("code").GetString()!, e.GetProperty("path").GetString()!))
            .ToList();

        // Lint: every expected code is a known verify code (typo guard).
        foreach (var e in expected)
            Assert.Contains(e.Code, VerifyCodes);

        var options = new VerifyOptions { Provider = provider, RequiredSlots = requiredSlots };
        var actual = Verify.Check(template, fields, options);

        Assert.Equal(Sorted(expected), Sorted(actual));
        // Determinism: identical across runs.
        Assert.Equal(actual, Verify.Check(template, fields, options));
    }
}
