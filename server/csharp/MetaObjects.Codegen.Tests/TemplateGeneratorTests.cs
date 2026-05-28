// Coverage for the C# TemplateGenerator factory — mirrors
// server/typescript/packages/codegen-ts/test/generators/template-generator.test.ts
// and server/python/tests/codegen/test_template_generator.py.

using MetaObjects;
using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Meta;
using MetaObjects.Render;
using Xunit;
using static MetaObjects.Shared.BaseTypes;
using static MetaObjects.Shared.Structural;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Core.Object.ObjectConstants;

namespace MetaObjects.Codegen.Tests;

public class TemplateGeneratorTests
{
    private static MetaRoot BuildRoot()
    {
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "test");
        var post = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
        post.AddChild(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
        post.AddChild(new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
        root.AddChild(post);
        root.Freeze();
        return root;
    }

    private static GenContext MakeCtx(MetaRoot root) => new()
    {
        Entities = root.Objects(),
        Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void PerEntityWalkEmitsOneFilePerEntity()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/hello"] = "Hello {{name}}!\n",
        });
        var root = BuildRoot();
        var gen = TemplateGenerator.Create(
            name: "hello",
            template: "custom/hello",
            provider: provider,
            walk: r => r.Objects().Select(e =>
                new TemplateWalkResult(new { name = e.Name }, $"{e.Name}.txt")));
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.Single(files);
        Assert.Equal("Post.txt", files[0].Path);
        Assert.Equal("Hello Post!\n", files[0].Content);
    }

    [Fact]
    public void AggregatorWalkEmitsSingleFileFromAllEntities()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/index"] = "Entities:\n{{#entities}}- {{name}}\n{{/entities}}",
        });
        var root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "test");
        root.AddChild(new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post"));
        root.AddChild(new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Comment"));
        root.Freeze();

        var gen = TemplateGenerator.Create(
            name: "index",
            template: "custom/index",
            provider: provider,
            walk: r => new[]
            {
                new TemplateWalkResult(
                    new { entities = r.Objects().Select(e => new { name = e.Name }).ToList() },
                    "index.txt"),
            });
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.Single(files);
        Assert.Equal("index.txt", files[0].Path);
        Assert.Equal("Entities:\n- Post\n- Comment\n", files[0].Content);
    }

    [Fact]
    public void FormatTextDoesNotEscapeHtml()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/raw"] = "{{snippet}}\n",
        });
        var root = BuildRoot();
        var gen = TemplateGenerator.Create(
            name: "raw-text",
            template: "custom/raw",
            provider: provider,
            format: "text",
            walk: _ => new[]
            {
                new TemplateWalkResult(new { snippet = "<p>hi</p>" }, "out.txt"),
            });
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.Equal("<p>hi</p>\n", files[0].Content);
    }

    [Fact]
    public void FormatHtmlEscapesHtmlInPayload()
    {
        var provider = new InMemoryProvider(new Dictionary<string, string>
        {
            ["custom/raw"] = "{{snippet}}\n",
        });
        var root = BuildRoot();
        var gen = TemplateGenerator.Create(
            name: "raw-html",
            template: "custom/raw",
            provider: provider,
            format: "html",
            walk: _ => new[]
            {
                new TemplateWalkResult(new { snippet = "<p>hi</p>" }, "out.html"),
            });
        var files = gen.Generate(MakeCtx(root)).ToList();
        Assert.NotEqual("<p>hi</p>\n", files[0].Content);
        Assert.True(files[0].Content.Contains("&lt;") || files[0].Content.Contains("&#60;"));
    }
}
