import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import type { MetaRoot } from "@metaobjects/metadata";
import { buildPkMap } from "../src/pk-resolver.js";

async function loadRoot(json: string): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([new InMemorySource(json)]);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return root as unknown as MetaRoot;
}

describe("buildPkMap — typed MetaRoot", () => {
  it("resolves a plain entity's primary key field + subtype", async () => {
    const root = await loadRoot(JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "Widget",
            children: [
              { "field.long": { name: "id" } },
              { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            ],
          },
        }],
      },
    }));
    const map = buildPkMap(root);
    expect(map.get("Widget")).toEqual({ fieldName: "id", fieldSubType: "long", generation: "increment" });
  });

  it("resolves a PK inherited via extends", async () => {
    const root = await loadRoot(JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Base", abstract: true,
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Article", extends: "Base",
              children: [{ "field.string": { name: "title" } }],
            },
          },
        ],
      },
    }));
    const map = buildPkMap(root);
    expect(map.get("Article")?.fieldName).toBe("id");
    expect(map.get("Article")?.fieldSubType).toBe("long");
  });
});
