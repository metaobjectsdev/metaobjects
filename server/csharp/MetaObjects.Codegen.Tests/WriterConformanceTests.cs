// The shared code-writer corpus (fixtures/writer-conformance/, ADR-0063): the `core` cases and
// the `csharp` dialect's. A case of another port's dialect (`typescript`) belongs to that port's
// writer and is not run here.

using System.Text.Json;
using MetaObjects.Codegen.Writer;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class WriterConformanceTests
{
    private const string DialectCore = "core";
    private const string DialectCsharp = "csharp";

    private static string CasesDir => Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "writer-conformance", "cases");

    private static List<string> CaseNames()
    {
        var names = new List<string>();
        foreach (var path in Directory.GetFiles(CasesDir, "*.json").OrderBy(p => p, StringComparer.Ordinal))
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var dialect = doc.RootElement.GetProperty("dialect").GetString();
            if (dialect is DialectCore or DialectCsharp) names.Add(Path.GetFileNameWithoutExtension(path));
        }
        return names;
    }

    public static TheoryData<string> Cases
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var n in CaseNames()) data.Add(n);
            return data;
        }
    }

    [Fact]
    public void The_corpus_is_present_for_both_dialects()
    {
        var names = CaseNames();
        Assert.True(names.Count(n => !n.StartsWith("cs-", StringComparison.Ordinal) && !n.StartsWith("ts-", StringComparison.Ordinal)) >= 25);
        Assert.Contains("cs-header-usings-body", names);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Case_passes(string name)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(CasesDir, name + ".json")));
        var c = doc.RootElement;
        var dialect = c.GetProperty("dialect").GetString();
        if (dialect == DialectCore) Assert.True(c.TryGetProperty("options", out _), "a core case states its options");

        if (c.TryGetProperty("error", out var error))
        {
            var thrown = Assert.Throws<WriterException>(() => Run(c, dialect!));
            Assert.Equal(error.GetString(), thrown.Code);
            if (c.TryGetProperty("errorQuotes", out var quotes)) Assert.Contains(quotes.GetString()!, thrown.Message);
            return;
        }

        var lines = c.GetProperty("expected").EnumerateArray().Select(l => l.GetString()!).ToList();
        var want = lines.Count == 0 ? "" : string.Join('\n', lines) + "\n";
        Assert.Equal(want, Run(c, dialect!));
    }

    private static string Run(JsonElement c, string dialect)
    {
        var options = c.TryGetProperty("options", out var o) ? o : default;
        CodeWriter w = dialect == DialectCore ? new CodeWriter(CoreOptions(options)) : new CsWriter { UsingOrder = CsOrder(options) };
        foreach (var op in c.GetProperty("ops").EnumerateArray())
        {
            var items = op.EnumerateArray().ToList();
            var name = items[0].GetString()!;
            var args = items.Skip(1).ToList();
            switch (name)
            {
                case "line": w.Line(Parts(args)); break;
                case "open": w.Open(Parts(args)); break;
                case "close": w.Close(Parts(args)); break;
                case "blank": w.Blank(); break;
                case "text": w.Text(args[0].GetString()!); break;
                default:
                    var cs = w as CsWriter ?? throw new InvalidOperationException($"op {name} is not a core op");
                    var s = args.Select(a => a.GetString()!).ToArray();
                    switch (name)
                    {
                        case "header": cs.Header(s); break;
                        case "using": cs.Using(s[0]); break;
                        case "usingStatic": cs.UsingStatic(s[0]); break;
                        case "usingAlias": cs.UsingAlias(s[0], s[1]); break;
                        case "docSummary": cs.DocSummary(s); break;
                        default: throw new InvalidOperationException($"unknown op {name}");
                    }
                    break;
            }
        }
        return w.ToString();
    }

    private static CodeWriterOptions CoreOptions(JsonElement o) => new()
    {
        Indent = o.GetProperty("indent").GetString()!,
        Width = o.GetProperty("width").GetInt32(),
        TrailingComma = o.GetProperty("trailingComma").GetBoolean(),
    };

    // A csharp case runs with the C# defaults and states only the using order, when it changes it.
    private static UsingOrder CsOrder(JsonElement o) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty("usingOrder", out var u) && u.GetString() == "sorted"
            ? UsingOrder.Sorted
            : UsingOrder.AsWritten;

    private static Piece[] Parts(IEnumerable<JsonElement> args) => args.Select(ToPiece).ToArray();

    private static Piece ToPiece(JsonElement p) => p.ValueKind switch
    {
        JsonValueKind.String => p.GetString()!,
        JsonValueKind.Array => Piece.Seq(p.EnumerateArray().Select(ToPiece).ToArray()),
        _ => ToGroup(p.GetProperty("list")),
    };

    private static Piece ToGroup(JsonElement l) => new Group(
        l.GetProperty("open").GetString()!,
        l.GetProperty("items").EnumerateArray().Select(ToPiece).ToList(),
        l.GetProperty("close").GetString()!,
        l.TryGetProperty("pad", out var pad) && pad.GetBoolean());
}
