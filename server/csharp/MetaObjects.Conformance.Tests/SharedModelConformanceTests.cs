// Runs the shared FR-023 publish corpus (fixtures/shared-model-conformance/cases.json) against this port.
// The reference is server/typescript/packages/codegen-ts/src/shared-model/build-shared-model.ts;
// MetaObjects.Config.SharedModel is this port's counterpart. Every publish case pins the artifact and the
// manifest BYTES; every refusal pins its reason (and, for not-closed, the exhaustive sorted pairs). The
// message text is not the contract.
using System.Text.Json;
using MetaObjects.Config;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class SharedModelConformanceTests
{
    private const string MetamodelVersionToken = "@@METAMODEL_VERSION@@";

    /// <summary>The corpus's <c>secret-handling</c> provider: one common string attribute no library provider ships.</summary>
    private sealed class SecretHandlingProvider : IMetaDataTypeProvider
    {
        public string Id => "secret-handling";
        public IReadOnlyList<string> Dependencies => ["metaobjects-core-types"];

        public void RegisterTypes(TypeRegistry registry) =>
            registry.RegisterCommonAttrs([new AttrSchema("secretHandling", "string", Required: false, Description: "Test vocabulary.")]);
    }

    private static string CorpusDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "fixtures", "shared-model-conformance")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir!.FullName, "fixtures", "shared-model-conformance");
    }

    private static JsonElement Cases()
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(CorpusDir(), "cases.json")));
        return doc.RootElement.GetProperty("cases").Clone();
    }

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var c in Cases().EnumerateArray()) data.Add(c.GetProperty("name").GetString()!);
        return data;
    }

    private static List<string> Strings(JsonElement obj, string key) =>
        obj.TryGetProperty(key, out var arr) ? arr.EnumerateArray().Select(e => e.GetString()!).ToList() : [];

    [Fact]
    public void TheCorpusIsNotEmpty() => Assert.NotEmpty(Cases().EnumerateArray());

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void PublishesLikeTheReference(string caseName)
    {
        var c = Cases().EnumerateArray().Single(x => x.GetProperty("name").GetString() == caseName);
        var input = c.GetProperty("input");
        var providers = new List<IMetaDataTypeProvider>();
        foreach (var p in Strings(input, "providers"))
        {
            Assert.Equal("secret-handling", p);
            providers.Add(new SecretHandlingProvider());
        }
        var req = new SharedModelInput(
            input.GetProperty("name").GetString()!,
            Strings(input, "files").Select(f => Path.Combine(CorpusDir(), f)).ToList(),
            Strings(input, "include"), Strings(input, "exclude"), providers,
            input.TryGetProperty("requirements", out var reqs) && reqs.GetBoolean());

        if (c.TryGetProperty("expectRefusal", out var refusal))
        {
            var thrown = Assert.Throws<SharedModelRefusal>(() => SharedModel.Build(req));
            Assert.Equal(refusal.GetProperty("reason").GetString(), thrown.ReasonId);
            if (refusal.TryGetProperty("pairs", out var pairs))
            {
                var expected = pairs.EnumerateArray()
                    .Select(p => new SharedModelPair(p.GetProperty("referrer").GetString()!, p.GetProperty("target").GetString()!))
                    .ToList();
                Assert.Equal(expected, thrown.Pairs.ToList());
            }
            return;
        }

        var files = SharedModel.Render(SharedModel.Build(req), input.GetProperty("version").GetString()!);
        var expectedArtifact = File.ReadAllText(Path.Combine(CorpusDir(), c.GetProperty("expectArtifact").GetString()!));
        var expectedManifest = File.ReadAllText(Path.Combine(CorpusDir(), c.GetProperty("expectManifest").GetString()!))
            .Replace(MetamodelVersionToken, RegistryManifest.MetamodelVersion);
        Assert.Equal(expectedArtifact, files.Artifact);
        Assert.Equal(expectedManifest, files.Manifest);
        Assert.Equal(input.GetProperty("name").GetString() + ".metaobjects.json", files.ArtifactPath);
        Assert.Equal("metaobjects.pkg.json", files.ManifestPath);
    }
}
