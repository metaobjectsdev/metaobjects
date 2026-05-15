import { describe, it, expect } from "bun:test";
import { Loader, metaOf } from "@metaobjects/metadata";
import type { MetaRoot } from "@metaobjects/metadata";
import { buildPkMap } from "../src/pk-resolver.js";

function loadRoot(json: string): MetaRoot {
  const { root, errors } = new Loader().loadJson(json);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return metaOf(root) as MetaRoot;
}

describe("buildPkMap — typed MetaRoot", () => {
  it("resolves a plain entity's primary key field + subtype", () => {
    const root = loadRoot(JSON.stringify({
      metadata: {
        package: "acme",
        children: [{
          object: {
            name: "Widget", subType: "entity",
            children: [
              { field: { name: "id", subType: "long" } },
              { identity: { subType: "primary", "@fields": "id", "@generation": "increment" } },
            ],
          },
        }],
      },
    }));
    const map = buildPkMap(root);
    expect(map.get("Widget")).toEqual({ fieldName: "id", fieldSubType: "long", generation: "increment" });
  });

  it("resolves a PK inherited via extends", () => {
    const root = loadRoot(JSON.stringify({
      metadata: {
        package: "acme",
        children: [
          {
            object: {
              name: "Base", subType: "entity", isAbstract: true,
              children: [
                { field: { name: "id", subType: "long" } },
                { identity: { subType: "primary", "@fields": "id" } },
              ],
            },
          },
          {
            object: {
              name: "Article", subType: "entity", extends: "Base",
              children: [{ field: { name: "title", subType: "string" } }],
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
