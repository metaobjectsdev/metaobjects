using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// The namespace gen and verify --codegen generate under: <c>--namespace</c>, else
/// <c>csharp.namespace</c> in <c>.metaobjects/config.json</c>, else the project's metadata package
/// with each <c>::</c> segment PascalCased. Driven through the entry point a project's
/// codegen/Program.cs calls (<see cref="OwnedRunner"/>); the oracle is the
/// <c>namespace ...;</c> declaration in the generated file, the output contract an adopter's code
/// compiles against.
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class CodegenNamespaceTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-ns-" + Guid.NewGuid().ToString("N"));

    private const string Metadata = """
    { "metadata.root": { "package": "acme::shop", "children": [
      { "object.entity": { "name": "Subscriber", "children": [
        { "source.rdb": { "@table": "subscribers" } },
        { "field.long":   { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private string MetaDir => Path.Combine(_tmp, "metaobjects");
    private string OutDir => Path.Combine(_tmp, "Generated");

    public CodegenNamespaceTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.shop.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    private void WriteConfig(string csharpBlock)
    {
        var dir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "config.json"), $$"""{ "schema_version": 1, "csharp": { {{csharpBlock}} } }""");
    }

    private (int Exit, string Output) Run(params string[] args)
    {
        var (exit, stdout, stderr) = OwnedRunner.Run(_tmp, ["entity"], args);
        return (exit, stdout + stderr);
    }

    private string EntityFile() => File.ReadAllText(Path.Combine(OutDir, "Subscriber.g.cs"));

    [Fact]
    public void A_config_namespace_is_used_by_gen_and_a_bare_verify_is_clean()
    {
        WriteConfig("\"outDir\": \"Generated\", \"namespace\": \"Acme.Blog\"");

        var gen = Run("gen");
        Assert.True(gen.Exit == 0, gen.Output);
        Assert.Contains("namespace Acme.Blog;", EntityFile());

        var verify = Run("verify", "--codegen");
        Assert.True(verify.Exit == 0, verify.Output);
    }

    [Fact]
    public void With_no_flag_or_config_the_namespace_is_the_metadata_package()
    {
        WriteConfig("\"outDir\": \"Generated\"");

        var gen = Run("gen");
        Assert.True(gen.Exit == 0, gen.Output);
        Assert.Contains("namespace Acme.Shop;", EntityFile());
        Assert.Equal(0, Run("verify", "--codegen").Exit);
    }

    [Fact]
    public void The_flag_wins_over_config_and_output_under_another_namespace_is_drift()
    {
        WriteConfig("\"outDir\": \"Generated\", \"namespace\": \"Acme.Blog\"");

        Assert.Equal(0, Run("gen", "--namespace", "Other.Ns").Exit);
        Assert.Contains("namespace Other.Ns;", EntityFile());
        Assert.Equal(1, Run("verify", "--codegen").Exit);
    }

    [Fact]
    public void Objects_that_share_no_package_need_a_namespace()
    {
        WriteConfig("\"outDir\": \"Generated\"");
        File.WriteAllText(Path.Combine(MetaDir, "meta.billing.json"), Metadata
            .Replace("acme::shop", "billing").Replace("Subscriber", "Invoice").Replace("subscribers", "invoices"));

        var gen = Run("gen");
        Assert.Equal(2, gen.Exit);
        Assert.Contains("\"csharp\": { \"namespace\": \"<ns>\" }", gen.Output);
    }
}
