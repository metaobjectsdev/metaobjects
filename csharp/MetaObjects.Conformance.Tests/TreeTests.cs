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

    [Fact]
    public void Attr_inheritance_own_wins_on_conflict()
    {
        // Super has "color"=blue and "size"=large.
        var sup = Obj("entity", "Super");
        sup.SetAttr("color", "blue");
        sup.SetAttr("size", "large");

        // Sub overrides "color" with "red" and adds "weight"=5.
        var sub = Obj("entity", "Sub");
        sub.SetAttr("color", "red");
        sub.SetAttr("weight", 5);
        sub.SetSuperResolved(sup);

        sup.Freeze();
        sub.Freeze();

        // Effective (own + inherited), own wins on "color".
        Assert.Equal("red", sub.Attr("color"));
        Assert.Equal("large", sub.Attr("size"));
        Assert.Equal(5, sub.Attr("weight"));
        Assert.True(sub.HasAttr("color"));
        Assert.True(sub.HasAttr("size"));
        Assert.True(sub.HasAttr("weight"));

        // Own-only: sees "color" and "weight" but NOT "size".
        Assert.Equal("red", sub.OwnAttr("color"));
        Assert.Null(sub.OwnAttr("size"));
        Assert.Equal(5, sub.OwnAttr("weight"));
        Assert.True(sub.OwnHasAttr("color"));
        Assert.False(sub.OwnHasAttr("size"));
        Assert.True(sub.OwnHasAttr("weight"));
    }

    [Fact]
    public void Three_level_chain_children_appear_super_first()
    {
        var grandparent = Obj("entity", "Grandparent");
        grandparent.AddChild(Fld("long", "gpField"));

        var parent = Obj("entity", "Parent");
        parent.AddChild(Fld("string", "pField"));
        parent.SetSuperResolved(grandparent);

        var child = Obj("entity", "Child");
        child.AddChild(Fld("bool", "cField"));
        child.SetSuperResolved(parent);

        grandparent.Freeze();
        parent.Freeze();
        child.Freeze();

        var names = child.Children().Select(c => c.Name).ToArray();
        Assert.Equal(new[] { "gpField", "pField", "cField" }, names);
    }

    [Fact]
    public void Freeze_is_idempotent()
    {
        var o = Obj("entity", "X");
        o.Freeze();
        // Second call must not throw.
        var ex = Record.Exception(() => o.Freeze());
        Assert.Null(ex);
        Assert.True(o.IsFrozen());
    }
}
