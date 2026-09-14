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

  test("the ambiguity message never recommends @sourceRefField as a fix (it is a dead end for this hop)", async () => {
    // #368 round 2 (fix round 1): Team owns ZERO identity.reference children of
    // its own here, so resolveRelationshipReference's ladder (which only ever
    // consults the HOP'S OWN entity's candidates) had nothing to work with —
    // @sourceRefField could not have mattered regardless of @cardinality, since
    // it also only ever consults the same own-side candidate set. The message
    // must say THAT (not assert a @cardinality value it can't guarantee is the
    // reason in every shape reaching this throw — see the "reverse @cardinality
    // one" test below for a shape where the @cardinality *is* "one"), and name
    // the two remedies that ARE legal: remove the extra identity.reference, or
    // restructure the model.
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
    let message = "";
    try {
      extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
      throw new Error("expected extractViewSpec to throw the ambiguity error");
    } catch (err) {
      message = (err as Error).message;
    }

    // The dead-end advice from before this fix must never come back.
    expect(message).not.toContain("Declare @sourceRefField on the relationship");
    // Fix round 1: nor may the message claim a @cardinality value as the reason
    // -- Team owns no candidates, so the real reason is scope (whose references
    // @sourceRefField consults), independent of @cardinality.
    expect(message).not.toContain("@cardinality");
    expect(message).toContain(
      "@sourceRefField cannot resolve this: it only consults \"Team\"'s own identity.reference " +
        'children, and "Team" declares none targeting "Match" -- every candidate above belongs ' +
        "to the other side of this join",
    );
    // And states the two remedies that are actually legal.
    expect(message).toContain(
      "There is no attribute that disambiguates a hop like this -- remove the extra identity.reference " +
        "between these two entities, or restructure the model so only one remains.",
    );
  });

  test("fix round 1: a reverse @cardinality \"one\" relationship (rule (e)'s zero-candidate gap) gets the same honest, cardinality-free message", async () => {
    // Rule (e) (validateOneSideReferenceResolution, validation-passes.ts:2226)
    // only fires when the HOLDER declares 2+ candidates of its own
    // (`if (candidates.length <= 1) continue;` -- zero is silent, not just one).
    // So a @cardinality "one" relationship whose FK is entirely on the FAR side
    // (the holder itself declares no identity.reference at all) loads clean,
    // and reaches this exact codegen throw exactly like the @cardinality "many"
    // case above -- via findReferencesBetween's bidirectional walk finding the
    // far side's 2 candidates. This is a DOCUMENTED, parked gap (not fixed here
    // -- rule (e) is implemented in four language ports and broadening it in
    // TypeScript alone would create cross-port divergence); this test only
    // pins that the MESSAGE stays honest about it: @cardinality really is
    // "one" here, so the message must not claim otherwise, or claim @cardinality
    // is the reason @sourceRefField can't help.
    const root = await load([
      {
        "object.entity": {
          name: "Owner",
          children: [
            { "source.rdb": { "@table": "owners" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            // No identity.reference on Owner itself -- the FK lives on Pet.
            {
              "relationship.association": {
                name: "primaryPet",
                "@objectRef": "Pet",
                "@cardinality": "one",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "Pet",
          children: [
            { "source.rdb": { "@table": "pets" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "name" } },
            { "field.int": { name: "primaryOwnerId" } },
            { "field.int": { name: "backupOwnerId" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            {
              "identity.reference": {
                name: "primaryOwnerRef",
                "@fields": "primaryOwnerId",
                "@references": "Owner",
              },
            },
            {
              "identity.reference": {
                name: "backupOwnerRef",
                "@fields": "backupOwnerId",
                "@references": "Owner",
              },
            },
          ],
        },
      },
      {
        "object.projection": {
          name: "OwnerSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_owner_summary" } },
            { "field.int": { name: "id", extends: "Owner.id" } },
            { "identity.primary": { name: "id", extends: "Owner.id" } },
            {
              "field.string": {
                name: "primary_pet_name",
                children: [
                  { "origin.passthrough": { "@from": "Pet.name", "@via": "Owner.primaryPet" } },
                ],
              },
            },
          ],
        },
      },
    ]);

    const projection = root.objects().find((o) => o.name === "OwnerSummary")!;
    let message = "";
    try {
      extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
      throw new Error("expected extractViewSpec to throw the ambiguity error");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(
      /projection join hop "primaryPet" from "Owner" to "Pet" is ambiguous:.*primaryOwnerRef.*backupOwnerRef/s,
    );
    // The bug this test guards against: claiming @cardinality is not "one" when it IS "one".
    expect(message).not.toContain("@cardinality");
    expect(message).not.toContain("Declare @sourceRefField on the relationship");
    expect(message).toContain(
      '@sourceRefField cannot resolve this: it only consults "Owner"\'s own identity.reference ' +
        'children, and "Owner" declares none targeting "Pet" -- every candidate above belongs ' +
        "to the other side of this join",
    );
  });

  test("fix round 1: a @cardinality \"many\" hop whose OWN entity holds the ambiguous candidates still gets a true message (this one MAY name @cardinality)", async () => {
    // The mirror case: here Team itself declares two references onto Match, so
    // resolveRelationshipReference's ladder DID look at Team's own candidates
    // and failed to narrow them (name-pairing doesn't match "matches" to either).
    // A @cardinality "one" relationship could never reach this throw in this
    // shape -- rule (e) uses the identical own-side candidate ladder and would
    // reject it at load first -- so @cardinality is PROVABLY not "one" whenever
    // the hop's own entity owns one of the ambiguous candidates, and the message
    // may safely say so (unlike the two tests above, where the candidates are
    // on the far side and @cardinality could be either value).
    const root = await load([
      {
        "object.entity": {
          name: "Team",
          children: [
            { "source.rdb": { "@table": "teams" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "featuredMatchId" } },
            { "field.int": { name: "backupMatchId" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            {
              "identity.reference": {
                name: "featuredMatchRef",
                "@fields": "featuredMatchId",
                "@references": "Match",
              },
            },
            {
              "identity.reference": {
                name: "backupMatchRef",
                "@fields": "backupMatchId",
                "@references": "Match",
              },
            },
            { "relationship.association": { name: "matches", "@objectRef": "Match", "@cardinality": "many" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Match",
          children: [
            { "source.rdb": { "@table": "matches" } },
            { "field.int": { name: "id" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
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
    let message = "";
    try {
      extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
      throw new Error("expected extractViewSpec to throw the ambiguity error");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(
      /projection join hop "matches" from "Team" to "Match" is ambiguous:.*featuredMatchRef.*backupMatchRef/s,
    );
    expect(message).toContain('@sourceRefField cannot resolve this: it only disambiguates a @cardinality "one"');
    expect(message).toContain('this relationship\'s @cardinality is not "one"');
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
    let message = "";
    try {
      extractViewSpec(projection, root, { columnNamingStrategy: "snake_case" });
      throw new Error("expected extractViewSpec to throw the ambiguity error");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/origin\.first correlation from "Team" to "Match" is ambiguous:.*homeTeamRef.*awayTeamRef/s);
    // #368 round 2 sibling check: origin.first has no relationship node to attach
    // @sourceRefField to at all (the correlation is derived from @of alone), so this
    // message must never suggest it — confirming it stays dead-end-free alongside the
    // buildJoinTree fix above.
    expect(message).not.toContain("@sourceRefField");
  });
});
