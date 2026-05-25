using MetaObjects;
using MetaObjects.Codegen;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Payload-VO + render-handle codegen tests. Mirrors
/// typescript/packages/codegen-ts/test/payload-codegen.test.ts (asserts the
/// emitted C# source; compilation + render of the output is the Phase 3 demo).
/// </summary>
public class PayloadCodegenTests
{
    // PostBrief; AuthorBrief { displayName, postCount, posts: PostBrief[] via collection };
    // contentStrategyPrompt template over AuthorBrief.
    private const string Model = """
    {
      "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": { "name": "PostBrief", "children": [
            { "field.string": { "name": "title" } }
          ]}},
          { "object.value": { "name": "AuthorBrief", "children": [
            { "field.string": { "name": "displayName" } },
            { "field.int": { "name": "postCount" } },
            { "field.object": { "name": "posts", "isArray": true, "@objectRef": "PostBrief",
              "children": [ { "origin.collection": { "@via": "Author.posts" } } ] } }
          ]}},
          { "template.prompt": { "name": "contentStrategyPrompt",
            "@payloadRef": "AuthorBrief", "@textRef": "prompt/strategy", "@format": "xml" } }
        ]
      }
    }
    """;

    private static MetaRoot Load()
    {
        var result = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "codegen.json")]);
        Assert.Empty(result.Errors);
        return result.Root;
    }

    [Fact]
    public void Emits_payload_record_with_scalar_and_nested_array_fields()
    {
        var src = PayloadCodegen.GeneratePayloadRecords(Load(), "AuthorBrief");
        Assert.Contains("public sealed record AuthorBrief", src);
        Assert.Contains("public required string displayName { get; init; }", src);
        Assert.Contains("public required int postCount { get; init; }", src);
        Assert.Contains("public required IReadOnlyList<PostBrief> posts { get; init; }", src);
        Assert.Contains("public sealed record PostBrief", src);
        Assert.Contains("public required string title { get; init; }", src);
    }

    [Fact]
    public void Emits_render_handle_binding_textRef_and_format()
    {
        var src = PayloadCodegen.GenerateRenderHandle(Load(), "contentStrategyPrompt");
        Assert.Contains("public static string RenderContentStrategyPrompt(AuthorBrief payload, IProvider provider)", src);
        Assert.Contains("Ref = \"prompt/strategy\"", src);
        Assert.Contains("Format = \"xml\"", src);
        Assert.Contains("using MetaObjects.Render;", src);
    }
}
