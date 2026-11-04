// EnumLengthConformanceTests — runs the shared cross-port enum-length corpus
// (fixtures/enum-length-conformance/) against the C# port. Each case's `enums` block is
// written to a throwaway project's .metaobjects/config.json and read with NeutralConfig (the
// reader every project-aware load uses), put on the loaded meta.enums.json root, and every
// Ticket enum's column length resolved through EnumLength.ResolveMaxLength. Each `overflow`
// case must be refused with ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH, and each `invalid` block
// refused when the config is read.
using System.Text.Json;
using MetaObjects;
using MetaObjects.Config;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EnumLengthConformanceTests
{
    private static string FixtureDir =>
        Path.Combine(CorpusPaths.RepoRoot(), "fixtures", "enum-length-conformance");

    private static JsonDocument Corpus() => JsonDocument.Parse(File.ReadAllText(Path.Combine(FixtureDir, "cases.json")));

    private static JsonElement Entry(string section, string name)
    {
        using var doc = Corpus();
        return doc.RootElement.GetProperty(section).EnumerateArray()
            .Single(c => c.GetProperty("name").GetString() == name).Clone();
    }

    private static TheoryData<string> Names(string section)
    {
        var data = new TheoryData<string>();
        using var doc = Corpus();
        foreach (var el in doc.RootElement.GetProperty(section).EnumerateArray()) data.Add(el.GetProperty("name").GetString()!);
        return data;
    }

    public static TheoryData<string> CaseNames() => Names("cases");
    public static TheoryData<string> OverflowNames() => Names("overflow");
    public static TheoryData<string> InvalidNames() => Names("invalid");

    /// <summary>Reads <paramref name="enums"/> as a project's config.json `enums` block.</summary>
    private static EnumDefaults ReadEnums(JsonElement enums)
    {
        var dir = Path.Combine(Path.GetTempPath(), "mo-enums-conf-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
        var body = enums.ValueKind == JsonValueKind.Null
            ? """{ "schema_version": 1 }"""
            : $$"""{ "schema_version": 1, "enums": {{enums.GetRawText()}} }""";
        File.WriteAllText(Path.Combine(dir, ".metaobjects", "config.json"), body);
        try
        {
            return NeutralConfig.Read(dir)?.Enums ?? EnumDefaults.Default;
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    private static MetaField TicketField(EnumDefaults defaults, string name)
    {
        var result = new MetaDataLoader().Load([new FileSource(Path.Combine(FixtureDir, "meta.enums.json"))]);
        Assert.True(result.Errors.Count == 0, string.Join("\n", result.Errors.Select(e => $"{e.Code}: {e.Message}")));
        result.Root.EnumDefaults = defaults;
        return result.Root.FindObject("Ticket")!.Fields().Single(f => f.Name == name);
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void Resolves_every_enum_column_length(string name)
    {
        var c = Entry("cases", name);
        var defaults = ReadEnums(c.GetProperty("enums"));
        foreach (var p in c.GetProperty("lengths").EnumerateObject())
        {
            long? expected = p.Value.ValueKind == JsonValueKind.Null ? null : p.Value.GetInt64();
            Assert.Equal(expected, EnumLength.ResolveMaxLength(TicketField(defaults, p.Name)));
        }
    }

    [Theory]
    [MemberData(nameof(OverflowNames))]
    public void Refuses_a_member_longer_than_the_project_default(string name)
    {
        var o = Entry("overflow", name);
        var field = TicketField(ReadEnums(o.GetProperty("enums")), o.GetProperty("field").GetString()!);
        var ex = Assert.Throws<MetaModelException>(() => EnumLength.ResolveMaxLength(field));
        Assert.Equal(ErrorCode.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH, ex.Code);
        Assert.Contains(o.GetProperty("member").GetString()!, ex.Message);
    }

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public void Refuses_an_invalid_enums_block(string name)
    {
        var bad = Entry("invalid", name);
        Assert.Throws<MetaModelException>(() => ReadEnums(bad.GetProperty("enums")));
    }
}
