using MetaObjects.Codegen;
using MetaObjects.Config;
using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// `dotnet meta gen` loads leniently and `dotnet meta verify` strictly (ADR-0023). An
/// unknown attribute (a misspelt `@required`, `@isAbstrakt` meant as `abstract`) used to
/// pass `gen` without a word while `verify` rejected the same file with ERR_UNKNOWN_ATTR.
/// `gen` now names each finding (attribute, node, file) as a warning and keeps its exit code.
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class GenUnknownAttrWarningTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-gen-unknown-attr-" + Guid.NewGuid().ToString("N"));
    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "out");

    private const string Typos = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "BaseThing", "@isAbstrakt": true, "children": [
        { "field.long": { "name": "id" } }
      ]}},
      { "object.entity": { "name": "Talk", "extends": "BaseThing", "children": [
        { "source.rdb": { "@table": "talks" } },
        { "field.string": { "name": "title", "@requird": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    public GenUnknownAttrWarningTests() => Directory.CreateDirectory(MetaDir);

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    [Fact]
    public void Gen_warns_about_each_unknown_attribute_and_keeps_its_exit_code()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Typos);
        var run = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--namespace", "Acme");
        Assert.Equal(0, run.ExitCode);
        Assert.Contains("ERR_UNKNOWN_ATTR", run.Stderr);
        Assert.Contains("isAbstrakt", run.Stderr);
        Assert.Contains("BaseThing", run.Stderr);
        Assert.Contains("requird", run.Stderr);
        Assert.Contains("meta.acme.json", run.Stderr);
        Assert.Contains("dotnet meta verify", run.Stderr);
    }

    [Fact]
    public void Strict_gen_rejects_an_unknown_attribute_before_writing_anything()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Typos);
        var run = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--namespace", "Acme", "--strict");
        Assert.Equal(1, run.ExitCode);
        Assert.Contains("ERR_UNKNOWN_ATTR", run.Stderr);
        Assert.Contains("hint: " + VerifyCommand.UNKNOWN_ATTR_HINT, run.Stderr);
        Assert.False(Directory.Exists(OutDir) && Directory.EnumerateFiles(OutDir, "*", SearchOption.AllDirectories).Any());
    }

    [Fact]
    public void Strict_gen_on_a_clean_model_generates()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"),
            Typos.Replace("\"@isAbstrakt\": true", "\"abstract\": true").Replace("@requird", "@required"));
        var run = OwnedRunner.Run(_tmp, ["entity"], "gen", MetaDir, "--out", OutDir, "--namespace", "Acme", "--strict");
        Assert.Equal(0, run.ExitCode);
        Assert.NotEmpty(Directory.EnumerateFiles(OutDir, "*.cs", SearchOption.AllDirectories));
    }

    [Fact]
    public void A_clean_model_has_no_unknown_attribute_warnings()
    {
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"),
            Typos.Replace("\"@isAbstrakt\": true", "\"abstract\": true").Replace("@requird", "@required"));
        Assert.Empty(CodegenCli.UnknownAttrWarnings(MetadataLocation.Resolve(MetaDir, _tmp)));
    }
}
