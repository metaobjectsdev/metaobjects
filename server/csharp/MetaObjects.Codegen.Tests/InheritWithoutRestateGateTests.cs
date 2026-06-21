using System.Linq;
using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Codegen.Tests;

/// <summary>
/// Regression gate for #56 (the ADR-0029 identity edge): an identity that inherits
/// @fields via node-level <c>extends</c> without restating it must resolve those fields
/// via the EFFECTIVE accessor. <see cref="MetaIdentity.Fields"/> reads <c>Attr</c>, not
/// <c>OwnAttr</c>; before that fix the inherited @fields was invisible → empty key → no PK.
/// Parity with the TS pk-resolver gate.
/// </summary>
public class InheritWithoutRestateGateTests
{
    private const string Model = """
    { "metadata.root": { "package": "test", "children": [
      { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "primary", "@fields": ["id"], "@generation": "increment" } }
      ] } },
      { "object.entity": { "name": "Widget", "children": [
        { "source.rdb": { "@table": "widgets" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "primary", "extends": "test::BaseEntity.primary" } }
      ] } }
    ] } }
    """;

    [Fact]
    public void Inherited_identity_fields_resolve_via_effective_accessor()
    {
        var root = new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "g.json")]).Root;
        var widget = root.Objects().First(o => o.Name == "Widget");
        var primary = widget.PrimaryIdentity();
        Assert.NotNull(primary);
        Assert.Equal(new[] { "id" }, primary!.Fields);
    }
}
