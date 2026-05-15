import { describe, it, expect } from "bun:test";
import { Loader, metaOf } from "@metaobjects/metadata";
import type { MetaRoot } from "@metaobjects/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

function loadRoot(json: string): MetaRoot {
  const { root, errors } = new Loader().loadJson(json);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return metaOf(root) as MetaRoot;
}

describe("buildRelationMap — typed MetaRoot", () => {
  it("registers a one-side relation and its inverse many-side", () => {
    const root = loadRoot(JSON.stringify({
      metadata: {
        package: "acme",
        children: [
          {
            object: {
              name: "Author", subType: "entity",
              children: [
                { field: { name: "id", subType: "long" } },
                { identity: { subType: "primary", "@fields": "id" } },
              ],
            },
          },
          {
            object: {
              name: "Article", subType: "entity",
              children: [
                { field: { name: "id", subType: "long" } },
                { field: { name: "authorId", subType: "long" } },
                {
                  relationship: {
                    name: "author", subType: "association",
                    "@cardinality": "one", "@objectRef": "Author", "@fkField": "authorId",
                  },
                },
                { identity: { subType: "primary", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    }));
    const map = buildRelationMap(root);
    const articleRels = map.get("Article") ?? [];
    expect(articleRels.find((r) => r.name === "author")?.cardinality).toBe("one");
    const authorRels = map.get("Author") ?? [];
    expect(authorRels.some((r) => r.cardinality === "many" && r.targetEntity === "Article")).toBe(true);
  });
});
