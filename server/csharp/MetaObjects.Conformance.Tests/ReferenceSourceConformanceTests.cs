// Runs the shared reference-source corpus against this port. Reads the single committed
// fixtures/reference-source-conformance/cases.json — no per-port fixture. The corpus is the contract;
// see server/typescript/packages/sdk/src/memory.ts (`referenceNodesOf`) for the reference behavior.
using System.Text.Json;
using MetaObjects;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ReferenceSourceConformanceTests
{
    private sealed record Case(
        string Name, Dictionary<string, string> Tree, string ConfigText, string[]? ExpectReference, string? ExpectLoadError);

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in LoadCases()) data.Add(c.Name);
        return data;
    }

    private static string CorpusPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "reference-source-conformance", "cases.json");
    }

    private static List<Case> LoadCases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(CorpusPath()));
        var cases = new List<Case>();
        foreach (var el in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            var tree = new Dictionary<string, string>();
            foreach (var p in el.GetProperty("tree").EnumerateObject()) tree[p.Name] = p.Value.GetString() ?? "";
            string[]? expectReference = el.TryGetProperty("expectReference", out var er)
                ? er.EnumerateArray().Select(x => x.GetString()!).ToArray() : null;
            string? expectLoadError = el.TryGetProperty("expectLoadError", out var ee) ? ee.GetString() : null;
            cases.Add(new Case(el.GetProperty("name").GetString()!, tree, el.GetProperty("config").GetRawText(), expectReference, expectLoadError));
        }
        return cases;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void LoadsReferenceSourcesAndNamesTheReferenceNodes(string name)
    {
        var c = LoadCases().Single(x => x.Name == name);
        var root = Path.Combine(Path.GetTempPath(), "mo-ref-conf-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (var (rel, content) in c.Tree)
            {
                var abs = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
                File.WriteAllText(abs, content);
            }
            var cfgDir = Path.Combine(root, ".metaobjects");
            Directory.CreateDirectory(cfgDir);
            File.WriteAllText(Path.Combine(cfgDir, "config.json"), c.ConfigText);

            var load = MetadataLocation.Resolve(null, root).Load();
            if (c.ExpectLoadError is not null)
            {
                Assert.Contains(load.Errors, e => e.Code.ToString() == c.ExpectLoadError);
                return;
            }
            Assert.Empty(load.Errors);
            // EXHAUSTIVE over the loaded top-level objects: the reference predicate is true for exactly these.
            var got = load.Root.Objects().Where(o => load.Root.IsReference(o)).Select(o => o.ResolutionKey()).OrderBy(x => x, StringComparer.Ordinal).ToList();
            Assert.Equal(c.ExpectReference!.OrderBy(x => x, StringComparer.Ordinal).ToList(), got);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
