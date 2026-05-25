import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return result.root;
}

describe("buildExpectedSchema — SQLite @schema rejection", () => {
  describe("throws when @schema is declared and dialect is sqlite", () => {
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
                  { "source.rdb": { "name": "src", "@table": "orders", "@schema": "sales" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                ],
              },
            },
          ],
        },
      }));
    });

    test("throws with sqlite + @schema", () => {
      expect(() => buildExpectedSchema(root, { dialect: "sqlite" })).toThrow(
        /sqlite.*does not support.*schema/i,
      );
    });
  });

  describe("does not throw when no @schema is declared and dialect is sqlite", () => {
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
                  { "source.rdb": { "name": "src", "@table": "orders" } },
                  { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } },
                ],
              },
            },
          ],
        },
      }));
    });

    test("does not throw without @schema on sqlite", () => {
      expect(() => buildExpectedSchema(root, { dialect: "sqlite" })).not.toThrow();
    });
  });
});
