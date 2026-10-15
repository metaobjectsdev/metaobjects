using System.Text.Json;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Cross-port api-docs LAYOUT conformance gate — the C# half (Phase 0 of the
/// cross-port SDK-docs plan, docs/superpowers/plans/2026-06-13-cross-port-sdk-docs.md).
///
/// The shared contract is <c>fixtures/conformance/api-docs-cross-port/expected-paths.json</c>,
/// which already declares the <c>api/csharp</c> surface (<c>apiCsharpSubDir</c>, and per-unit
/// <c>apiCsharpPath</c> / <c>apiCsharpToModel</c>). The TS and Java ports assert their own
/// surfaces against this manifest; this is the analogous C# assertion.
///
/// It runs the <c>api-docs</c> entry the way <c>dotnet meta gen</c> runs a project's list
/// (ADR-0034 Amendment 9): through <see cref="CodegenCli.RunGen(MetaObjects.Loader.LoadResult, string, string, bool, IReadOnlyList{IGenerator}, string?, string, bool?)"/>,
/// with the entry's <c>OutDir</c> as the docs root. For every manifest unit it then asserts that
/// <c>&lt;OutDir&gt;/&lt;apiCsharpPath&gt;</c> exists and carries the contract model back-link
/// <c>**Model / metadata:** [&lt;node&gt;](&lt;apiCsharpToModel&gt;)</c>. The manifest is the single
/// source of truth — a future divergence is a real cross-port finding, not a reason to weaken this.
/// </summary>
public sealed class ApiDocsCrossPortConformanceTests
{
    private const string CaseName = "api-docs-cross-port";

    /// <summary>Walk upward from the test assembly to the repo root (contains <c>fixtures/</c> + <c>server/</c>).</summary>
    private static string RepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !(Directory.Exists(Path.Combine(dir, "fixtures")) &&
                 Directory.Exists(Path.Combine(dir, "server"))))
            dir = Directory.GetParent(dir)?.FullName;
        if (dir is null)
            throw new InvalidOperationException(
                "could not locate repo root (a dir containing both fixtures/ and server/) walking up from "
                + AppContext.BaseDirectory);
        return dir;
    }

    private static string CaseDir() => Path.Combine(RepoRoot(), "fixtures", "conformance", CaseName);

    [Fact]
    public void CsharpApiDocsSurface_MatchesTheSharedManifest()
    {
        // ---- read the shared contract as a tree (unknown fields are fine) ----
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(CaseDir(), "expected-paths.json")));
        var root = manifest.RootElement;
        Assert.Equal("package", root.GetProperty("layout").GetString());
        var apiCsharpSubDir = root.GetProperty("apiCsharpSubDir").GetString();
        Assert.Equal("api/csharp", apiCsharpSubDir);

        var inputDir = Path.Combine(CaseDir(), "input");
        var tmp = Path.Combine(Path.GetTempPath(), "meta-api-docs-csharp-" + Guid.NewGuid().ToString("N"));
        var outDir = Path.Combine(tmp, "docs");
        Directory.CreateDirectory(tmp);

        try
        {
            // ---- run the api-docs entry as gen runs it ----
            var outcome = CodegenCli.RunGen(
                MetaObjects.Loader.MetaDataLoader.FromDirectory(inputDir), Path.Combine(tmp, "code"), "Generated", false,
                [new MetaObjects.Codegen.Generators.ApiDocsGenerator { OutDir = outDir }], tmp);
            Assert.True(outcome.Ok, string.Join("\n", outcome.LoadErrors));

            // ---- per-unit: the api/csharp page must exist AND carry the model back-link ----
            foreach (var unit in root.GetProperty("units").EnumerateArray())
            {
                var node = unit.GetProperty("node").GetString()!;
                var apiCsharpPath = unit.GetProperty("apiCsharpPath").GetString()!;
                var apiCsharpToModel = unit.GetProperty("apiCsharpToModel").GetString()!;

                var pageFile = Path.Combine(outDir, apiCsharpPath.Replace('/', Path.DirectorySeparatorChar));

                Assert.True(File.Exists(pageFile),
                    $"C# api-docs surface is missing the page for '{node}'.\n" +
                    $"  expected file: {apiCsharpPath} (under the entry's OutDir)\n" +
                    $"  written: {string.Join(", ", outcome.Result!.Files.Select(f => f.Path))}");

                var page = File.ReadAllText(pageFile);
                var expectedBackLink = $"**Model / metadata:** [{node}]({apiCsharpToModel})";
                Assert.True(page.Contains(expectedBackLink),
                    $"rendered api/csharp page for '{node}' must carry the contract back-link:\n  " +
                    $"{expectedBackLink}\nactual page:\n{page}");
            }
        }
        finally
        {
            try { Directory.Delete(tmp, recursive: true); } catch { /* best effort */ }
        }
    }
}
