import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";
import { emit } from "../src/emit/index.js";

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return result.root;
}

describe("emit (postgres) — schema namespacing end-to-end", () => {
  describe("emits CREATE TABLE schema.table for a non-default schema", () => {
    let root: MetaData;

    beforeAll(async () => {
      root = await loadJson(JSON.stringify({
        "metadata.root": {
          "children": [
            {
              "object.entity": {
                "name": "AuditEvent",
                "children": [
                  { "field.long": { "name": "id" } },
                  { "source.rdb": { "name": "src", "@table": "audit_events", "@schema": "p3_api" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                ],
              },
            },
            {
              "object.entity": {
                "name": "Customer",
                "children": [
                  { "field.long": { "name": "id" } },
                  { "source.rdb": { "name": "src", "@table": "customers" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"] } },
                ],
              },
            },
          ],
        },
      }));
    });

    test("schema-qualified and unqualified CREATE TABLE statements", async () => {
      const expected = buildExpectedSchema(root, { dialect: "postgres" });
      const actual = { tables: [], views: [] };

      const result = await diff({ expected, actual });
      const sql = emit(result.changes, { dialect: "postgres" });

      // Schema-qualified for non-default schema
      expect(sql.up).toMatch(/CREATE TABLE "p3_api"\."audit_events"/);

      // Unqualified for no @schema (default schema should not be prefixed for back-compat)
      expect(sql.up).toMatch(/CREATE TABLE "customers"/);

      // Default schema should NOT be explicitly emitted for the default/unqualified table
      expect(sql.up).not.toMatch(/CREATE TABLE "public"\."customers"/);
    });
  });
});
