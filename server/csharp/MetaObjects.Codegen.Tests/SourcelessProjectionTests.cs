using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// #271 — a projection with NO <c>source.*</c> anywhere in its super chain is not
/// backed by any store, so the DB-bound generators must cleanly emit NOTHING for it:
/// no DbSet, no model configuration, no FK finders, no write routes.
///
/// This is the shape #210 makes common (a prompt payload becomes a sourceless
/// projection). The gate is already honored — persistability derives from source
/// presence, not object subtype (#248's contract) — but nothing pinned it, so a
/// future edit to any of these predicates could silently start emitting
/// table-assuming artifacts for an object that has no table. The failure mode is
/// not a clean error: it is a DbSet over a type EF has no mapping for.
/// </summary>
public class SourcelessProjectionTests
{
    // Author is an ordinary sourced entity. AuthorPayload is a projection that reuses
    // Author's field SHAPE via field-level `extends` — which carries field properties,
    // NOT object children — so it inherits no source and is genuinely sourceless.
    // (Object-level `extends` to an entity is illegal for a projection: FR-024/ADR-0028.)
    private const string Model = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Author", "children": [
        { "source.rdb": { "@kind": "table", "@table": "authors" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true } },
        { "identity.primary": { "name": "pk", "@fields": "id" } }
      ]}},
      { "object.projection": { "name": "AuthorPayload", "children": [
        { "field.string": { "name": "name", "extends": "acme::Author.name" } },
        { "field.string": { "name": "summary" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "sourceless.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    [Fact]
    public void Sourceless_projection_carries_no_source_and_no_view()
    {
        var root = Load();
        var payload = root.FindObject("AuthorPayload")!;

        Assert.Empty(payload.Sources());          // resolving — nothing inherited either
        Assert.Null(payload.DbView);
        Assert.False(payload.IsReadOnlyProjection());
        Assert.False(payload.IsWriteThrough());
    }

    [Fact]
    public void Sourceless_projection_is_excluded_from_the_DbContext()
    {
        var root = Load();
        var payload = root.FindObject("AuthorPayload")!;
        var author = root.FindObject("Author")!;

        // The sourced entity still applies — this is the no-churn half of the assertion.
        Assert.True(DbContextGenerator.AppliesTo(author, root));
        Assert.False(DbContextGenerator.AppliesTo(payload, root));
    }

    [Fact]
    public void DbContext_emits_no_DbSet_for_a_sourceless_projection()
    {
        var root = Load();
        var files = new DbContextGenerator().Generate(Ctx(root));
        var src = string.Concat(files.Select(f => f.Content));

        Assert.Contains("DbSet<Author>", src);       // the sourced entity is mapped
        Assert.DoesNotContain("AuthorPayload", src); // the sourceless projection is not
    }
}
