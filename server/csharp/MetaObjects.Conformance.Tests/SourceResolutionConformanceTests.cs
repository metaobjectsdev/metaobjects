// Runs the shared source-resolution corpus against this port. Reads the single
// committed fixtures/source-resolution-conformance/cases.json — no per-port
// fixture. The corpus is the contract; see server/typescript/packages/sdk/src/
// sources.ts + collection.ts for the authoritative behavior each case pins.
using System.Text.Json;
using MetaObjects;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SourceResolutionConformanceTests
{
    private sealed record Case(
        string Name,
        Dictionary<string, string> Tree,
        JsonElement? Config,
        // Project-root-relative directory the resolver is invoked FROM. Defaults
        // to "." — 18 of 19 cases leave it there, so the config lives at the
        // project root and "relative to project root" vs "relative to the
        // invocation directory" coincide. The one case that sets it
        // ("a-parent-relative-path-resolves-against-the-declaring-configs-
        // directory") is the one place those two bases diverge, and both the
        // config's own location AND the expectFiles comparison base below must
        // honor it correctly for that case to mean anything.
        string ResolveFrom,
        string[]? ExpectFiles,
        string? ExpectError);

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
        return Path.Combine(dir!.FullName, "fixtures", "source-resolution-conformance", "cases.json");
    }

    private static List<Case> LoadCases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(CorpusPath()));
        var cases = new List<Case>();
        foreach (var el in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            var tree = new Dictionary<string, string>();
            foreach (var p in el.GetProperty("tree").EnumerateObject())
                tree[p.Name] = p.Value.GetString() ?? "";

            var cfgEl = el.GetProperty("config");
            JsonElement? cfg = cfgEl.ValueKind == JsonValueKind.Null ? null : cfgEl.Clone();

            var resolveFrom = el.TryGetProperty("resolveFrom", out var rf) ? rf.GetString()! : ".";

            string[]? expectFiles = el.TryGetProperty("expectFiles", out var ef)
                ? ef.EnumerateArray().Select(x => x.GetString()!).ToArray()
                : null;
            string? expectError = el.TryGetProperty("expectError", out var ee) ? ee.GetString() : null;

            cases.Add(new Case(el.GetProperty("name").GetString()!, tree, cfg, resolveFrom, expectFiles, expectError));
        }
        return cases;
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void ResolvesTheSameFileSet(string name)
    {
        var c = LoadCases().Single(x => x.Name == name);
        // `root` is the PROJECT ROOT — the base every `tree` path and every
        // `expectFiles` entry is written relative to, regardless of `resolveFrom`.
        var root = Path.Combine(Path.GetTempPath(), "mo-src-conf-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (var (rel, content) in c.Tree)
            {
                var abs = Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(abs)!);
                File.WriteAllText(abs, content);
            }

            // The invocation directory: project root joined with `resolveFrom`.
            // The config MUST be materialized here, not at the project root — a
            // config placed at the project root while resolving FROM a
            // subdirectory would go undetected by ResolveCollection there and
            // fail loudly with ERR_COLLECTION_NOT_FOUND, which is what makes this
            // half of the mistake self-catching. Getting it right on purpose (not
            // by luck) is what this comment is pinning.
            var invokeDir = Path.GetFullPath(Path.Combine(root, c.ResolveFrom));
            Directory.CreateDirectory(invokeDir);
            if (c.Config is not null)
            {
                var d = Path.Combine(invokeDir, ".metaobjects");
                Directory.CreateDirectory(d);
                File.WriteAllText(Path.Combine(d, "config.json"), c.Config.Value.GetRawText());
            }

            if (c.ExpectError is not null)
            {
                var ex = Assert.ThrowsAny<MetaModelException>(() => SourceResolver.ResolveCollection(invokeDir));
                Assert.Equal(c.ExpectError, ex.Code.ToString());
                return;
            }

            // Compared against the PROJECT ROOT explicitly — never against
            // `invokeDir`. For 18 of 19 cases the two coincide (resolveFrom "."),
            // so a comparison base bug here would pass every case except the one
            // that sets `resolveFrom`, which is exactly why that case exists.
            var got = SourceResolver.ResolveCollection(invokeDir)
                .Select(f => Path.GetRelativePath(root, f).Replace(Path.DirectorySeparatorChar, '/'))
                .ToHashSet();
            Assert.Equal(c.ExpectFiles!.ToHashSet(), got);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
