// `api` in .metaobjects/config.json: the config reader's rules, and what the routes generator emits
// for each setting. The behaviour itself (status and body over HTTP) is proven by the api-contract
// lanes in MetaObjects.IntegrationTests (core, tph, api-settings).

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Codegen.Runtime;
using Microsoft.AspNetCore.Http;
using System.Text.Json;
using MetaObjects.Config;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ApiSettingsTests
{
    private static ApiSettings Read(string configJson)
    {
        var dir = Directory.CreateTempSubdirectory("mo-api-settings-").FullName;
        try
        {
            Directory.CreateDirectory(Path.Combine(dir, ".metaobjects"));
            File.WriteAllText(Path.Combine(dir, ".metaobjects", "config.json"), configJson);
            return NeutralConfig.Read(dir)!.Api;
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public void No_api_block_is_no_page_size_and_reject()
    {
        var api = Read("""{ "schema_version": 1 }""");
        Assert.Null(api.Pagination);
        Assert.Equal(UnknownFieldsMode.Reject, api.UnknownFields);
    }

    [Fact]
    public void A_full_block_is_read()
    {
        var api = Read("""{ "schema_version": 1, "api": { "pagination": { "defaultLimit": 50, "maxLimit": 1000 }, "unknownFields": "drop" } }""");
        Assert.Equal(new ApiPagination(50, 1000), api.Pagination);
        Assert.Equal(UnknownFieldsMode.Drop, api.UnknownFields);
    }

    [Theory]
    [InlineData("""{ "schema_version": 1, "api": { "pagination": { "defaultLimit": 0, "maxLimit": 10 } } }""", "\"api.pagination.defaultLimit\" must be a positive integer")]
    [InlineData("""{ "schema_version": 1, "api": { "pagination": { "defaultLimit": 5, "maxLimit": 2.5 } } }""", "\"api.pagination.maxLimit\" must be a positive integer")]
    [InlineData("""{ "schema_version": 1, "api": { "pagination": { "defaultLimit": 5 } } }""", "\"api.pagination.maxLimit\" must be a positive integer")]
    [InlineData("""{ "schema_version": 1, "api": { "pagination": { "defaultLimit": 20, "maxLimit": 10 } } }""", "\"api.pagination.defaultLimit\" must not exceed \"api.pagination.maxLimit\"")]
    [InlineData("""{ "schema_version": 1, "api": { "unknownFields": "ignore" } }""", "\"api.unknownFields\" must be \"reject\" or \"drop\"")]
    public void A_bad_block_is_a_load_error_naming_the_key(string config, string message)
    {
        var e = Assert.Throws<MetaModelException>(() => Read(config));
        Assert.True(e.Message.Contains(message), e.Message);
    }

    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Post", "children": [
        { "source.rdb": { "@table": "posts" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "title", "@required": true } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static string Routes(ApiSettings? api)
    {
        var load = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "model.json")]);
        Assert.Empty(load.Errors);
        if (api is not null) load.Root.Api = api;
        var ctx = new GenContext
        {
            Entities = load.Root.Objects(),
            Root = load.Root,
            Config = new GenConfig { OutDir = "/unused", Namespace = "Acme" },
        };
        return Assert.Single(new RoutesGenerator().Generate(ctx)).Content;
    }

    [Fact]
    public void Absent_settings_emit_the_unknown_field_check_and_no_page_size()
    {
        var src = Routes(null);
        Assert.Contains("UnknownFieldCheck.Reject(", src);
        Assert.DoesNotContain("limit_too_large", src);
    }

    [Fact]
    public void Drop_emits_no_unknown_field_check_and_a_page_size_is_emitted_when_set()
    {
        var src = Routes(new ApiSettings(new ApiPagination(2, 4), UnknownFieldsMode.Drop));
        Assert.DoesNotContain("UnknownFieldCheck", src);
        Assert.DoesNotContain("KnownFields", src);
        Assert.Contains("limit_too_large", src);
        Assert.Contains("var __take = 2;", src);
    }

    [Fact]
    public void Unknown_keys_are_listed_once_each_in_code_point_order()
    {
        // U+FF5E < U+1F600 by code point; StringComparer.Ordinal (UTF-16 units) puts the emoji first.
        using var doc = JsonDocument.Parse("{\"\\ud83d\\ude00\": 1, \"\\uff5e\": 2, \"a\": 3, \"title\": 4}");
        var result = UnknownFieldCheck.Reject(doc.RootElement, new HashSet<string> { "title" });
        var value = Assert.IsAssignableFrom<IValueHttpResult>(result).Value;
        var body = JsonSerializer.SerializeToElement(value);
        Assert.Equal("unknown_fields", body.GetProperty("error").GetString());
        Assert.Equal(
            new[] { "a", "\uff5e", "\ud83d\ude00" },
            body.GetProperty("fields").EnumerateArray().Select(e => e.GetString()).ToArray());
        Assert.Equal(400, Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode);
    }

    [Fact]
    public void A_body_that_is_not_an_object_or_has_only_declared_keys_is_not_refused()
    {
        var known = new HashSet<string> { "id", "title" };
        using var array = JsonDocument.Parse("[1, 2]");
        using var declared = JsonDocument.Parse("{\"id\": 9, \"title\": \"x\"}");
        Assert.Null(UnknownFieldCheck.Reject(array.RootElement, known));
        Assert.Null(UnknownFieldCheck.Reject(declared.RootElement, known));
    }
}
