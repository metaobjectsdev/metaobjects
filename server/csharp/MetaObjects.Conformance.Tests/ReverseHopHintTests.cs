// rc.21 (U9): the first @via hop from a projection's base entity already walks an
// identity.reference backwards, under the holder's collection name. An author who guesses the
// name (the reference's own name, a plural a @collectionName overrides) is now told the name the
// rule gives: the refusal lists the reverse hops onto the entity.

using MetaObjects;
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class ReverseHopHintTests
{
    private static LoadResult Load(string via, string? collectionName = null) =>
        new MetaDataLoader(FullCoreRegistry.Compose(), strict: true).Load([new InMemoryStringSource($$"""
        { "metadata.root": { "package": "acme::orders", "children": [
          { "object.entity": { "name": "Order", "children": [
            { "source.rdb": { "@table": "orders" } },
            { "field.int": { "name": "id" } }, { "field.int": { "name": "statusId" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } } ] } },
          { "object.entity": { "name": "OrderEvent", {{(collectionName is null ? "" : $"\"@collectionName\": \"{collectionName}\",")}} "children": [
            { "source.rdb": { "@table": "order_events" } },
            { "field.int": { "name": "id" } }, { "field.int": { "name": "orderId" } }, { "field.int": { "name": "statusId" } },
            { "field.timestamp": { "name": "createdDate" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
            { "identity.reference": { "name": "orderId", "@fields": "orderId", "@references": "Order" } } ] } },
          { "object.projection": { "name": "OrderView", "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_case" } },
            { "field.int": { "name": "id", "extends": "Order.id" } },
            { "field.int": { "name": "statusId", "extends": "Order.statusId" } },
            { "field.timestamp": { "name": "statusDate", "children": [ { "origin.aggregate": { "@via": "{{via}}", "@of": "OrderEvent.createdDate",
                "@agg": "min", "@filter": { "statusId": { "eq": { "field": "statusId" } } } } } ] } },
            { "identity.primary": { "name": "id", "extends": "Order.id" } } ] } } ] } }
        """, id: "cases.json")]);

    [Fact]
    public void The_first_hop_walks_the_reference_backwards_under_the_collection_name()
    {
        Assert.Empty(Load("Order.orderEvent", collectionName: "OrderEvent").Errors);
    }

    [Fact]
    public void A_guessed_hop_name_is_refused_naming_the_reverse_hops()
    {
        var error = Assert.Single(Load("Order.histories", collectionName: "OrderEvent").Errors);
        Assert.Equal(ErrorCode.ERR_INVALID_ORIGIN, error.Code);
        Assert.Contains("The reverse hops from Order are: \"orderEvent\" (walks OrderEvent.orderId backwards)", error.Message);
    }
}
