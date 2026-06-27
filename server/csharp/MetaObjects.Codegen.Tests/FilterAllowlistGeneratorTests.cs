// FilterAllowlistGeneratorTests — exercises FR-009 codegen behavior of
// FilterAllowlistGenerator across the three load-bearing cases:
//
//  - Empty allowlist when no field carries @filterable: true.
//  - Per-subtype operator gating (string vs numeric vs boolean).
//  - View-kind / projection entity skipped (read-only — no filter routes).

using MetaObjects.Codegen;
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class FilterAllowlistGeneratorTests
{
    private static GenContext Ctx(MetaRoot root) => new()
    {
        Entities = root.Objects(), Root = root,
        Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
    };

    private static MetaRoot Load(string model)
    {
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "gen.json")]);
        Assert.Empty(r.Errors);
        return r.Root;
    }

    [Fact]
    public void Empty_allowlist_when_no_filterable_fields()
    {
        // No field marks @filterable — Fields {} + OpsByField {} so the
        // generated routes can unconditionally call FilterParser.Parse.
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Author", "children": [
            { "source.rdb": { "@table": "authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var file = Assert.Single(new FilterAllowlistGenerator().Generate(Ctx(Load(model))));
        Assert.Equal("AuthorFilterAllowlist.g.cs", file.Path);
        var src = file.Content;
        // Field set is the empty initializer block.
        Assert.Contains("public static readonly HashSet<string> Fields = new(System.StringComparer.Ordinal)", src);
        Assert.Contains("public static readonly Dictionary<string, HashSet<string>> OpsByField", src);
        // No field strings of any kind in the emitted source.
        Assert.DoesNotContain("\"name\"", src);
        Assert.DoesNotContain("\"id\"", src);
    }

    [Fact]
    public void Per_subtype_operator_gating_string_vs_numeric()
    {
        // string  → eq, ne, in, like, isNull
        // numeric → eq, ne, gt, gte, lt, lte, in, isNull   (gt/gte/lt/lte absent on string)
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Author", "children": [
            { "source.rdb": { "@table": "authors" } },
            { "field.long":   { "name": "id",   "@filterable": true } },
            { "field.string": { "name": "name", "@filterable": true } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new FilterAllowlistGenerator().Generate(Ctx(Load(model)))).Content;

        // Both fields appear in Fields.
        Assert.Contains("\"id\",", src);
        Assert.Contains("\"name\",", src);

        // String operators on name: eq, ne, in, like, isNull (no gt/gte/lt/lte).
        Assert.Contains("[\"name\"] = new(System.StringComparer.Ordinal) { \"eq\", \"ne\", \"in\", \"like\", \"isNull\" }", src);

        // Numeric operators on id include the four ordering ops.
        Assert.Contains("[\"id\"] = new(System.StringComparer.Ordinal) { \"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\" }", src);
    }

    [Fact]
    public void Per_subtype_operator_gating_uuid_and_currency()
    {
        // SP-H Unit9 — uuid: eq, ne, in, isNull (no like, no ordering);
        //              currency: numeric band (orderable money in minor units).
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.uuid":     { "name": "ref",   "@filterable": true } },
            { "field.currency": { "name": "total", "@currency": "USD", "@filterable": true } },
            { "identity.primary": { "@fields": "ref" } }
          ]}}
        ]}}
        """;
        var src = Assert.Single(new FilterAllowlistGenerator().Generate(Ctx(Load(model)))).Content;

        Assert.Contains("\"ref\",", src);
        Assert.Contains("\"total\",", src);
        // uuid — identity-comparison only, no like.
        Assert.Contains("[\"ref\"] = new(System.StringComparer.Ordinal) { \"eq\", \"ne\", \"in\", \"isNull\" }", src);
        // currency — numeric ops.
        Assert.Contains("[\"total\"] = new(System.StringComparer.Ordinal) { \"eq\", \"ne\", \"gt\", \"gte\", \"lt\", \"lte\", \"in\", \"isNull\" }", src);
    }

    [Fact]
    public void View_kind_projection_entity_gets_no_allowlist()
    {
        // A read-only projection (source.rdb @kind=view) is filtered out by
        // FilterAllowlistGenerator — projections aren't writable, the routes
        // generator emits read-only routes, and filtering view-kind queries
        // is out of scope (G3 in the routes-generator gap list).
        const string model = """
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Author", "children": [
            { "source.rdb": { "@table": "authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@filterable": true } },
            { "identity.primary": { "@fields": "id" } }
          ]}},
          { "object.projection": { "name": "AuthorView", "children": [
            { "source.rdb": { "@kind": "view", "@table": "v_authors" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } }
          ]}}
        ]}}
        """;
        // Only the writable Author entity gets an allowlist file; the
        // projection AuthorView is skipped.
        var files = new FilterAllowlistGenerator().Generate(Ctx(Load(model))).ToList();
        var file = Assert.Single(files);
        Assert.Equal("AuthorFilterAllowlist.g.cs", file.Path);
    }
}
