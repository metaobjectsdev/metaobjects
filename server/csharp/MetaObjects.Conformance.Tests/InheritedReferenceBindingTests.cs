// ADR-0059 R3/R7 — an attribute inherited through `extends` means what it meant where it was
// written. A root-level base writes `Customer` bare; the entity inheriting it from package
// `acme` (which has its own `Customer`) must still bind the ROOT `Customer`.

using MetaObjects.Loader;
using MetaObjects.Meta;
using Xunit;
using static MetaObjects.Core.Identity.IdentityConstants;
using static MetaObjects.Core.Relationship.RelationshipConstants;

namespace MetaObjects.Conformance.Tests;

public class InheritedReferenceBindingTests
{
    private const string AcmeFile = """
    { "metadata.root": { "package": "acme", "children": [
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "acme_customers" } },
        { "field.string": { "name": "code" } },
        { "identity.primary": { "name": "id", "@fields": "code" } }
      ]}},
      { "object.entity": { "name": "Order", "extends": "::BaseOrder", "children": [
        { "source.rdb": { "@table": "orders" } }
      ]}}
    ]}}
    """;

    private const string RootFile = """
    { "metadata.root": { "children": [
      { "object.entity": { "name": "Customer", "children": [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "BaseOrder", "abstract": true, "children": [
        { "field.long": { "name": "id" } },
        { "field.long": { "name": "customerId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { "name": "customerRef", "@fields": "customerId", "@references": "Customer" } },
        { "relationship.association": { "name": "customer", "@cardinality": "one", "@objectRef": "Customer" } }
      ]}}
    ]}}
    """;

    private static MetaRoot Load()
    {
        var result = new MetaDataLoader().Load(
        [
            new InMemoryStringSource(AcmeFile, id: "meta.acme.json"),
            new InMemoryStringSource(RootFile, id: "meta.root.json"),
        ]);
        Assert.Empty(result.Errors);
        return result.Root;
    }

    [Fact]
    public void Inherited_relationship_and_reference_bind_the_root_object_not_the_inheritors_package()
    {
        var root = Load();
        var order = Assert.Single(root.Objects(), o => o.ResolutionKey() == "acme::Order");

        var rel = Assert.Single(order.Relationships(), r => r.Name == "customer");
        var reference = Assert.Single(order.ReferenceIdentities(), r => r.Name == "customerRef");

        var relTarget = NamingRefs.RefTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF);
        var refTarget = NamingRefs.RefTarget(reference, IDENTITY_REFERENCE_ATTR_REFERENCES);
        Assert.Equal("Customer", relTarget?.ResolutionKey());
        Assert.Equal("Customer", refTarget?.ResolutionKey());
        Assert.Equal("customers", ((MetaObject)relTarget!).DbTable);

        Assert.Equal("Customer", NamingRefs.LookupCanonical(root, (string)rel.Attr(RELATIONSHIP_ATTR_OBJECT_REF)!)?.ResolutionKey());
        Assert.Equal("Customer", NamingRefs.LookupCanonical(root, (string)reference.Attr(IDENTITY_REFERENCE_ATTR_REFERENCES)!)?.ResolutionKey());

        Assert.Same(relTarget, NamingRefs.RefTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF));
        Assert.Equal("acme::Customer", Assert.Single(root.Objects(), o => o.ResolutionKey() == "acme::Customer").ResolutionKey());
    }
}
