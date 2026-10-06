using System.Text.Json;
using System.Text.RegularExpressions;
using MetaObjects.Codegen.ApiDocs;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// The api-contract <c>projection/</c> corpus, docs half. The REST routes a read-only
/// projection's api page lists are exactly the routes its generated surface answers with a
/// row. Every port runs this assertion over the same model and the same expected set
/// (<c>fixtures/api-contract-conformance/projection/docs-routes.json</c>):
/// <list type="bullet">
///   <item>a projection with a declared identity lists <c>GET &lt;path&gt;</c> and <c>GET &lt;path&gt;/{id}</c>;</item>
///   <item>one with none lists <c>GET &lt;path&gt;</c> alone, even when it has a field named <c>id</c>;</item>
///   <item>no unit lists a write verb.</item>
/// </list>
/// The booted-server half of the same contract is the corpus scenarios themselves
/// (<c>MetaObjects.IntegrationTests/Api/ApiContractProjectionConformanceTest</c>).
/// </summary>
public sealed class ProjectionDocsRoutesTests
{
    private static string Corpus()
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null &&
               !(Directory.Exists(Path.Combine(dir, "fixtures")) && Directory.Exists(Path.Combine(dir, "server"))))
            dir = Directory.GetParent(dir)?.FullName;
        if (dir is null)
            throw new InvalidOperationException("could not locate the repo root from " + AppContext.BaseDirectory);
        return Path.Combine(dir, "fixtures", "api-contract-conformance", "projection");
    }

    /// <summary>The spelling every port's expected set uses: no leading slash or api prefix, <c>{id}</c>.</summary>
    private static string Normalize(string symbol)
    {
        var space = symbol.IndexOf(' ');
        var path = Regex.Replace(symbol[(space + 1)..], "^/?(?:api/)?", "");
        return symbol[..space] + " " + path;
    }

    [Fact]
    public void Each_projection_documents_exactly_the_routes_it_mounts()
    {
        var corpus = Corpus();
        using var expectedDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(corpus, "docs-routes.json")));
        var result = new MetaDataLoader().Load([new FileSource(Path.Combine(corpus, "meta.json"))]);
        Assert.Empty(result.Errors);

        var model = new CSharpApiModelBuilder(new GenConfig { OutDir = "/unused", Namespace = "Acme" })
            .Build(result.Root, "projection-docs");

        foreach (var unitProp in expectedDoc.RootElement.GetProperty("units").EnumerateObject())
        {
            var expected = unitProp.Value.EnumerateArray().Select(e => e.GetString()!).OrderBy(s => s).ToList();
            var unit = model.Units.Single(u => u.Node == unitProp.Name);
            var documented = unit.Symbols
                .Where(s => s.Kind == ApiSymbolKind.Rest)
                .Select(s => Normalize(s.Name))
                .OrderBy(s => s)
                .ToList();
            Assert.True(expected.SequenceEqual(documented),
                $"{unitProp.Name}: expected [{string.Join(", ", expected)}] but the api page lists [{string.Join(", ", documented)}]");
        }
    }
}
