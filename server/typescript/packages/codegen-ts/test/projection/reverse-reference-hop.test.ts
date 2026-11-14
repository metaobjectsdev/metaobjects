// Phase 5, bug R-walk: an origin's @via may walk the REVERSE of an identity.reference the
// far entity declares, with no relationship declared for it. The hop is named after the
// referencing entity's collection name (lowerFirst(pluralize(<Holder>)), `Player.contracts`
// for Contract.player). The loader used to refuse it ("no such relationship or reference"),
// though codegen's correlations walk references both ways.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    "package": "acme::league",
    "children": [
      {
        "object.entity": {
          "name": "Player",
          "children": [
            { "source.rdb": { "@table": "players" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } }
          ]
        }
      },
      {
        "object.entity": {
          "name": "Contract",
          "children": [
            { "source.rdb": { "@table": "contracts" } },
            { "field.long": { "name": "id" } },
            { "field.long": { "name": "playerId" } },
            { "field.boolean": { "name": "onFile" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            { "identity.reference": { "name": "player", "@fields": "playerId", "@references": "acme::league::Player" } }
          ]
        }
      },
      {
        "object.projection": {
          "name": "PlayerContractSummary",
          "children": [
            { "source.rdb": { "@kind": "view", "@view": "v_player_contract_summary" } },
            { "field.long": { "name": "id", "extends": "acme::league::Player.id" } },
            { "field.int": { "name": "contractCount", "children": [ { "origin.aggregate": { "@agg": "count", "@of": "acme::league::Contract.id", "@via": "acme::league::Player.contracts" } } ] } },
            { "field.boolean": { "name": "latestOnFile", "children": [ { "origin.first": { "@of": "acme::league::Contract.onFile", "@via": "acme::league::Player.contracts", "@orderBy": ["id:desc"] } } ] } },
            { "identity.primary": { "name": "id", "extends": "acme::league::Player.id" } }
          ]
        }
      }
    ]
  }
};

async function load(model: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
}

/** The model with a second reference from Contract to Player: the reverse hop is ambiguous. */
function twoReferences(): unknown {
  const m = JSON.parse(JSON.stringify(MODEL));
  const contract = m["metadata.root"].children[1]["object.entity"].children;
  contract.push({ "field.long": { name: "witnessId" } });
  contract.push({ "identity.reference": { name: "witness", "@fields": "witnessId", "@references": "acme::league::Player" } });
  return m;
}

describe("R-walk — a @via hop over the reverse of an identity.reference", () => {
  test("loads with no relationship declared", async () => {
    const { errors } = await load(MODEL);
    expect(errors).toEqual([]);
  });

  test("the aggregate joins the referencing table, and the first correlates on its FK", async () => {
    const { root, errors } = await load(MODEL);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("COUNT(DISTINCT c.id) AS contract_count");
    expect(v!.sql).toContain("LEFT OUTER JOIN public.contracts c ON c.player_id = p.id");
    expect(v!.sql).toMatch(/\(SELECT c0\.on_file FROM public\.contracts c0 WHERE c0\.player_id = p\.id ORDER BY c0\.id DESC NULLS LAST, c0\.id ASC LIMIT 1\) AS latest_on_file/);
  });

  test("two references from the holder make the reverse hop ambiguous, named", async () => {
    const { errors } = await load(twoReferences());
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as { code?: string }).code).toBe("ERR_AMBIGUOUS_PATH");
    expect(String(errors[0]!.message)).toContain('"player", "witness"');
  });
});

// rc.21 (U9): the first hop from the base entity already walks a reference backwards; what an
// author who guesses the name (the reference's own name, a plural a @collectionName overrides)
// lacked was the name the rule gives. The refusal now lists the reverse hops onto the entity.
describe("a reverse hop under a guessed name", () => {
  test("the refusal names the reverse hops onto the entity", async () => {
    const m = JSON.parse(JSON.stringify(MODEL).replaceAll("acme::league::Player.contracts", "acme::league::Player.player"));
    const { errors } = await load(m);
    const msg = errors.map((e) => String(e.message)).join("\n");
    expect(msg).toContain(`no such relationship or reference "player" on Player`);
    expect(msg).toContain(`The reverse hops from Player are: "contracts" (walks Contract.player backwards)`);
  });

  test("a @collectionName renames the hop, and the refusal says so", async () => {
    const m = JSON.parse(JSON.stringify(MODEL).replaceAll("acme::league::Player.contracts", "acme::league::Player.contracts2"));
    m["metadata.root"].children[1]["object.entity"]["@collectionName"] = "ContractLog";
    const { errors } = await load(m);
    expect(errors.map((e) => String(e.message)).join("\n")).toContain(`"contractLog" (walks Contract.player backwards)`);
  });
});
