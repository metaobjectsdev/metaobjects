// ApiConfigConformanceTests — runs the shared cross-port `api` config corpus
// (fixtures/api-contract-conformance/api-settings/config-blocks.json) against the C# config reader
// (MetaObjects.Config.NeutralConfig, the reader every project-aware load goes through). Every
// `cases[]` block resolves to the corpus's values; every `invalid` block is refused when read.
using System.Text.Json;
using MetaObjects.Config;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ApiConfigConformanceTests
{
    private static string CasesPath => Path.Combine(
        CorpusPaths.RepoRoot(), "fixtures", "api-contract-conformance", "api-settings", "config-blocks.json");

    private static JsonElement Section(string name) =>
        JsonDocument.Parse(File.ReadAllText(CasesPath)).RootElement.GetProperty(name);

    private static TheoryData<string> Names(string section)
    {
        var data = new TheoryData<string>();
        foreach (var el in Section(section).EnumerateArray()) data.Add(el.GetProperty("name").GetString()!);
        return data;
    }

    public static TheoryData<string> CaseNames() => Names("cases");
    public static TheoryData<string> InvalidNames() => Names("invalid");

    private static JsonElement Named(string section, string name) =>
        Section(section).EnumerateArray().Single(e => e.GetProperty("name").GetString() == name);

    private static ApiSettings ReadApi(JsonElement api)
    {
        var dir = Directory.CreateTempSubdirectory("mo-api-conf-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
            var body = api.ValueKind == JsonValueKind.Null
                ? """{ "schema_version": 1 }"""
                : $$"""{ "schema_version": 1, "api": {{api.GetRawText()}} }""";
            File.WriteAllText(Path.Combine(dir, ".metaobjects", "config.json"), body);
            return NeutralConfig.Read(dir, validateNaming: false)!.Api;
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Theory]
    [MemberData(nameof(CaseNames))]
    public void A_valid_block_resolves_to_the_corpus_values(string name)
    {
        var c = Named("cases", name);
        var api = ReadApi(c.GetProperty("api"));
        var want = c.GetProperty("pagination");
        if (want.ValueKind == JsonValueKind.Null) Assert.Null(api.Pagination);
        else
            Assert.Equal(
                new ApiPagination(want.GetProperty("defaultLimit").GetInt32(), want.GetProperty("maxLimit").GetInt32()),
                api.Pagination);
        var mode = c.GetProperty("unknownFields").GetString() == "drop" ? UnknownFieldsMode.Drop : UnknownFieldsMode.Reject;
        Assert.Equal(mode, api.UnknownFields);
    }

    [Theory]
    [MemberData(nameof(InvalidNames))]
    public void An_invalid_block_is_refused_when_read(string name) =>
        Assert.Throws<MetaModelException>(() => ReadApi(Named("invalid", name).GetProperty("api")));
}
