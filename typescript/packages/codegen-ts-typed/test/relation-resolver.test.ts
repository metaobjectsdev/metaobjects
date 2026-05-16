import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import type { MetaRoot } from "@metaobjects/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

async function loadRoot(json: string): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([new InMemorySource(json)]);
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
  return root as unknown as MetaRoot;
}

describe("buildRelationMap — typed MetaRoot", () => {
  it("registers a one-side relation and its inverse many-side", async () => {
    const root = await loadRoot(JSON.stringify({
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
