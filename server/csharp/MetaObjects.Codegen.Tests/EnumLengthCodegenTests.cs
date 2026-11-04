// A string-stored enum with a column length (its @maxLength, else the project's
// enums.maxLength — EnumLength.ResolveMaxLength) maps with HasMaxLength(n), the VARCHAR(n)
// `meta migrate` creates; with none, the mapping is unchanged.
using MetaObjects.Codegen.Generators;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class EnumLengthCodegenTests
{
    private static string DbContextFor(string statusAttrs, long? projectDefault = null)
    {
        var model = $$$"""
        { "metadata.root": { "package": "acme", "children": [
          { "object.entity": { "name": "Ticket", "children": [
            { "source.rdb": { "@table": "tickets" } },
            { "field.long": { "name": "id" } },
            { "field.enum": { "name": "status", "@values": ["OPEN", "CLOSED"]{{{statusAttrs}}} } },
            { "identity.primary": { "@fields": "id" } }
          ]}}
        ]}}
        """;
        var r = new MetaDataLoader().Load([new InMemoryStringSource(model, id: "enum-length.json")]);
        Assert.Empty(r.Errors);
        if (projectDefault is { } d) r.Root.EnumDefaults = new EnumDefaults(d);
        var ctx = new GenContext
        {
            Entities = r.Root.Objects(), Root = r.Root,
            Config = new GenConfig { OutDir = "/tmp", Namespace = "Acme.Generated" },
        };
        return new DbContextGenerator().Generate(ctx).Single().Content;
    }

    [Fact]
    public void An_enum_with_maxLength_maps_with_that_length()
    {
        Assert.Contains("HasConversion<string>().HasMaxLength(16);", DbContextFor(""", "@maxLength": 16"""));
    }

    [Fact]
    public void The_project_default_sizes_an_enum_with_no_maxLength()
    {
        Assert.Contains("HasConversion<string>().HasMaxLength(24);", DbContextFor("", projectDefault: 24));
    }

    [Fact]
    public void No_length_anywhere_leaves_the_mapping_unchanged()
    {
        var dbContext = DbContextFor("");
        Assert.Contains("HasConversion<string>();", dbContext);
        Assert.DoesNotContain("HasMaxLength", dbContext);
    }
}
