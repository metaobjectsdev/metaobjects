import { describe, it, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import type { MetaRoot } from "@metaobjects/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

function loadRoot(json: string): MetaRoot {
  const { root, errors } = new Loader().loadJson(json);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return root as unknown as MetaRoot;
}

describe("buildRelationMap — typed MetaRoot", () => {
  it("registers a one-side relation and its inverse many-side", () => {
    const root = loadRoot(JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Author",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Article",
              children: [
                { "field.long": { name: "id" } },
                { "field.long": { name: "authorId" } },
                {
                  "relationship.association": {
                    name: "author",
                    "@cardinality": "one", "@objectRef": "Author", "@fkField": "authorId",
                  },
                },
                { "identity.primary": { "@fields": "id" } },
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
