using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class TreeTests
{
    private static MetaObject Obj(string subType, string name) => new(new TypeId("object", subType), name);
    private static MetaField Fld(string subType, string name) => new(new TypeId("field", subType), name);

    [Fact]
    public void Effective_children_include_super_chain_with_own_shadowing()
    {
        var bas = Obj("entity", "Base");
        bas.AddChild(Fld("long", "id"));
        var sub = Obj("entity", "Sub");
        sub.AddChild(Fld("string", "email"));
        sub.SetSuperResolved(bas);
        bas.Freeze(); sub.Freeze();

        var names = sub.Children().Select(c => c.Name).ToArray();
        Assert.Equal(new[] { "id", "email" }, names);
        Assert.Equal(new[] { "email" }, sub.OwnChildren().Select(c => c.Name).ToArray());
    }

    [Fact]
    public void Freeze_blocks_mutation()
    {
        var o = Obj("entity", "X");
        o.Freeze();
        Assert.Throws<System.InvalidOperationException>(() => o.AddChild(Fld("int", "n")));
    }
}
