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
}
