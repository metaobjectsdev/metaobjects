import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import type { MetaData } from "@metaobjects/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  return result.root;
}

describe("buildExpectedSchema — schema namespacing", () => {
  describe("captures the explicit @schema attr from source.dbTable", () => {
    let root: MetaData;

    beforeAll(async () => {
      root = await loadJson(JSON.stringify({
        "metadata.root": {
          "children": [
            {
              "object.entity": {
                "name": "Order",
                "children": [
                  { "field.long": { "name": "id" } },
                  { "field.string": { "name": "ref" } },
                  { "source.dbTable": { "name": "src", "@name": "orders", "@schema": "sales" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                ],
              },
            },
          ],
        },
      }));
    });

    test("schema field is populated from @schema attr", () => {
      const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
      expect(snapshot.tables).toHaveLength(1);
      expect(snapshot.tables[0]?.schema).toBe("sales");
    });
  });

  describe("leaves schema undefined when @schema is omitted", () => {
    let root: MetaData;

    beforeAll(async () => {
      root = await loadJson(JSON.stringify({
        "metadata.root": {
          "children": [
            {
              "object.entity": {
                "name": "Order",
                "children": [
                  { "field.long": { "name": "id" } },
                  { "field.string": { "name": "ref" } },
                  { "source.dbTable": { "name": "src", "@name": "orders" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                ],
              },
            },
          ],
        },
      }));
    });

    test("schema field is undefined when @schema is not declared", () => {
      const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
      expect(snapshot.tables).toHaveLength(1);
      expect(snapshot.tables[0]?.schema).toBeUndefined();
    });
  });
});
