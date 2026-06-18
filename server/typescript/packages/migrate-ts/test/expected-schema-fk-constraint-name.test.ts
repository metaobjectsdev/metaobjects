import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

// Conformance for the identity.reference `@constraintName` attr (declared in
// spec/metamodel/identity.json). Two facets:
//   1. The loader ACCEPTS @constraintName on an identity.reference — a successful
//      load proves the attr is a registered provider attribute (an undeclared attr
//      raises ERR_UNKNOWN_ATTR in the attr-schema validation pass).
//   2. buildExpectedSchema honours the override for the physical FK constraint name,
//      and falls back to the auto-derived `<table>_<firstFkColumn>_fk` when absent.

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return result.root;
}

function model(referenceChild: Record<string, unknown>): string {
  return JSON.stringify({
    "metadata.root": {
      "children": [
        {
          "object.entity": {
            "name": "Team",
            "children": [
              { "field.uuid": { "name": "id" } },
              { "source.rdb": { "name": "src", "@table": "teams" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            ],
          },
        },
        {
          "object.entity": {
            "name": "TeamInvite",
            "children": [
              { "field.uuid": { "name": "id" } },
              { "field.uuid": { "name": "team_id" } },
              { "source.rdb": { "name": "src", "@table": "team_invites" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } },
              { "identity.reference": referenceChild },
            ],
          },
        },
      ],
    },
  });
}

function teamInviteFk(root: MetaData) {
  const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
  const table = snapshot.tables.find((t) => t.name === "team_invites");
  expect(table).toBeDefined();
  expect(table!.foreignKeys).toHaveLength(1);
  return table!.foreignKeys[0]!;
}

describe("buildExpectedSchema — identity.reference @constraintName override", () => {
  test("accepts @constraintName and emits it as the FK constraint name", async () => {
    const root = await loadJson(
      model({
        "name": "fk_team",
        "@fields": ["team_id"],
        "@references": "Team",
        "@constraintName": "team_invites_team_id_teams_id_fk",
      }),
    );
    const fk = teamInviteFk(root);
    expect(fk.name).toBe("team_invites_team_id_teams_id_fk");
    expect(fk.columns).toEqual(["team_id"]);
    expect(fk.refTable).toBe("teams");
    expect(fk.refColumns).toEqual(["id"]);
  });

  test("falls back to the auto-derived <table>_<col>_fk name when @constraintName is absent", async () => {
    const root = await loadJson(
      model({
        "name": "fk_team",
        "@fields": ["team_id"],
        "@references": "Team",
      }),
    );
    const fk = teamInviteFk(root);
    expect(fk.name).toBe("team_invites_team_id_fk");
  });
});
