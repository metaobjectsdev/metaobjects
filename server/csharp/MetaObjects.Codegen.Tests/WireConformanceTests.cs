// WireConformanceTests — runs the shared cross-port wire-setting corpus
// (fixtures/wire-conformance/config-blocks.json, ADR-0019 Amendment 2) against the C# port.
//
// Each `cases[]` entry is the `wire` block of a project's `.metaobjects/config.json`. This test
// writes exactly that file to a throwaway project directory and parses it with the C# config
// reader (MetaObjects.Config.NeutralConfig, the same reader every project-aware load goes
// through). Each `invalid` block must be refused when the config is read.
using System.Text.Json;
using MetaObjects.Config;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class WireConformanceTests
{
    private static string CasesPath =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "wire-conformance", "config-blocks.json");

    private static JsonElement Section(string name) =>
        JsonDocument.Parse(File.ReadAllText(CasesPath)).RootElement.GetProperty(name);

    public static TheoryData<string> CaseNames()
    {
        var data = new TheoryData<string>();
        foreach (var el in Section("cases").EnumerateArray()) data.Add(el.GetProperty("name").GetString()!);
        return data;
    }

    public static TheoryData<string> InvalidNames()
    {
        var data = new TheoryData<string>();
        foreach (var el in Section("invalid").EnumerateArray()) data.Add(el.GetProperty("name").GetString()!);
        return data;
    }

    private static JsonElement Named(string section, string name) =>
        Section(section).EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);

    /// <summary>
    /// Writes a throwaway project's <c>.metaobjects/config.json</c> carrying <paramref name="wire"/>
    /// (no <c>wire</c> key at all when it is JSON null) and parses it with <see cref="NeutralConfig.Read"/>.
    /// </summary>
    private static WireFormat ReadWire(JsonElement wire)
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-wire-conf-" + Guid.NewGuid().ToString("N"));
        var cfgDir = Path.Combine(dir, ".metaobjects");
        Directory.CreateDirectory(cfgDir);
        var body = wire.ValueKind == JsonValueKind.Null
            ? """{ "schema_version": 1 }"""
            : $$"""{ "schema_version": 1, "wire": {{wire.GetRawText()}} }""";
        File.WriteAllText(Path.Combine(cfgDir, "config.json"), body);
        try
        {
            return NeutralConfig.Read(dir)?.Wire ?? WireFormat.Default;
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Resolves_each_wire_block(string name)
    {
        var c = Named("cases", name);
        var wire = ReadWire(c.GetProperty("wire"));
        Assert.Equal(c.GetProperty("decimals").GetString(), WireFormat.Spelling(wire.Decimals));
        Assert.Equal(c.GetProperty("nullMembers").GetString(), WireFormat.Spelling(wire.NullMembers));
    }

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public void Refuses_invalid_wire_blocks(string name)
    {
        var ex = Assert.Throws<MetaModelException>(() => ReadWire(Named("invalid", name).GetProperty("wire")));
        Assert.Equal(ErrorCode.ERR_BAD_ATTR_VALUE, ex.Code);
        Assert.Contains("\"wire", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_project_without_the_setting_loads_with_the_native_default()
    {
        Assert.Equal(new WireFormat(DecimalWireForm.Native, NullMemberForm.Native), WireFormat.Default);
        var r = new MetaObjects.Loader.MetaDataLoader().Load([new MetaObjects.Loader.InMemoryStringSource(
            """{ "metadata.root": { "package": "acme", "children": [] } }""", id: "empty.json")]);
        Assert.Equal(WireFormat.Default, r.Root.WireFormat);
    }
}
