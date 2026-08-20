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
        // to "." — every case leaves it there EXCEPT
        // "a-parent-relative-path-resolves-against-the-declaring-configs-directory",
        // so for all the others the config lives at the project root and
        // "relative to project root" vs "relative to the invocation directory"
        // coincide. That one case is the one place those two bases diverge, and
        // both the config's own location AND the expectFiles comparison base
        // below must honor it correctly for that case to mean anything. (Do not
        // restate this as "N of M cases" — the corpus grows and a hardcoded
        // count silently goes stale; the structural description above does not.)
        string ResolveFrom,
        string[]? ExpectFiles,
        // A JSON string pins the exact error code raised; JSON `true` pins only
        // that resolution RAISES — the malformed-config error code is
        // deliberately not pinned cross-port (see the corpus README).
        JsonElement? ExpectError,
        // Optional: linkPath -> targetPath, both project-root-relative, materialized
        // AFTER `Tree` (I1 — a symlinked source root, or a symlinked subdirectory
        // inside a walked tree).
        Dictionary<string, string> Symlinks);

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
            JsonElement? expectError = el.TryGetProperty("expectError", out var ee) ? ee.Clone() : null;

            var symlinks = new Dictionary<string, string>();
            if (el.TryGetProperty("symlinks", out var sl))
            {
                foreach (var p in sl.EnumerateObject()) symlinks[p.Name] = p.Value.GetString()!;
            }

            cases.Add(new Case(el.GetProperty("name").GetString()!, tree, cfg, resolveFrom, expectFiles, expectError, symlinks));
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
            // Materialized AFTER tree — see the Case record's Symlinks doc.
            foreach (var (linkRel, targetRel) in c.Symlinks)
            {
                var linkAbs = Path.Combine(root, linkRel.Replace('/', Path.DirectorySeparatorChar));
                var targetAbs = Path.Combine(root, targetRel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(linkAbs)!);
                Directory.CreateSymbolicLink(linkAbs, targetAbs);
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
                // `true` pins only that resolution RAISES — deliberately not which type,
                // so the assertion is on Exception. Narrowing it to MetaModelException
                // would silently re-pin the very thing the corpus refuses to pin, and did:
                // the symlink-cycle guard raises IOException (the natural type, and the
                // one Java's FileSystemLoopException also derives from), which this
                // runner scored as a FAILURE even though the port behaved correctly.
                // A string still pins the exact code, and that arm requires the richer
                // type — see the ExpectError field doc above.
                var ex = Assert.ThrowsAny<Exception>(() => SourceResolver.ResolveCollection(invokeDir));
                if (c.ExpectError.Value.ValueKind == JsonValueKind.String)
                {
                    var coded = Assert.IsAssignableFrom<MetaModelException>(ex);
                    Assert.Equal(c.ExpectError.Value.GetString(), coded.Code.ToString());
                }
                return;
            }

            // Compared against the PROJECT ROOT explicitly — never against
            // `invokeDir`. For every case but the one that sets `resolveFrom` the
            // two coincide (resolveFrom "."), so a comparison base bug here would
            // pass every other case and fail only that one — which is exactly why
            // that case exists.
            var raw = SourceResolver.ResolveCollection(invokeDir);
            var got = raw
                .Select(f => Path.GetRelativePath(root, f).Replace(Path.DirectorySeparatorChar, '/'))
                .ToHashSet();
            Assert.Equal(c.ExpectFiles!.ToHashSet(), got);
            // A HashSet comparison alone cannot see a duplicate emission (two entries
            // for the same file collapse invisibly into one set element) —
            // `overlapping-sources-yield-each-file-once` specifically exercises
            // ResolveCollection's own de-duplication, so the RAW list count must be
            // asserted too, before it is thrown away by the ToHashSet conversion.
            Assert.Equal(c.ExpectFiles!.Length, raw.Count);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
