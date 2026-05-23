import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { ORIGIN_SUBTYPE_COLLECTION } from "../src/persistence/origin/origin-constants.js";

async function load(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await loader.load([new InMemorySource(json)]);
  return { errors: result.errors.map((e) => e.message), root: result.root };
}

// A nested view-object: a scalar key + an array field populated from a relationship.
// Value objects carry no identity (that rule is for object.entity).
const nested = (collectionChildren: unknown[]) => [
  {
    "object.value": {
      name: "PostBrief",
      children: [{ "field.string": { name: "title" } }],
    },
  },
  {
    "object.value": {
      name: "AuthorBrief",
      children: [
        { "field.string": { name: "displayName" } },
        {
          "field.object": {
            name: "posts",
            "@isArray": true,
            "@objectRef": "PostBrief",
            children: collectionChildren,
          },
        },
      ],
    },
  },
];

describe("origin.collection", () => {
  test("subtype constant", () => {
    expect(ORIGIN_SUBTYPE_COLLECTION).toBe("collection");
  });

  test("loads a nested-array field with origin.collection (@via) — no errors", async () => {
    const { errors } = await load(nested([{ "origin.collection": { "@via": "Author.posts" } }]));
    expect(errors).toEqual([]);
  });

  test("origin.collection missing required @via → error", async () => {
    const { errors } = await load(nested([{ "origin.collection": {} }]));
    expect(errors.length).toBeGreaterThan(0);
  });
});
