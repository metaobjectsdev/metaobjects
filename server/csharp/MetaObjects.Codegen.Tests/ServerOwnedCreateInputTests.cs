// ServerOwnedCreateInputTests — a generated create hands storage ONLY what the client may set.
// The HTTP behaviour is gated by the api-contract corpus (`input-server-owned-dropped`,
// `tph-input-server-owned-dropped`, secret-fields); this pins the emission: the generated key,
// the TPH discriminator and the M:N navigations are reset before `Add`, and a readOnly field of
// EVERY shape (including a TPH subtype's own) is declared with a private setter.

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class ServerOwnedCreateInputTests
{
    private const string PlainModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Post", "children": [
        { "source.rdb":       { "@table": "posts" } },
        { "field.long":       { "name": "id" } },
        { "field.string":     { "name": "title", "@maxLength": 100 } },
        { "field.string":     { "name": "role", "@maxLength": 20, "@mutability": "readOnly" } },
        { "field.enum":       { "name": "stage", "@values": ["Draft", "Live"], "@mutability": "readOnly" } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb":       { "@table": "tags" } },
        { "field.long":       { "name": "id" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "PostTag", "children": [
        { "source.rdb":       { "@table": "post_tags" } },
        { "field.long":       { "name": "postId" } },
        { "field.long":       { "name": "tagId" } },
        { "identity.primary": { "@fields": ["postId", "tagId"] } },
        { "identity.reference": { "name": "fkPost", "@fields": "postId", "@references": "Post" } },
        { "identity.reference": { "name": "fkTag",  "@fields": "tagId",  "@references": "Tag" } }
      ]}}
    ]}}
    """;

    private const string AssignedKeyModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Code", "children": [
        { "source.rdb":       { "@table": "codes" } },
        { "field.string":     { "name": "id", "@maxLength": 20 } },
        { "identity.primary": { "@fields": "id", "@generation": "assigned" } }
      ]}}
    ]}}
    """;

    private const string TphModel = """
    { "metadata.root": { "package": "acme::input", "children": [
      { "object.entity": { "name": "Thing", "@discriminator": "kind", "children": [
        { "source.rdb":       { "@table": "things" } },
        { "field.long":       { "name": "id" } },
        { "field.enum":       { "name": "kind", "@values": ["A", "B"] } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "AThing", "extends": "Thing", "@discriminatorValue": "A", "children": [
        { "field.string": { "name": "note", "@maxLength": 20 } },
        { "field.string": { "name": "grade", "@maxLength": 20, "@mutability": "readOnly" } }
      ]}},
      { "object.entity": { "name": "BThing", "extends": "Thing", "@discriminatorValue": "B", "children": [
        { "field.int": { "name": "qty" } }
      ]}}
    ]}}
    """;

    private static string Emit(string model, string generator, string file)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "input.json")]);
        Assert.Empty(r.Errors);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(),
            Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated", ColumnNamingStrategy = ColumnNamingStrategy.Literal },
        };
        IGenerator g = generator == "routes" ? new RoutesGenerator() : new EntityGenerator();
        return g.Generate(ctx).Single(f => f.Path == file).Content;
    }

    [Fact]
    public void Create_resets_a_generated_key_and_empties_navigations_before_Add()
    {
        var src = Emit(PlainModel, "routes", "PostRoutes.g.cs");
        var post = src[src.IndexOf("app.MapPost(", StringComparison.Ordinal)..];
        var reset = post.IndexOf("input.Id = default!;", StringComparison.Ordinal);
        var tags = post.IndexOf("input.Tags = new System.Collections.Generic.List<Tag>();", StringComparison.Ordinal);
        var add = post.IndexOf("db.Posts.Add(input);", StringComparison.Ordinal);
        Assert.True(reset >= 0 && tags >= 0 && add > reset && add > tags, post);
    }

    [Fact]
    public void An_assigned_key_is_the_callers_and_is_not_reset()
    {
        var src = Emit(AssignedKeyModel, "routes", "CodeRoutes.g.cs");
        Assert.DoesNotContain("input.Id = default!;", src);
        Assert.DoesNotContain("Server-owned", src);
    }

    [Fact]
    public void A_readOnly_field_of_every_shape_has_a_private_setter()
    {
        var src = Emit(PlainModel, "entity", "Post.g.cs");
        Assert.Contains("Role { get; private set; }", src);
        Assert.Contains("Stage { get; private set; }", src);
        Assert.Contains("Title { get; set; }", src);
    }

    [Fact]
    public void A_tph_subtype_readOnly_field_has_a_private_setter()
    {
        var src = Emit(TphModel, "entity", "AThing.g.cs");
        Assert.Contains("Grade { get; private set; }", src);
        Assert.Contains("Note { get; set; }", src);
    }

    [Fact]
    public void Tph_subtype_create_resets_the_key_and_pins_the_discriminator_to_the_route_subtype()
    {
        var src = Emit(TphModel, "routes", "ThingRoutes.g.cs");
        var start = src.IndexOf("app.MapPost(prefix + \"/things/a\"", StringComparison.Ordinal);
        var end = src.IndexOf("app.MapPost(prefix + \"/things/b\"", StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start, src);
        var a = src[start..end];
        Assert.Contains("input.Id = default!;", a);
        Assert.Contains("input.Kind = default!;", a);
        Assert.True(a.IndexOf("input.Kind = default!;", StringComparison.Ordinal) < a.IndexOf(".Add(input);", StringComparison.Ordinal), a);
    }
}
