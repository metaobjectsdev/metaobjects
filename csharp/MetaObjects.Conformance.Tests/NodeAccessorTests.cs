using MetaObjects;
using MetaObjects.Meta;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class NodeAccessorTests
{
    [Fact]
    public void MetaObject_exposes_fields_own_and_effective_and_primary_identity()
    {
        var bas = new MetaObject(new TypeId("object", "entity"), "Base");
        bas.AddChild(new MetaField(new TypeId("field", "long"), "id"));
        var sub = new MetaObject(new TypeId("object", "entity"), "Sub");
        sub.AddChild(new MetaField(new TypeId("field", "string"), "email"));
        sub.AddChild(new MetaPrimaryIdentity(new TypeId("identity", "primary"), "pk"));
        sub.SetSuperResolved(bas);
        bas.Freeze(); sub.Freeze();

        Assert.Equal(new[] { "id", "email" }, sub.Fields().Select(f => f.Name).ToArray());
        Assert.Equal(new[] { "email" }, sub.OwnFields().Select(f => f.Name).ToArray());
        Assert.Equal("email", sub.FindField("email")!.Name);
        Assert.Equal("primary", sub.PrimaryIdentity()!.SubType);
    }

    [Fact]
    public void MetaField_IsRequired_true_when_validator_required_child_present()
    {
        var field = new MetaField(new TypeId("field", "string"), "email");
        var validator = new MetaRequiredValidator(new TypeId("validator", "required"), "req");
        field.AddChild(validator);
        field.Freeze();

        Assert.True(field.IsRequired);
        Assert.Single(field.Validators());
        Assert.True(field.Validators()[0].IsRequired());
    }

    [Fact]
    public void MetaField_IsRequired_false_when_no_validators()
    {
        var field = new MetaField(new TypeId("field", "string"), "name");
        field.Freeze();

        Assert.False(field.IsRequired);
        Assert.Empty(field.Validators());
    }

    [Fact]
    public void MetaRoot_Objects_returns_all_and_FindObject_locates_by_name()
    {
        var root = new MetaRoot(new TypeId("metadata", "root"), "root");
        var objA = new MetaObject(new TypeId("object", "entity"), "User");
        var objB = new MetaObject(new TypeId("object", "entity"), "Order");
        root.AddChild(objA);
        root.AddChild(objB);
        objA.Freeze(); objB.Freeze(); root.Freeze();

        var objects = root.Objects();
        Assert.Equal(2, objects.Count);
        Assert.Contains(objects, o => o.Name == "User");
        Assert.Contains(objects, o => o.Name == "Order");

        Assert.Equal("User", root.FindObject("User")!.Name);
        Assert.Null(root.FindObject("Missing"));
    }
}
