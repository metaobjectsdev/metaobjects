// ADR-0023 — strict-load attr-schema Check-0 exemption parity.
//
// Mirrors the TS reference (attr-schema-validate.ts): under strict load an own
// @-attr declared by no provider is ERR_UNKNOWN_ATTR, EXCEPT a materialized
// attr.properties node — a sanctioned, registered property-bag subtype whose
// arbitrary NAME is the contract. A plain typo'd @-attr still fails.

using MetaObjects.Loader;
using MetaObjects.Source;
using Xunit;

namespace MetaObjects.Conformance.Tests;

public class StrictAttrExemptionTests
{
    private static LoadResult LoadStrict(string json)
    {
        var registry = Provider.ComposeRegistry(new[] { CoreTypes.CoreTypesProvider });
        var loader = new MetaDataLoader(registry, strict: true);
        return loader.Load(new IMetaDataSource[]
        {
            new InMemoryStringSource(json, format: MetaDataFormat.Json, id: "meta.test.json"),
        });
    }

    // A structural attr.properties child carries an arbitrary author-chosen name
    // ("config") that is intentionally not declared by any per-type schema. Under
    // strict load it MUST be exempt from ERR_UNKNOWN_ATTR.
    [Fact]
    public void AttrProperties_is_exempt_from_strict_unknown_attr()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Subscriber",
                  "children": [
                    { "field.long": { "name": "id" } },
                    { "identity.primary": { "@fields": ["id"] } },
                    { "attr.properties": {
                        "name": "config",
                        "value": { "owner": "growth", "tier": "gold" } } }
                  ] } }
            ] } }
        """;

        var result = LoadStrict(json);

        Assert.DoesNotContain(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_ATTR);
    }

    // A plain inline @-attr that matches no provider is a made-up attribute and
    // MUST still fail under strict — the exemption is the `properties` subtype only.
    [Fact]
    public void Typoed_inline_attr_still_fails_strict()
    {
        const string json = """
        { "metadata.root": {
            "package": "acme",
            "children": [
              { "object.entity": {
                  "name": "Subscriber",
                  "children": [
                    { "field.long": { "name": "id", "@madeUpAttr": "nope" } },
                    { "identity.primary": { "@fields": ["id"] } }
                  ] } }
            ] } }
        """;

        var result = LoadStrict(json);

        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_UNKNOWN_ATTR);
    }
}
