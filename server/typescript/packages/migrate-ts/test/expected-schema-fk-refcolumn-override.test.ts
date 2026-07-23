import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

// Regression: an FK's refColumns must resolve the TARGET entity's physical
// @column override, not the raw field name. An adopted database (e.g. an EF
// Core schema) commonly has a PK field `id` stored as column "Id"; before the
// fix the expected side emitted refColumns ["id"] while introspection read
// ["Id"], phantom-diffing every FK into that table as drop-fk + add-fk.

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return result.root;
}

function model(clientIdField: Record<string, unknown>): string {
  return JSON.stringify({
    "metadata.root": {
      "children": [
        {
          "object.entity": {
            "name": "Client",
            "children": [
              { "field.uuid": clientIdField },
              { "source.rdb": { "name": "src", "@table": "Clients" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            ],
          },
        },
        {
          "object.entity": {
            "name": "Patient",
            "children": [
              { "field.uuid": { "name": "id" } },
              { "field.uuid": { "name": "clientId", "@column": "ClientId" } },
              { "source.rdb": { "name": "src", "@table": "Patients" } },
              { "identity.primary": { "name": "pk", "@fields": ["id"] } },
              {
                "identity.reference": {
                  "name": "fk_client",
                  "@fields": ["clientId"],
                  "@references": "Client",
                },
              },
            ],
          },
        },
      ],
    },
  });
}

function patientFk(root: MetaData) {
  const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
  const table = snapshot.tables.find((t) => t.name === "Patients");
  expect(table).toBeDefined();
  expect(table!.foreignKeys).toHaveLength(1);
  return table!.foreignKeys[0]!;
}

describe("buildExpectedSchema — FK refColumns resolve the target PK's @column override", () => {
  test("target PK field with @column override → refColumns uses the physical name", async () => {
    const root = await loadJson(model({ "name": "id", "@column": "Id" }));
    const fk = patientFk(root);
    expect(fk.columns).toEqual(["ClientId"]);
    expect(fk.refTable).toBe("Clients");
    expect(fk.refColumns).toEqual(["Id"]);
  });

  test("target PK field without @column override → refColumns keeps the field name", async () => {
    const root = await loadJson(model({ "name": "id" }));
    const fk = patientFk(root);
    expect(fk.refColumns).toEqual(["id"]);
  });
});
