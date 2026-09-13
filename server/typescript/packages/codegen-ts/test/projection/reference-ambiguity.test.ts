import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";

// #368 — an entity may legally declare more than one identity.reference onto
// the same target (e.g. Match.homeTeamRef/awayTeamRef both -> Team). The
// loader's ambiguity gate (validateOneSideReferenceResolution) only fires for
// a `@cardinality: one` relationship node — a bare identity.reference pair or
// an origin.first correlation reaches codegen unvalidated, so extract-view-spec
// itself must refuse to silently guess. These tests are the regression
// coverage: a fix-round-1 review found the first cut of the throw was blind to
// an explicit @via hop's own name (it re-derived candidates by target entity
// alone even when the hop already named an exact reference or a disambiguated
// relationship), which made the throw's own suggested remedy impossible to
// satisfy. Test 1 is that regression test.
async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

const TEAM = {
  "object.entity": {
    name: "Team",
    children: [
      { "source.rdb": { "@table": "teams" } },
      { "field.int": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      // Lets the loader's single-hop-@via inference succeed for origin.first
      // below (exactly one relationship Team -> Match) — it does not affect
      // the reference-count ambiguity check, which reads identity.reference
      // declarations directly and ignores relationships entirely.
      { "relationship.association": { name: "matches", "@objectRef": "Match", "@cardinality": "many" } },
    ],
  },
};

function matchEntity(extraChildren: unknown[] = []) {
  return {
    "object.entity": {
      name: "Match",
      children: [
        { "source.rdb": { "@table": "matches" } },
        { "field.int": { name: "id" } },
        { "field.int": { name: "homeTeamId" } },
        { "field.int": { name: "awayTeamId" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": "homeTeamId", "@references": "Team" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": "awayTeamId", "@references": "Team" } },
        ...extraChildren,
      ],
    },
  };
}

describe("extractViewSpec — reference ambiguity (#368)", () => {
  test("an explicit @via naming one of two references to the same target resolves to THAT one, not the first", async () => {
    // Regression test for fix-round-1 finding 1: before the fix, this threw
    // "ambiguous: homeTeamRef, awayTeamRef" even though the author already
    // disambiguated by naming the exact reference in @via.
    const root = await load([
      TEAM,
      matchEntity(),
      {
        "object.projection": {
          name: "MatchView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_match" } },
            { "field.int": { name: "id", extends: "Match.id" } },
            { "identity.primary": { name: "id", extends: "Match.id" } },
            {
              "field.string": {
                name: "away_team_name",
                children: [
                  {
                    "origin.passthrough": {
                      "@from": "Team.name",
                      // Names the exact reference, not the ambiguous target alone.
                      "@via": "Match.awayTeamRef",
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "MatchView")!;
    const spec = extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });

    expect(spec.joinTree.joins.length).toBe(1);
    const join = spec.joinTree.joins[0]!;
    expect(join.relationship).toBe("awayTeamRef");
    expect(join.targetEntity).toBe("test::Team");
    // The disambiguating proof: the FK column matches the NAMED reference
    // (away_team_id), never the declaration-order-first one (home_team_id).
    expect(join.fkColumn).toBe("away_team_id");

    const awayTeamName = spec.selectSpec.columns.find((c) => c.fieldName === "away_team_name");
    expect(awayTeamName).toBeDefined();
  });

  test("a cardinality:many relationship hop whose candidates live on the target side throws naming both", async () => {
    // A `@cardinality: "one"` relationship with an unresolvable candidate set
    // is rejected by the LOADER itself (Task 3's validateOneSideReferenceResolution
    // rule (e)) before codegen ever runs — so it cannot be used to exercise this
    // throw. `@cardinality: "many"` is NOT gated by that rule (finding 2), so
    // Team.matches loads fine even though Match holds two references back to
    // Team. resolveRelationshipReference correctly reports zero candidates on
    // the holder (Team) side — the FK physically lives on Match — and
    // resolveHopReference falls back to findReferencesBetween, which walks
    // both sides and finds both.
    const root = await load([
      TEAM,
      matchEntity(),
      {
        "object.projection": {
          name: "TeamSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_team_summary" } },
            { "field.int": { name: "id", extends: "Team.id" } },
            { "identity.primary": { name: "id", extends: "Team.id" } },
            {
              "field.int": {
                name: "matchCount",
                children: [
                  { "origin.aggregate": { "@agg": "count", "@of": "Match.id", "@via": "Team.matches" } },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "TeamSummary")!;
    expect(() => extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" })).toThrow(
      /projection join hop "matches".*is ambiguous:.*homeTeamRef.*awayTeamRef/s,
    );
  });

  test("origin.first correlation with two references and no relationship throws naming both", async () => {
    const root = await load([
      TEAM,
      matchEntity(),
      {
        "object.projection": {
          name: "TeamSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_team_summary" } },
            { "field.int": { name: "id", extends: "Team.id" } },
            { "identity.primary": { name: "id", extends: "Team.id" } },
            {
              "field.int": {
                name: "lastMatchId",
                children: [
                  {
                    "origin.first": {
                      "@of": "Match.id",
                      "@orderBy": ["id:desc"],
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "TeamSummary")!;
    expect(() => extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" })).toThrow(
      /origin\.first correlation from "Team" to "Match" is ambiguous:.*homeTeamRef.*awayTeamRef/s,
    );
  });
});
