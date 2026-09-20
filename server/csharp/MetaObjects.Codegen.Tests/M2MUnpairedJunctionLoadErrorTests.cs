// M2MUnpairedJunctionLoadErrorTests — a junction M2MDerivation cannot pair is a LOAD
// ERROR, not a silently-dropped route (the C# half of the five-port pass; mirrors
// codegen-ts's relation-resolver-m2m-unpairable.test.ts, formerly
// relation-resolver-m2m-warn.test.ts).
//
// This file used to be M2MUnpairedJunctionWarnTests and pinned the OPPOSITE contract:
// M2MNavigationBuilder.Build caught M2MDerivationException and reported it through an
// onWarn callback, and the model loaded clean -- the loader's rules never checked
// subject pairing. TypeScript and C# warned and emitted no route; Java, Kotlin and
// Python threw and failed the build -- one input, two contracts, and the quiet arm was
// the dangerous one. Owner ruling 2026-09-20: the MODEL is what is wrong, so it is
// rejected at LOAD in every port (ValidationPasses.ValidateM2MJunctionPairing, rule
// (f) -- it runs this SAME derivation, so the loader and codegen cannot drift apart),
// which is the one answer all five ports already agreed was legitimate for a broken
// model.
//
// So every assertion below is inverted from what it was: this model no longer loads.
// M2MNavigationBuilder.Build's catch survives as unreachable defence-in-depth for a
// root assembled WITHOUT loader validation; nothing that loads through MetaDataLoader
// can reach it (see the comment on that catch).
//
// Both un-pairable corners in one TPH hierarchy, same model as before:
//   - Auth (base) declares "tags", whose junction (AuthTag) reference names the
//     SUBTYPE BridgeAuth, not Auth -- un-pairable on the base's OWN declaration walk;
//   - BridgeAuth (subtype) declares "bridgeTags", whose junction (BridgeAuthTag)
//     reference names the declaring BASE Auth, not BridgeAuth -- the derivation's
//     documented carve-out: the base is neither the declaring nor the navigating
//     entity of that walk, so it doesn't count as a match either.
// Both are reported, independently -- rule (f) is not deduped by declaration like rule
// (d); pairing is a property of the (entity, relationship) pair, not of the
// declaration alone.
using MetaObjects.Loader;
using Xunit;

namespace MetaObjects.Codegen.Tests;

public class M2MUnpairedJunctionLoadErrorTests
{
    private const string Model = """
    { "metadata.root": { "package": "acme::authw", "children": [
      { "object.entity": { "name": "Tag", "children": [
        { "source.rdb": { "@table": "tags_w" } },
        { "field.long": { "name": "id" } },
        { "identity.primary": { "@fields": "id" } }
      ]}},
      { "object.entity": { "name": "Auth", "@discriminator": "type", "children": [
        { "source.rdb": { "@table": "auths_w" } },
        { "field.long": { "name": "id" } },
        { "field.enum": { "name": "type", "@values": ["Bridge"] } },
        { "relationship.association": { "name": "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "AuthTag" } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ]}},
      { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
        { "relationship.association": { "name": "bridgeTags", "@cardinality": "many", "@objectRef": "Tag", "@through": "BridgeAuthTag" } }
      ]}},
      { "object.entity": { "name": "AuthTag", "children": [
        { "source.rdb": { "@table": "auth_tags_w" } },
        { "field.long": { "name": "authId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["authId", "tagId"] } },
        { "identity.reference": { "name": "fkAuth", "@fields": "authId", "@references": "BridgeAuth" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}},
      { "object.entity": { "name": "BridgeAuthTag", "children": [
        { "source.rdb": { "@table": "bridge_auth_tags_w" } },
        { "field.long": { "name": "bridgeAuthId" } },
        { "field.long": { "name": "tagId" } },
        { "identity.primary": { "@fields": ["bridgeAuthId", "tagId"] } },
        { "identity.reference": { "name": "fkAuth", "@fields": "bridgeAuthId", "@references": "Auth" } },
        { "identity.reference": { "name": "fkTag", "@fields": "tagId", "@references": "Tag" } }
      ]}}
    ]}}
    """;

    private static LoadResult Load() =>
        new MetaDataLoader().Load([new InMemoryStringSource(Model, id: "m2m-unpairable.json")]);

    [Fact]
    public void The_base_relationship_is_rejected_naming_the_entity_and_its_junction()
    {
        var result = Load();
        Assert.Contains(result.Errors, e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP);

        var messages = string.Join("\n", result.Errors.Select(e => e.Message));
        // The base's own declaration cannot pair -- the junction's reference names the
        // SUBTYPE (BridgeAuth), not Auth or Tag.
        Assert.Contains("\"Auth.tags\"", messages);
        Assert.Contains("\"AuthTag\"", messages);
        Assert.Contains("must declare one identity.reference to", messages);
    }

    [Fact]
    public void The_subtype_declaration_is_rejected_independently_of_the_base()
    {
        var result = Load();
        var messages = string.Join("\n", result.Errors.Select(e => e.Message));
        // BridgeAuth's OWN declaration cannot pair either -- its junction's reference
        // names the declaring BASE (Auth), not BridgeAuth or Tag. Reported
        // independently of the base's finding above.
        Assert.Contains("\"BridgeAuth.bridgeTags\"", messages);
        Assert.Contains("\"BridgeAuthTag\"", messages);
    }

    [Fact]
    public void A_subtype_deriving_fine_is_not_a_reprieve_for_the_base()
    {
        // BridgeAuth's WALK of the inherited "tags" relationship (source=BridgeAuth)
        // DOES pair -- both subject names (Auth, BridgeAuth) are in the set, and the
        // junction's reference to BridgeAuth matches. That partial success is
        // precisely what let the old defect survive: the route existed under one
        // segment and not the other, and a corpus asserting only the working segment
        // stayed green. A model is not half-valid, so both un-pairable declarations
        // are reported and the whole load fails.
        var result = Load();
        Assert.True(result.Errors.Count(e => e.Code == ErrorCode.ERR_INVALID_RELATIONSHIP) >= 2);
    }
}
