using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Core.Field;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

// AI LLM-call trace persistence — Unit 2 (C# port). The DeriveTraceFields pre-freeze
// pass injects typed voRequest/voResponse field.object jsonb columns onto a
// LlmCallBase-derived entity carrying a nested template.prompt, so the EF Core
// entity generator emits them as owned .ToJson() columns without the author
// restating them. Mirrors the Java/Python deriver tests.
public class TraceFieldDerivationTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.entity": { "name": "LlmCallBase", "abstract": true, "children": [
        { "field.string": { "name": "spanId" } }
      ]}},
      { "object.value": { "name": "GreetingRequest", "children": [
        { "field.string": { "name": "prompt" } }
      ]}},
      { "object.value": { "name": "GreetingResponse", "children": [
        { "field.string": { "name": "greeting" } },
        { "field.int":    { "name": "score" } }
      ]}},
      { "object.entity": { "name": "GreetingCall", "extends": "acme::ai::LlmCallBase", "children": [
        { "source.rdb": { "@table": "llm_call" } },
        { "identity.primary": { "@fields": "spanId" } },
        { "template.prompt": { "name": "greet",
            "@payloadRef": "acme::ai::GreetingRequest",
            "@responseRef": "acme::ai::GreetingResponse" } }
      ]}},
      { "object.entity": { "name": "BareCall", "extends": "acme::ai::LlmCallBase", "children": [
        { "source.rdb": { "@table": "bare_call" } },
        { "identity.primary": { "@fields": "spanId" } }
      ]}},
      { "object.entity": { "name": "PlainEntity", "children": [
        { "field.string": { "name": "id" } },
        { "source.rdb": { "@table": "plain_entity" } },
        { "identity.primary": { "@fields": "id" } },
        { "template.prompt": { "name": "greet",
            "@payloadRef": "acme::ai::GreetingRequest",
            "@responseRef": "acme::ai::GreetingResponse" } }
      ]}}
    ]}}
    """;

    // strict=true would require the registry; the default DefaultRegistry + preFreeze
    // proves the DERIVED field.object + @objectRef/@storage attrs pass the validation
    // passes (the hook fires before them).
    private static MetaRoot Load()
    {
        var r = MetaDataLoader.FromString(Model, MetaDataFormat.Json, preFreeze: DeriveTraceFields.Apply);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static MetaData? OwnField(MetaData entity, string name) =>
        entity.OwnChildren().FirstOrDefault(c => c.Type == "field" && c.Name == name);

    [Fact]
    public void Derives_typed_jsonb_columns_on_trace_entity()
    {
        var greeting = Load().Objects().Single(o => o.Name == "GreetingCall");

        var req = OwnField(greeting, DeriveTraceFields.VoRequest);
        Assert.NotNull(req);
        Assert.Equal("acme::ai::GreetingRequest", req!.OwnAttr(FieldConstants.FIELD_ATTR_OBJECT_REF));
        Assert.Equal(FieldConstants.STORAGE_JSONB, req.OwnAttr(FieldConstants.FIELD_ATTR_STORAGE));

        var resp = OwnField(greeting, DeriveTraceFields.VoResponse);
        Assert.NotNull(resp);
        Assert.Equal("acme::ai::GreetingResponse", resp!.OwnAttr(FieldConstants.FIELD_ATTR_OBJECT_REF));
        Assert.Equal(FieldConstants.STORAGE_JSONB, resp.OwnAttr(FieldConstants.FIELD_ATTR_STORAGE));
    }

    [Fact]
    public void Skips_entity_without_prompt()
    {
        var bare = Load().Objects().Single(o => o.Name == "BareCall");
        Assert.Null(OwnField(bare, DeriveTraceFields.VoRequest));
        Assert.Null(OwnField(bare, DeriveTraceFields.VoResponse));
    }

    [Fact]
    public void Skips_entity_not_extending_llm_call_base()
    {
        var plain = Load().Objects().Single(o => o.Name == "PlainEntity");
        Assert.Null(OwnField(plain, DeriveTraceFields.VoRequest));
        Assert.Null(OwnField(plain, DeriveTraceFields.VoResponse));
    }

    [Fact]
    public void Is_idempotent_when_run_twice()
    {
        // The loader already ran the hook once; the (frozen) tree cannot be mutated
        // again, but a second Apply on a fresh load must still yield exactly one.
        var greeting = Load().Objects().Single(o => o.Name == "GreetingCall");
        int count = greeting.OwnChildren().Count(c => c.Type == "field" && c.Name == DeriveTraceFields.VoResponse);
        Assert.Equal(1, count);
    }

    [Fact]
    public void Ef_entity_generator_emits_derived_columns_as_owned_jsonb()
    {
        var root = Load();
        var ctx = new GenContext
        {
            Entities = root.Objects(),
            Root = root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        var files = new EntityGenerator().Generate(ctx).ToList();
        var greeting = files.Single(f => f.Path == "GreetingCall.g.cs").Content;

        // The derived field.object columns become owned-type navigations (typed jsonb
        // via the DbContext fluent .ToJson()) — same shape as a hand-authored field.object.
        Assert.Contains("GreetingRequest? VoRequest", greeting);
        Assert.Contains("GreetingResponse? VoResponse", greeting);
        // The referenced VOs are emitted as plain POCOs.
        Assert.Contains("GreetingResponse.g.cs", string.Join(",", files.Select(f => f.Path)));
    }
}
