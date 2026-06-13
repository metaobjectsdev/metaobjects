using System.Text.Json;
using MetaObjects.Codegen.ApiDocs;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Path-math unit gate (Phase 1 Task 1.1): <see cref="DocsPaths"/> must compute the
/// SAME <c>apiCsharpPath</c> / <c>apiCsharpToModel</c> the shared cross-port contract
/// (<c>fixtures/conformance/api-docs-cross-port/expected-paths.json</c>) declares, for
/// every manifest unit, with layout=package + apiSubDir="api/csharp". This proves the
/// C# path math agrees with the TS oracle + the Java port before any rendering exists.
/// </summary>
public sealed class CSharpDocsPathsTests
{
    private static string RepoRoot()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !(Directory.Exists(Path.Combine(dir, "fixtures")) && Directory.Exists(Path.Combine(dir, "server"))))
            dir = Directory.GetParent(dir)?.FullName;
        return dir ?? throw new InvalidOperationException("repo root not found from " + AppContext.BaseDirectory);
    }

    [Fact]
    public void PathMath_MatchesTheSharedManifest()
    {
        var manifestPath = Path.Combine(RepoRoot(), "fixtures", "conformance", "api-docs-cross-port", "expected-paths.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var root = doc.RootElement;
        Assert.Equal("package", root.GetProperty("layout").GetString());
        var apiSubDir = root.GetProperty("apiCsharpSubDir").GetString()!; // "api/csharp"
        Assert.Equal("api/csharp", apiSubDir);

        const string pkg = "acme::shop";
        var checkd = 0;
        foreach (var unit in root.GetProperty("units").EnumerateArray())
        {
            var node = unit.GetProperty("node").GetString()!;
            var pagePath = DocsPaths.DocPageOutputPath(DocsPaths.Layout.Package, pkg, node);
            var apiCsharpPath = apiSubDir + "/" + pagePath;
            Assert.Equal(unit.GetProperty("apiCsharpPath").GetString(), apiCsharpPath);

            var modelHref = DocsPaths.ModelCrossHref(apiCsharpPath, pagePath, null);
            Assert.Equal(unit.GetProperty("apiCsharpToModel").GetString(), modelHref);
            checkd++;
        }
        Assert.True(checkd >= 4, $"expected to check all manifest units; saw {checkd}");
    }
}
