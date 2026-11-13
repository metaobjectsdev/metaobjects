using MetaObjects.Cli;
using MetaObjects.Codegen;
using MetaObjects.Config;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Cli.Tests;

public sealed class PackageLayoutConfigTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "mo-layout-" + Guid.NewGuid().ToString("N"));

    public PackageLayoutConfigTests() => Directory.CreateDirectory(Path.Combine(_root, ".metaobjects"));
    public void Dispose() { try { Directory.Delete(_root, true); } catch (IOException) { } }

    private NeutralConfig Read(string json)
    {
        File.WriteAllText(Path.Combine(_root, ".metaobjects", "config.json"), json);
        return NeutralConfig.Read(_root, validateNaming: false)!;
    }

    [Fact]
    public void Absent_keys_read_as_the_default_layout_and_the_earlier_namespace_rule()
    {
        var cfg = Read("""{ "schema_version": 1, "csharp": { "namespace": "Acme.Gen" } }""");
        Assert.Equal("flat", cfg.OutputLayout);
        Assert.Equal(PackageNamespaceSetting.Off, cfg.PackageNamespaces);
        var gen = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen" }.WithCSharpLayout(cfg);
        Assert.Equal(OutputLayout.Flat, gen.OutputLayout);
        Assert.False(gen.PackageNamespacesFromMetadata);
    }

    [Fact]
    public void The_true_form_binds_each_packaged_type_to_its_package_namespace()
    {
        var cfg = Read("""{ "schema_version": 1, "csharp": { "namespace": "Acme.Gen", "outputLayout": "package", "packageNamespaces": true } }""");
        var gen = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen" }.WithCSharpLayout(cfg);
        Assert.Equal(OutputLayout.Package, gen.OutputLayout);
        Assert.True(gen.PackageNamespacesFromMetadata);
    }

    [Fact]
    public void The_map_form_is_an_explicit_package_to_namespace_mapping()
    {
        var cfg = Read("""{ "schema_version": 1, "csharp": { "packageNamespaces": { "acme::alpha": "Acme.Alpha" } } }""");
        var gen = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Gen" }.WithCSharpLayout(cfg);
        Assert.False(gen.PackageNamespacesFromMetadata);
        Assert.Equal("Acme.Alpha", gen.PackageNamespaces["acme::alpha"]);
    }

    [Theory]
    [InlineData("""{ "schema_version": 1, "csharp": { "outputLayout": "tree" } }""")]
    [InlineData("""{ "schema_version": 1, "csharp": { "packageNamespaces": "yes" } }""")]
    [InlineData("""{ "schema_version": 1, "csharp": { "packageNamespaces": { "acme": 3 } } }""")]
    public void A_wrong_shaped_value_is_refused(string json) =>
        Assert.Throws<MetaModelException>(() => Read(json));

    [Fact]
    public void Init_writes_the_opt_ins_for_a_new_project_and_leaves_an_existing_config_alone()
    {
        var fresh = Path.Combine(_root, "fresh");
        Directory.CreateDirectory(fresh);
        var lines = InitCommand.Run(fresh);
        Assert.Contains(lines, l => l.Contains(".metaobjects/config.json"));
        var cfg = NeutralConfig.Read(fresh, validateNaming: false)!;
        Assert.Equal("package", cfg.OutputLayout);
        Assert.True(cfg.PackageNamespaces.FromMetadata);
        // The same new-project api block TypeScript `meta init` writes: a 50/1000 page size and
        // unknownFields spelled out at "reject" (a default left implicit would hide the choice).
        Assert.Equal(new ApiPagination(50, 1000), cfg.Api.Pagination);
        using (var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(Path.Combine(fresh, ".metaobjects", "config.json"))))
            Assert.Equal("reject", doc.RootElement.GetProperty("api").GetProperty("unknownFields").GetString());

        File.WriteAllText(Path.Combine(fresh, ".metaobjects", "config.json"), "{ \"schema_version\": 1 }");
        InitCommand.Run(fresh);
        Assert.Equal("{ \"schema_version\": 1 }", File.ReadAllText(Path.Combine(fresh, ".metaobjects", "config.json")));
    }
}
