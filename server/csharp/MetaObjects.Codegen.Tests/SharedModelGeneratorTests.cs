// FR-023 publish: the shared-model generator writes the two files the shared corpus
// (fixtures/shared-model-conformance/) pins, byte for byte, through the path `dotnet meta gen` takes (options
// in, files out, version from the project). The artifact's bytes themselves are gated by
// SharedModelConformanceTests in the core test assembly.
using MetaObjects.Codegen.Generators;
using MetaObjects.Config;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public sealed class SharedModelGeneratorTests : IDisposable
{
    private readonly string _out = Directory.CreateTempSubdirectory("mo-shared-model-out-").FullName;
    private readonly string _project = Directory.CreateTempSubdirectory("mo-shared-model-project-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_out, true); } catch (IOException) { /* temp dir, best effort */ }
        try { Directory.Delete(_project, true); } catch (IOException) { /* temp dir, best effort */ }
    }

    private static string Corpus => Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "shared-model-conformance");

    private GenContext Context()
    {
        var root = new MetaDataLoader().Load([]).Root;
        return new GenContext
        {
            Entities = [],
            Root = root,
            Config = new GenConfig { OutDir = _out, ProjectRoot = _project },
        };
    }

    private SharedModelGenerator Generator(string? version = null, string? include = null) => new()
    {
        ModelName = "acme-common",
        Include = [include ?? "acme::common::**"],
        Exclude = include is null ? ["acme::common::Secret"] : [],
        Files = [Path.Combine(Corpus, "source/meta.base.json"), Path.Combine(Corpus, "source/meta.customer.json")],
        Version = version,
    };

    [Fact]
    public void WritesTheArtifactAndManifestTheCorpusPins()
    {
        File.WriteAllText(Path.Combine(_project, "App.csproj"),
            "<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>");

        var files = Generator().Generate(Context()).ToDictionary(f => f.Path, f => f.Content);

        Assert.Equal(["acme-common.metaobjects.json", "metaobjects.pkg.json"], files.Keys.Order().ToArray());
        Assert.Equal(
            File.ReadAllText(Path.Combine(Corpus, "..", "dependency-conformance", "artifacts", "acme-common-v1.json")),
            files["acme-common.metaobjects.json"]);
        Assert.Equal(
            File.ReadAllText(Path.Combine(Corpus, "expected", "acme-common-v1", "metaobjects.pkg.json"))
                .Replace("@@METAMODEL_VERSION@@", RegistryManifest.MetamodelVersion),
            files["metaobjects.pkg.json"]);
    }

    [Fact]
    public void TheVersionComesFromTheNearestDirectoryBuildPropsWhenTheProjectFileHasNone()
    {
        File.WriteAllText(Path.Combine(_project, "App.csproj"), "<Project />");
        File.WriteAllText(Path.Combine(_project, "Directory.Build.props"),
            "<Project><PropertyGroup><Version>2.3.4</Version></PropertyGroup></Project>");

        var manifest = Generator().Generate(Context()).Single(f => f.Path == "metaobjects.pkg.json").Content;

        Assert.Contains("\"version\": \"2.3.4\"", manifest);
    }

    [Fact]
    public void AnExplicitVersionBeatsTheProjectVersion()
    {
        File.WriteAllText(Path.Combine(_project, "App.csproj"),
            "<Project><PropertyGroup><Version>9.9.9</Version></PropertyGroup></Project>");

        var manifest = Generator("1.0.0").Generate(Context()).Single(f => f.Path == "metaobjects.pkg.json").Content;

        Assert.Contains("\"version\": \"1.0.0\"", manifest);
    }

    [Fact]
    public void NoVersionAnywhereIsRefusedAfterTheSelectionPasses()
    {
        // The temp project sits under no Directory.Build.props the generator can find.
        var e = Assert.Throws<InvalidOperationException>(() => Generator().Generate(Context()).ToList());
        Assert.Contains("no version available", e.Message);
    }

    [Fact]
    public void ARefusedSelectionSaysWhy()
    {
        var e = Assert.Throws<SharedModelRefusal>(() => Generator("1.0.0", "nothing::**").Generate(Context()).ToList());
        Assert.Equal(SharedModelRefusalReason.EmptySelection, e.Reason);
    }

    [Fact]
    public void AMissingOptionNamesTheOption()
    {
        var e = Assert.Throws<InvalidOperationException>(() =>
            new SharedModelGenerator { Include = ["a::**"], Files = ["x.json"] }.Generate(Context()).ToList());
        Assert.Contains("ModelName", e.Message);
    }
}
