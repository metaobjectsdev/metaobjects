// #368 — an entity may declare more than one identity.reference onto the SAME
// target entity (Match -> Team twice, via homeTeamRef/awayTeamRef). REST
// runtime's resolveRelationDescriptor (relation-resolver.ts) had the same
// defect Task 4 fixed in codegen: findReferenceFkField(holder, targetName)
// walked the holder's identity.reference children and returned the FIRST
// whose @references matched the target, so every relation traversal onto that
// target read the SAME FK column — one relation's lazy load / include would
// silently return the wrong rows via the generated REST API.
//
// Two cases:
//  - one-side: a relationship declared ON the entity holding both FKs
//    (Match.homeTeam / Match.awayTeam) must each read its own FK.
//  - many-side: the inverse traversal (Team -> Match) resolves the FK that
//    lives on the OTHER entity (Match); that lookup must also disambiguate by
//    the matched relationship, not just take the first identity.reference.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { resolveRelationDescriptor } from "../src/relation-resolver.js";

// One-side model: mirrors Task 4's codegen-ts repro exactly (proven to load
// clean — both relationships name-pair with their own identity.reference).
const ONE_SIDE_MODEL = {
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
    ],
  },
};

// Many-side model: same shape, but the identity.reference children are
// declared in the OPPOSITE order from the relationship children — awayTeamRef
// appears before homeTeamRef, while the homeTeam relationship (the first
// cardinality:one relationship on Match targeting Team) still appears first.
// Name-pairing is order-independent, so this loads exactly as cleanly as
// ONE_SIDE_MODEL. It exists to separate "first identity.reference
// structurally" (the #368 defect) from "the identity.reference that actually
// name-pairs with the matched relationship" (the fix) — with the same
// declaration order as ONE_SIDE_MODEL the two happen to coincide and the bug
// would go unnoticed on the many-side path.
const MANY_SIDE_MODEL = {
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
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
      ] } },
    ],
  },
};

async function load(model: unknown): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.repro.json" }),
  ]);
  expect(errors).toEqual([]);
  return root;
}

describe("resolveRelationDescriptor with two references onto one target (#368)", () => {
  test("one-side: each relation reads its own FK field", async () => {
    const root = await load(ONE_SIDE_MODEL);
    const match = root.findObject("Match")!;
    expect(resolveRelationDescriptor(match, "homeTeam", root).sourceField).toBe("homeTeamId");
    expect(resolveRelationDescriptor(match, "awayTeam", root).sourceField).toBe("awayTeamId"); // was "homeTeamId"
  });

  test("many-side: the inverse traversal resolves the FK of the matched relationship, not the first reference", async () => {
    const root = await load(MANY_SIDE_MODEL);
    const team = root.findObject("Team")!;
    // Team's only reachable inverse name is "matches" (inversePluralName is
    // keyed on the OTHER entity's name, not per-relationship), which resolves
    // to Match's first cardinality:one relationship targeting Team — homeTeam.
    // Structurally, awayTeamRef is declared before homeTeamRef in Match's
    // children, so the pre-#368 "first identity.reference" lookup would
    // return awayTeamId here even though the matched relationship is homeTeam.
    const desc = resolveRelationDescriptor(team, "matches", root);
    expect(desc.cardinality).toBe("many");
    expect(desc.targetEntityName).toBe("Match");
    expect(desc.targetField).toBe("homeTeamId"); // was "awayTeamId"
  });
});
