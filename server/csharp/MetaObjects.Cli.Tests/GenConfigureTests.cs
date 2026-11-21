using MetaObjects.Codegen;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// T11-CS: the codegen project <c>dotnet meta init</c> writes passes <c>Generators.Configure</c> to
/// <see cref="CodegenCli.Run(string[], IReadOnlyList{IGenerator}, Func{GenConfig, GenConfig})"/>, so a
/// <see cref="GenConfig"/> option no flag or config key sets (here <see cref="GenConfig.PropertyNaming"/>)
/// reaches the generators. <c>verify --codegen</c> applies the same settings, so it agrees with gen.
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class GenConfigureTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-gen-configure-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "out");

    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Talk", "children": [
        { "source.rdb": { "@table": "talks" } },
        { "field.long": { "name": "id" } },
        { "field.string": { "name": "title" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static GenConfig Configure(GenConfig config) =>
        config with { PropertyNaming = f => f.Name == "title" ? "Headline" : char.ToUpperInvariant(f.Name[0]) + f.Name[1..] };

    public GenConfigureTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Model);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private string TalkSource() => File.ReadAllText(Directory.EnumerateFiles(OutDir, "Talk.g.cs", SearchOption.AllDirectories).Single());

    [Fact]
    public void Gen_applies_the_projects_settings_and_verify_agrees()
    {
        var declared = OwnedRunner.Declared(_tmp, "entity");
        var gen = OwnedRunner.Run(_tmp, declared, Configure, "gen", MetaDir, "--out", OutDir, "--namespace", "Acme");
        Assert.True(gen.ExitCode == 0, gen.Stderr);
        Assert.Contains(" Headline ", TalkSource());
        Assert.DoesNotContain(" Title ", TalkSource());

        var verify = OwnedRunner.Run(_tmp, declared, Configure, "verify", "--codegen", MetaDir, "--out", OutDir, "--namespace", "Acme", "--full");
        Assert.True(verify.ExitCode == 0, verify.Stderr);

        // Without the settings the same list writes the default name, so the committed output drifts.
        var bare = OwnedRunner.Run(_tmp, declared, "verify", "--codegen", MetaDir, "--out", OutDir, "--namespace", "Acme", "--full");
        Assert.Equal(1, bare.ExitCode);
        Assert.Contains("Talk.g.cs", bare.Stderr);
    }

    [Fact]
    public void Without_settings_gen_writes_the_default_property_name()
    {
        var run = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--namespace", "Acme");
        Assert.True(run.ExitCode == 0, run.Stderr);
        Assert.Contains(" Title ", TalkSource());
    }
}
