// Runs the shared dependency corpus (FR-023) against this port. Reads the single committed
// fixtures/dependency-conformance/cases.json — no per-port fixture; its README is the case schema.
// The reference runners are server/typescript/packages/sdk/test/dependency-conformance.test.ts and
// server/python/tests/conformance/test_dependency_conformance.py.
//
// C# has no native config surface, so a dependency is declared in `.metaobjects/config.json` and
// resolved at every rung of MetadataLocation.Resolve. Each case runs on the NEUTRAL ladder
// (`Resolve(null, resolveDir)`), and again through the EXPLICIT metadata-directory rung
// (`Resolve(<resolveDir>/metaobjects, ...)`) whenever the case has such a directory — the rung a
// `dotnet meta gen <metadataDir>` takes, which must read the same dependencies.
using System.Text.Json;
using MetaObjects;
using MetaObjects.Config;
using MetaObjects.Meta;
using MetaObjects.Source;
using Xunit;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Conformance.Tests;

public class DependencyConformanceTests : IDisposable
{
    private static readonly string CorpusDir = FindCorpusDir();
    private static readonly JsonElement AllCases = LoadCases();

    private readonly string _tmp = Directory.CreateTempSubdirectory("mo-dep-conformance-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_tmp, true); } catch (IOException) { /* temp dir, best effort */ }
    }

    private static string FindCorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures", "dependency-conformance")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "dependency-conformance");
    }

    private static JsonElement LoadCases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(FindCorpusDir(), "cases.json")));
        return doc.RootElement.GetProperty("cases").Clone();
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in AllCases.EnumerateArray()) data.Add(c.GetProperty("name").GetString()!);
        return data;
    }

    [Fact]
    public void CorpusIsNotEmpty() =>
        // A parametrized theory over an empty list collects zero tests and passes; this makes a corpus
        // that quietly lost its cases a failure.
        Assert.NotEmpty(CaseNames());

    /// <summary>
    /// Materializes <c>tree</c> and <c>treeFiles</c> (copied byte-for-byte, so a pinned hash can never
    /// drift) under the temp root, then writes <c>config</c> / <c>lock</c> under
    /// <c>&lt;resolveFrom&gt;/.metaobjects/</c>. Returns the directory resolution is invoked against.
    /// </summary>
    private string Materialize(JsonElement c)
    {
        foreach (var f in c.GetProperty("tree").EnumerateObject())
            WriteFile(f.Name, f.Value.GetString()!);

        if (c.TryGetProperty("treeFiles", out var treeFiles))
            foreach (var f in treeFiles.EnumerateObject())
            {
                var dest = Path.Combine(_tmp, f.Name);
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                File.Copy(Path.Combine(CorpusDir, f.Value.GetString()!), dest);
            }

        var resolveDir = Path.Combine(_tmp, c.TryGetProperty("resolveFrom", out var rf) ? rf.GetString()! : ".");
        var metaobjects = Path.Combine(resolveDir, ".metaobjects");
        if (c.GetProperty("config").ValueKind != JsonValueKind.Null)
        {
            Directory.CreateDirectory(metaobjects);
            File.WriteAllText(Path.Combine(metaobjects, "config.json"), c.GetProperty("config").GetRawText());
        }
        if (c.TryGetProperty("lock", out var lockJson))
        {
            Directory.CreateDirectory(metaobjects);
            File.WriteAllText(Path.Combine(metaobjects, DependencyFiles.LockFile), lockJson.GetRawText());
        }
        return Path.GetFullPath(resolveDir);
    }

    private void WriteFile(string rel, string content)
    {
        var path = Path.Combine(_tmp, rel);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
    }

    private static List<string> Strings(JsonElement arr) => arr.EnumerateArray().Select(e => e.GetString()!).ToList();

    private static List<string> Sorted(IEnumerable<string> xs) => xs.Order(StringComparer.Ordinal).ToList();

    /// <summary>Every loaded top-level object's resolution key — the set the three exhaustive arms range over.</summary>
    private static List<string> TopLevelFqns(MetaRoot root) =>
        // ADR-0039 sanctioned: a ROOT-level scan; `metadata.root` is never extended, so own and effective
        // children are the same set, and the arms are defined over "every loaded top-level object".
        root.Objects().Select(o => o.ResolutionKey()).ToList();

    private string Relative(string path) => Path.GetRelativePath(_tmp, path).Replace('\\', '/');

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void CorpusCaseMatchesTheReference(string name)
    {
        var c = AllCases.EnumerateArray().Single(x => x.GetProperty("name").GetString() == name);
        var resolveDir = Materialize(c);
        // The explicit rung: `dotnet meta gen <metadataDir>` must read the same dependencies.
        var explicitDir = Path.Combine(resolveDir, NeutralConfig.DefaultMetadataDir);
        var hasExplicitRung = Directory.Exists(explicitDir);

        if (c.TryGetProperty("expectError", out var expectError))
        {
            var ex = Assert.Throws<MetaModelException>(() => MetadataLocation.Resolve(null, resolveDir));
            Assert.Equal(expectError.GetString(), ex.Code.ToString());
            if (hasExplicitRung)
            {
                var explicitEx = Assert.Throws<MetaModelException>(() => MetadataLocation.Resolve(explicitDir, _tmp));
                Assert.Equal(expectError.GetString(), explicitEx.Code.ToString());
            }
            return;
        }

        Assert.True(c.TryGetProperty("expectFiles", out var expectFiles),
            $"corpus case \"{name}\" has neither expectFiles nor expectError");

        var resolved = MetadataLocation.Resolve(null, resolveDir);
        AssertResolvedFiles(resolved, expectFiles, name);
        AssertArms(c, resolved, name);

        if (hasExplicitRung)
        {
            var explicitResolved = MetadataLocation.Resolve(explicitDir, _tmp);
            var expectedArtifacts = Strings(expectFiles).Where(f => f.Split('/').Contains(".metaobjects"));
            var gotArtifacts = (explicitResolved.Imports?.Dependencies.Select(d => d.ArtifactPath) ?? []).Select(Relative);
            Assert.Equal(Sorted(expectedArtifacts), Sorted(gotArtifacts));
            AssertArms(c, explicitResolved, name + " (explicit metadata dir)");
        }
    }

    /// <summary>Dependency artifacts then the project's own files; compared as a set AND by length.</summary>
    private void AssertResolvedFiles(ResolvedMetadata resolved, JsonElement expectFiles, string name)
    {
        var got = (resolved.Imports?.Dependencies.Select(d => d.ArtifactPath) ?? [])
            .Concat(resolved.Files ?? []).Select(Relative).ToList();
        var expected = Strings(expectFiles);
        Assert.True(Sorted(expected).SequenceEqual(Sorted(got.Distinct())), $"{name}: files\n  got {string.Join(", ", got)}");
        Assert.Equal(expected.Count, got.Count);
    }

    private static void AssertArms(JsonElement c, ResolvedMetadata resolved, string name)
    {
        var needsLoad = c.TryGetProperty("expectImported", out _) || c.TryGetProperty("expectSelected", out _) ||
                        c.TryGetProperty("expectMigrateGoverned", out _) || c.TryGetProperty("expectLoadError", out _);
        if (!needsLoad) return;

        var result = resolved.Load();
        var imports = resolved.Imports ?? ImportScope.None;

        if (c.TryGetProperty("expectLoadError", out var expectLoadError))
        {
            Assert.True(result.Errors.Count > 0, $"{name}: expected a load error but the collection loaded cleanly");
            var first = result.Errors[0];
            Assert.Equal(expectLoadError.GetString(), first.Code.ToString());
            if (c.TryGetProperty("expectErrorFiles", out var expectErrorFiles))
            {
                IReadOnlyList<string> files = first.Envelope switch
                {
                    JsonSource j => j.Files,
                    YamlSource y => y.Files,
                    _ => first.Source is { } s ? [s] : [],
                };
                Assert.Equal(Strings(expectErrorFiles), files.ToList());
            }
            return;
        }

        Assert.True(result.Errors.Count == 0,
            $"{name}: {string.Join("; ", result.Errors.Select(e => $"{e.Code}: {e.Message}"))}");
        var topLevel = TopLevelFqns(result.Root);

        if (c.TryGetProperty("expectImported", out var expectImported))
            Assert.Equal(Sorted(Strings(expectImported)), Sorted(topLevel.Where(imports.Imported)));
        if (c.TryGetProperty("expectSelected", out var expectSelected))
            Assert.Equal(Sorted(Strings(expectSelected)), Sorted(topLevel.Where(imports.InScope)));
        if (c.TryGetProperty("expectMigrateGoverned", out var expectGoverned))
            Assert.Equal(Sorted(Strings(expectGoverned)), Sorted(topLevel.Where(imports.InMigrateScope)));
    }
}
