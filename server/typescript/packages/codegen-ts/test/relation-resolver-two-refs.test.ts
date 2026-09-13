// #368 — an entity may declare two identity.reference nodes onto the same
// target entity (Match -> Team twice, via homeTeamRef/awayTeamRef). A
// `@cardinality: one` relationship names only its target, so
// `refs.find(r => target matches)` picked the FIRST identity.reference for
// every such relationship — every association joined on the same FK column.
// It compiles, typechecks, and the DDL is correct; the only symptom is wrong
// rows. This proves buildRelationMap resolves each association to its OWN
// reference: the implicit name-pairing case (the bug report) and an explicit
// `@sourceRefField` case (names that do not pair, so only the declared field
// can disambiguate).

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

const MODEL = {
  "metadata.root": {
    package: "repro",
    children: [
      { "object.entity": { name: "Team", children: [
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Match", children: [
        { "field.int": { name: "id" } },
        { "field.int": { name: "homeTeamId" } },
        { "field.int": { name: "awayTeamId" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
      ] } },
      // Names that do NOT pair with either reference's name/FK field, so the
      // relationship can only be resolved via an explicit @sourceRefField —
      // proving that declaration reaches codegen and is not just tested at
      // the metadata layer (Task 1).
      { "object.entity": { name: "Player", children: [
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Game", children: [
        { "field.int": { name: "id" } },
        { "field.int": { name: "p1Id" } },
        { "field.int": { name: "p2Id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "p1Ref", "@fields": ["p1Id"], "@references": "Player" } },
        { "identity.reference": { name: "p2Ref", "@fields": ["p2Id"], "@references": "Player" } },
        { "relationship.association": { name: "winner", "@objectRef": "Player", "@cardinality": "one", "@sourceRefField": "p1Id" } },
        { "relationship.association": { name: "loser", "@objectRef": "Player", "@cardinality": "one", "@sourceRefField": "p2Id" } },
      ] } },
    ],
  },
};

async function loadRoot(): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "meta.repro.json" }),
  ]);
  expect(errors).toEqual([]);
  return root;
}

describe("buildRelationMap with two references onto one target (#368)", () => {
  test("each association joins on its own FK column (name pairing)", async () => {
    const root = await loadRoot();
    const relations = buildRelationMap(root).get("Match")!;
    const byName = Object.fromEntries(relations.map((r) => [r.name, r.fkField]));
    expect(byName.homeTeam).toBe("homeTeamId");
    expect(byName.awayTeam).toBe("awayTeamId"); // was "homeTeamId" — the #368 defect
  });

  test("an explicit @sourceRefField also resolves to its own FK column", async () => {
    const root = await loadRoot();
    const relations = buildRelationMap(root).get("Game")!;
    const byName = Object.fromEntries(relations.map((r) => [r.name, r.fkField]));
    expect(byName.winner).toBe("p1Id");
    expect(byName.loser).toBe("p2Id");
  });
});
