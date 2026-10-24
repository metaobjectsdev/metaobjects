using Xunit;

namespace MetaObjects.Cli.Tests;

/// <summary>
/// ADR-0019 Amendment 2: the JSON a generated API writes is the project setting <c>wire</c> in
/// <c>.metaobjects/config.json</c>, read the way <c>naming</c> is. With no setting, a decimal is
/// what System.Text.Json writes (a JSON number) and a value object's null member is <c>null</c>;
/// <c>"decimals": "string"</c> and <c>"nullMembers": "omit"</c> are the cross-port form. Driven
/// through <see cref="OwnedRunner"/>, the entry point a project's codegen/Program.cs calls.
/// </summary>
[Collection(OwnedRunnerCollection.Name)]
public sealed class WireSettingCliTests : IDisposable
{
    private readonly string _tmp = Path.Combine(Path.GetTempPath(), "meta-cli-wire-" + Guid.NewGuid().ToString("N"));

    private const string Metadata = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.value": { "name": "Price", "children": [
        { "field.decimal": { "name": "net", "@precision": 12, "@scale": 2 } },
        { "field.string": { "name": "note" } }
      ]}},
      { "object.entity": { "name": "Item", "children": [
        { "source.rdb": { "@table": "items" } },
        { "field.long": { "name": "id" } },
        { "field.decimal": { "name": "amount", "@precision": 10, "@scale": 2 } },
        { "field.object": { "name": "price", "@objectRef": "Price", "@storage": "jsonb" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private string MetaDir => Path.Combine(_tmp, "metaobjects");

    public WireSettingCliTests()
    {
        Directory.CreateDirectory(MetaDir);
        File.WriteAllText(Path.Combine(MetaDir, "meta.acme.json"), Metadata);
    }

    public void Dispose() { try { Directory.Delete(_tmp, recursive: true); } catch { } }

    /// <summary>Writes <c>.metaobjects/config.json</c> with the given <c>wire</c> body, or no
    /// <c>wire</c> key at all when <paramref name="wire"/> is null.</summary>
    private void WriteConfig(string? wire)
    {
        var dir = Path.Combine(_tmp, ".metaobjects");
        Directory.CreateDirectory(dir);
        var json = wire is null
            ? """{ "schema_version": 1 }"""
            : $$"""{ "schema_version": 1, "wire": { {{wire}} } }""";
        File.WriteAllText(Path.Combine(dir, "config.json"), json);
    }

    private string Generate(string outName)
    {
        var outDir = Path.Combine(_tmp, outName);
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, ["entity"], "gen", MetaDir, "--out", outDir, "--namespace", "Acme.Generated");
        Assert.True(exit == 0, $"exit={exit}\n{stdout}{stderr}");
        return outDir;
    }

    [Fact]
    public void With_no_setting_gen_writes_the_language_standard_form()
    {
        var outDir = Generate("generated-native");
        var item = File.ReadAllText(Path.Combine(outDir, "Item.g.cs"));
        var price = File.ReadAllText(Path.Combine(outDir, "Price.g.cs"));
        Assert.Contains("[DecimalWire.Number(10, 2)]", item);
        Assert.Contains("[DecimalWire.Number(12, 2)]", price);
        Assert.DoesNotContain("WhenWritingNull", price);
    }

    [Fact]
    public void The_portable_setting_writes_the_canonical_string_and_omits_null_members()
    {
        WriteConfig("\"decimals\": \"string\", \"nullMembers\": \"omit\"");
        var outDir = Generate("generated-portable");
        var item = File.ReadAllText(Path.Combine(outDir, "Item.g.cs"));
        var price = File.ReadAllText(Path.Combine(outDir, "Price.g.cs"));
        Assert.Contains("[DecimalWire.Declared(10, 2)]", item);
        Assert.Contains("[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]", price);
    }

    [Fact]
    public void An_unknown_wire_value_is_refused()
    {
        WriteConfig("\"decimals\": \"number\"");
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, ["entity"], "gen", MetaDir, "--out", Path.Combine(_tmp, "generated-bad"));
        Assert.NotEqual(0, exit);
        Assert.Contains("\"wire.decimals\" must be one of \"native\", \"string\"", stdout + stderr);
    }

    [Fact]
    public void Verify_with_the_wrong_wire_setting_says_the_setting_differs_instead_of_regenerate()
    {
        // Committed under the portable form; then the setting is removed. The default
        // disagrees, and the portable form reproduces the committed output exactly, so verify
        // names the block to declare rather than "regenerate" (that would change the API's JSON).
        WriteConfig("\"decimals\": \"string\", \"nullMembers\": \"omit\"");
        var outDir = Generate("generated-committed");

        WriteConfig(null);
        var (exit, stdout, stderr) = OwnedRunner.Run(
            _tmp, ["entity"], "verify", "--codegen", MetaDir, "--out", outDir, "--namespace", "Acme.Generated");
        var output = stdout + stderr;
        Assert.Equal(1, exit);
        Assert.Contains(
            "The committed output was generated with \"wire\": { \"decimals\": \"string\", \"nullMembers\": \"omit\" }; " +
            "this run used \"wire\": { \"decimals\": \"native\", \"nullMembers\": \"native\" } " +
            "(.metaobjects/config.json; each key defaults to native). Do not regenerate",
            output);
        Assert.Contains(
            "Declare \"wire\": { \"decimals\": \"string\", \"nullMembers\": \"omit\" } in .metaobjects/config.json",
            output);
        Assert.DoesNotContain("Run 'dotnet meta gen' to regenerate", output);
    }
}
