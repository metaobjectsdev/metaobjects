import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { findReferenceBetween, findReferencesBetween } from "../src/core/relationship/find-reference.js";
import type { MetaObject } from "../src/core/object/meta-object.js";

// #368 — Match declares two identity.reference children onto the same target
// (Team), with no relationship at all. That's legal (task 3's loader rule only
// gates a `@cardinality: one` relationship, not a bare reference pair), so it
// is exactly the model findReferencesBetween exists to enumerate honestly.
const MODEL = {
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
            { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
          ],
        },
      },
    ],
  },
};

describe("findReferencesBetween (#368)", () => {
  test("returns every reference, not just the first", async () => {
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(MODEL), { id: "meta.repro.json" }),
    ]);
    expect(errors).toEqual([]);
    const match = root.findObject("Match")! as MetaObject;
    const team = root.findObject("Team")! as MetaObject;

    const all = findReferencesBetween(match, team);
    expect(all.map((r) => r.referenceIdentity.name)).toEqual(["homeTeamRef", "awayTeamRef"]);

    // Back-compat: the singular still answers with the first — this is the
    // documented contract public consumers (outside this repo) still get.
    expect(findReferenceBetween(match, team)?.referenceIdentity.name).toBe("homeTeamRef");
  });

  test("singular delegates to the plural's first entry even when there is only one match", async () => {
    const SINGLE = {
      "metadata.root": {
        package: "repro2",
        children: [
          { "object.entity": { name: "Team", children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
          ] } },
          { "object.entity": { name: "Match", children: [
            { "field.int": { name: "id" } },
            { "field.int": { name: "teamId" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
            { "identity.reference": { name: "teamRef", "@fields": ["teamId"], "@references": "Team" } },
          ] } },
        ],
      },
    };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(SINGLE), { id: "meta.repro2.json" }),
    ]);
    expect(errors).toEqual([]);
    const match = root.findObject("Match")! as MetaObject;
    const team = root.findObject("Team")! as MetaObject;

    expect(findReferencesBetween(match, team).map((r) => r.referenceIdentity.name)).toEqual(["teamRef"]);
    expect(findReferenceBetween(match, team)?.referenceIdentity.name).toBe("teamRef");
  });

  test("returns empty/undefined when neither side references the other", async () => {
    const NONE = {
      "metadata.root": {
        package: "repro3",
        children: [
          { "object.entity": { name: "Team", children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
          ] } },
          { "object.entity": { name: "Stadium", children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
          ] } },
        ],
      },
    };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(NONE), { id: "meta.repro3.json" }),
    ]);
    expect(errors).toEqual([]);
    const team = root.findObject("Team")! as MetaObject;
    const stadium = root.findObject("Stadium")! as MetaObject;

    expect(findReferencesBetween(team, stadium)).toEqual([]);
    expect(findReferenceBetween(team, stadium)).toBeUndefined();
  });
});
