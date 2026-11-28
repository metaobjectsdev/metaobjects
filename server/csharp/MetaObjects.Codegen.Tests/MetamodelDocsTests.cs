using System.Text.Json;
using System.Text.Json.Nodes;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// The metamodel-docs generator against fixtures/metamodel-docs/: the page data the builder makes
/// (data/) and the bytes the shared templates render it to (expected/), TypeScript being the source.
/// </summary>
public sealed class MetamodelDocsTests
{
    private static string Dir(string sub) => Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "metamodel-docs", sub);

    private static IReadOnlyDictionary<string, string> Descriptions()
    {
        var path = Path.Combine(CorpusPaths.RepoRoot(), "templates", "metamodel", "provider-descriptions.json");
        return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))!;
    }

    private static IEnumerable<EmittedFile> Run()
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource("{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}", id: "x.json")]);
        return new MetaObjects.Codegen.Generators.MetamodelDocsGenerator { SubDir = "" }.Generate(new GenContext
        {
            Entities = load.Root.Objects(),
            Root = load.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme" },
        }).ToList();
    }

    [Fact]
    public void Builder_data_equals_every_pinned_data_file()
    {
        var pages = MetamodelDocsPages.BuildBuiltIn(Descriptions());
        var expected = Directory.GetFiles(Dir("data"), "*.json", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(Dir("data"), f).Replace('\\', '/'))
            .Select(f => f[..^".json".Length]).OrderBy(f => f, StringComparer.Ordinal).ToList();
        Assert.Equal(expected, pages.Select(p => p.Path).OrderBy(f => f, StringComparer.Ordinal).ToList());
        foreach (var page in pages)
        {
            var want = JsonNode.Parse(File.ReadAllText(Path.Combine(Dir("data"), page.Path + ".json")));
            var got = JsonSerializer.SerializeToNode(page.Data);
            Assert.True(JsonNode.DeepEquals(want, got), $"data differs for {page.Path}");
        }
    }

    [Fact]
    public void Rendered_pages_equal_every_expected_file_byte_for_byte()
    {
        var emitted = Run().ToDictionary(f => f.Path, f => f.Content, StringComparer.Ordinal);
        var expected = Directory.GetFiles(Dir("expected"), "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(Dir("expected"), f).Replace('\\', '/')).OrderBy(f => f, StringComparer.Ordinal).ToList();
        Assert.Equal(expected, emitted.Keys.OrderBy(f => f, StringComparer.Ordinal).ToList());
        foreach (var path in expected)
            Assert.True(File.ReadAllText(Path.Combine(Dir("expected"), path)) == emitted[path], $"bytes differ for {path}");
    }

    [Fact]
    public void Default_sub_directory_is_metamodel()
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource("{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}", id: "x.json")]);
        var files = new MetaObjects.Codegen.Generators.MetamodelDocsGenerator().Generate(new GenContext
        {
            Entities = load.Root.Objects(), Root = load.Root, Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme" },
        }).ToList();
        Assert.Equal(23, files.Count);
        Assert.All(files, f => Assert.StartsWith("metamodel/", f.Path));
    }
}
