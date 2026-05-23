using MetaObjects;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

/// <summary>
/// identity.reference (FR-003) accessors: @references parsing (bare entity vs
/// dotted Entity.field[,field]) and @enforce default.
/// </summary>
public class IdentityReferenceTests
{
    private const string Model = """
    { "metadata.root": { "package": "t", "children": [
      { "object.entity": { "name": "Author", "children": [
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "authorId" } },
        { "field.long": { "name": "orgId" } },
        { "identity.primary": { "@fields": "id" } },
        { "identity.reference": { "name": "refBare", "@fields": "authorId", "@references": "Org" } },
        { "identity.reference": { "name": "refDotted", "@fields": "orgId", "@references": "Org.id", "@enforce": false } }
      ]}},
      { "object.entity": { "name": "Org", "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}}
    ]}}
    """;

    private static MetaObject Author()
    {
        var r = new MetaDataLoader().Load([new InMemorySource(Model, id: "ref.json")]);
        Assert.Empty(r.Errors);
        return r.Root.FindObject("Author")!;
    }

    [Fact]
    public void Reference_identities_parse_target_fields_and_enforce()
    {
        var refs = Author().ReferenceIdentities();
        Assert.Equal(2, refs.Count);

        var bare = refs.Single(r => r.Name == "refBare");
        Assert.Equal("Org", bare.TargetEntity);
        Assert.Empty(bare.TargetFields);                 // bare -> target's primary identity
        Assert.True(bare.Enforce);                       // default true
        Assert.Equal(["authorId"], bare.Fields);         // local FK column

        var dotted = refs.Single(r => r.Name == "refDotted");
        Assert.Equal("Org", dotted.TargetEntity);
        Assert.Equal(["id"], dotted.TargetFields);       // explicit target field
        Assert.False(dotted.Enforce);                    // @enforce: false -> logical-only
    }
}
