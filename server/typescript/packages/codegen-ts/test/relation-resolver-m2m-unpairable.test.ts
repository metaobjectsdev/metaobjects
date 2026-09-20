// A junction whose identity.reference names a CONCRETE SUBTYPE of the declaring
// entity loads clean — the loader's relationship rules never check subject pairing —
// but deriveM2MFields' subject set is only {declaring entity, navigating entity}, so
// for every resolver outside that set the derivation throws and buildM2mEntry returns
// null: the mount silently vanishes, the same ABSENCE class FW-8 is. Concretely, Auth
// declaring `bridgeTags` while the junction's reference names BridgeAuth leaves the
// navigation on BridgeAuth only — /auths/:id/bridgeTags would 404 with nothing said.
//
// The skip is deliberate (a model that loads must keep building), so the contract is
// visibility, not failure: buildRelationMap takes a warn callback and reports every
// un-pairable junction with the derivation's own reason.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

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

async function load(): Promise<MetaRoot> {
  const res = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "m2m-warn.json" }),
  ]);
  // The premise of the defect: nothing about this model fails the loader.
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("buildRelationMap — un-pairable M:N junction is reported, not silent", () => {
  test("the map still builds, the subtype keeps its navigation, and the skip warns", async () => {
    const root = await load();
    const warnings: string[] = [];
    const map = buildRelationMap(root, (m) => warnings.push(m));

    // The declaring entity's side is skipped, never fatal.
    expect((map.get("Auth") ?? []).find((e) => e.name === "bridgeTags")).toBeUndefined();
    // The subtype the junction names still derives its own navigation.
    const sub = (map.get("BridgeAuth") ?? []).find((e) => e.name === "bridgeTags");
    expect(sub?.junctionEntity).toBe("AuthTag");
    expect(sub?.sourceJoinField).toBe("authId");
    expect(sub?.targetJoinField).toBe("tagId");

    // Exactly one warning, naming the entity, the relationship, the junction and the
    // derivation's own reason.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('"Auth"');
    expect(warnings[0]).toContain('"bridgeTags"');
    expect(warnings[0]).toContain('"AuthTag"');
    expect(warnings[0]).toContain("must declare one identity.reference to");
  });

  test("without a callback the silent skip is the pre-existing behaviour", async () => {
    const root = await load();
    expect(() => buildRelationMap(root)).not.toThrow();
    expect((buildRelationMap(root).get("Auth") ?? []).find((e) => e.name === "bridgeTags")).toBeUndefined();
  });
});
