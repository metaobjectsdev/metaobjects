// A junction whose identity.reference names a CONCRETE SUBTYPE of the declaring
// entity used to load clean — the loader's relationship rules checked that a
// junction declares TWO references, never what they point at. deriveM2MFields'
// subject set is only {declaring entity, navigating entity}, so for every
// resolver outside that set the derivation threw and buildM2mEntry returned
// null: the mount silently vanished, the same ABSENCE class FW-8 is. Concretely,
// Auth declaring `bridgeTags` while the junction's reference names BridgeAuth
// left the navigation on BridgeAuth only — /auths/:id/bridgeTags would 404 with
// nothing said.
//
// This file used to pin the SKIP, on the reasoning that a model which loads must
// keep building, so the contract was visibility (a warn callback) rather than
// failure. That reasoning is retired: the ports never agreed on it. TypeScript
// and C# warned and emitted no route, while Java, Kotlin and Python threw and
// failed the build — one input, two contracts, and the quiet arm was the
// dangerous one. Owner ruling 2026-09-20: the MODEL is what is wrong, so it is
// rejected at LOAD in every port (validation-passes rule (f),
// `validateM2MJunctionPairing`), which is the one answer all five already agreed
// was legitimate for a broken model.
//
// So the assertion below is inverted from what it was: this model no longer
// loads. buildRelationMap's catch survives as unreachable defence-in-depth for a
// root assembled without loader validation; nothing that loads can reach it.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const MODEL = {
  "metadata.root": {
    package: "repro",
    children: [
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "relationship.association": { name: "bridgeTags", "@cardinality": "many",
            "@objectRef": "Tag", "@through": "AuthTag" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge", children: [] } },
      { "object.entity": { name: "Tag", children: [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "AuthTag", children: [
        { "source.rdb": { "@table": "auth_tags" } },
        { "field.long": { name: "authId", "@required": true } },
        { "field.long": { name: "tagId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["authId", "tagId"] } },
        { "identity.reference": { name: "fkAuth", "@fields": "authId", "@references": "BridgeAuth" } },
        { "identity.reference": { name: "fkTag", "@fields": "tagId", "@references": "Tag" } },
      ] } },
    ],
  },
};

async function load() {
  return new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "m2m-warn.json" }),
  ]);
}

describe("un-pairable M:N junction is a LOAD ERROR, not a silent skip", () => {
  test("the model is rejected, naming the entity, the relationship and the junction", async () => {
    const res = await load();
    const codes = res.errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_INVALID_RELATIONSHIP");

    const msg = res.errors.map((e) => e.message).join("\n");
    // The navigating entity whose traversal would have vanished...
    expect(msg).toContain('"Auth.bridgeTags"');
    // ...the junction that cannot be paired...
    expect(msg).toContain('"AuthTag"');
    // ...and the derivation's own reason, so the author is told WHICH reference
    // is missing rather than just that something is wrong.
    expect(msg).toContain("must declare one identity.reference to");
  });

  test("the subtype deriving fine is not a reprieve — the model still fails", async () => {
    // BridgeAuth IS in the junction's reference set, so navigating from it always
    // derived cleanly. That partial success is precisely what made the defect
    // survive: the route existed under one segment and not the other, and a
    // corpus asserting only the working segment stayed green. A model is not
    // half-valid, so one unpairable subject fails the whole load.
    const res = await load();
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
