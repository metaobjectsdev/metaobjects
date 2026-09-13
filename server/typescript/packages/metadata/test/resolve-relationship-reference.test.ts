import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import {
  referenceCandidatesFor,
  resolveRelationshipReference,
} from "../src/core/relationship/resolve-relationship-reference.js";
import type { MetaObject } from "../src/core/object/meta-object.js";

const MATCH_MODEL = {
  "metadata.root": {
    package: "repro",
    children: [
      {
        "object.entity": {
          name: "Team",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          children: [
            { "field.int": { name: "id" } },
            { "field.int": { name: "homeTeamId" } },
            { "field.int": { name: "awayTeamId" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
            { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
            { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
            { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
            { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } },
          ],
        },
      },
    ],
  },
};

async function loadMatch(): Promise<MetaObject> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MATCH_MODEL), { id: "meta.repro.json" }),
  ]);
  expect(errors).toEqual([]);
  return root.findObject("Match")!;
}

describe("resolveRelationshipReference", () => {
  test("enumerates every candidate reference for the target", async () => {
    const candidates = referenceCandidatesFor(await loadMatch(), "Team");
    expect(candidates.map((r) => r.name)).toEqual(["homeTeamRef", "awayTeamRef"]);
  });

  test("name pairing resolves each association to its own reference", async () => {
    const match = await loadMatch();
    expect(resolveRelationshipReference(match, "homeTeam", "Team")?.name).toBe("homeTeamRef");
    expect(resolveRelationshipReference(match, "awayTeam", "Team")?.name).toBe("awayTeamRef");
  });

  test("@sourceRefField wins over name pairing", async () => {
    const match = await loadMatch();
    expect(
      resolveRelationshipReference(match, "homeTeam", "Team", "awayTeamId")?.name,
    ).toBe("awayTeamRef");
  });

  test("a single candidate resolves regardless of name", async () => {
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "repro",
            children: [
              { "object.entity": { name: "Team", children: [
                { "field.int": { name: "id" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
              ] } },
              { "object.entity": { name: "Match", children: [
                { "field.int": { name: "id" } },
                { "field.int": { name: "winnerFk" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
                { "identity.reference": { name: "anythingAtAll", "@fields": ["winnerFk"], "@references": "Team" } },
                { "relationship.association": { name: "champion", "@objectRef": "Team", "@cardinality": "one" } },
              ] } },
            ],
          },
        }),
        { id: "meta.repro.json" },
      ),
    ]);
    expect(errors).toEqual([]);
    const match = root.findObject("Match")!;
    expect(resolveRelationshipReference(match, "champion", "Team")?.name).toBe("anythingAtAll");
  });

  test("unpairable names return undefined rather than guessing", async () => {
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "repro",
            children: [
              { "object.entity": { name: "Team", children: [
                { "field.int": { name: "id" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
              ] } },
              { "object.entity": { name: "Match", children: [
                { "field.int": { name: "id" } },
                { "field.int": { name: "alphaFk" } },
                { "field.int": { name: "betaFk" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
                { "identity.reference": { name: "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
                { "identity.reference": { name: "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
                { "relationship.association": { name: "winner", "@objectRef": "Team", "@cardinality": "one" } },
              ] } },
            ],
          },
        }),
        { id: "meta.repro.json" },
      ),
    ]);
    expect(errors).toEqual([]);
    const match = root.findObject("Match")!;
    expect(resolveRelationshipReference(match, "winner", "Team")).toBeUndefined();
  });

  test("suffix stripping never applies to the relationship name", async () => {
    // "valid" must NOT be stripped to "val" and pair with valRef.
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "repro",
            children: [
              { "object.entity": { name: "Team", children: [
                { "field.int": { name: "id" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
              ] } },
              { "object.entity": { name: "Match", children: [
                { "field.int": { name: "id" } },
                { "field.int": { name: "valFk" } },
                { "field.int": { name: "otherFk" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
                { "identity.reference": { name: "valRef", "@fields": ["valFk"], "@references": "Team" } },
                { "identity.reference": { name: "otherRef", "@fields": ["otherFk"], "@references": "Team" } },
                { "relationship.association": { name: "valid", "@objectRef": "Team", "@cardinality": "one" } },
              ] } },
            ],
          },
        }),
        { id: "meta.repro.json" },
      ),
    ]);
    expect(errors).toEqual([]);
    const match = root.findObject("Match")!;
    expect(resolveRelationshipReference(match, "valid", "Team")).toBeUndefined();
  });
});
