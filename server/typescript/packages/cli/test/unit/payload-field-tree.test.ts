import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { derivePayloadFieldTree } from "../../src/lib/payload-field-tree.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemorySource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const model = [
  { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title" } }] } },
  {
    "object.value": {
      name: "AuthorBrief",
      children: [
        { "field.string": { name: "displayName" } },
        { "field.int": { name: "postCount" } },
        {
          "field.object": {
            name: "posts",
            "@isArray": true,
            "@objectRef": "PostBrief",
            children: [{ "origin.collection": { "@via": "Author.posts" } }],
          },
        },
      ],
    },
  },
];

describe("derivePayloadFieldTree — mirrors the payload-codegen VO walk", () => {
  test("scalar fields become leaf nodes; an object-ref field becomes a nested tree", async () => {
    const root = await loadRoot(model);
    const tree = derivePayloadFieldTree(root, "AuthorBrief");
    expect(tree).toEqual([
      { name: "displayName" },
      { name: "postCount" },
      { name: "posts", fields: [{ name: "title" }] },
    ]);
  });

  test("an unknown view-object name yields an empty tree", async () => {
    const root = await loadRoot(model);
    expect(derivePayloadFieldTree(root, "Nope")).toEqual([]);
  });
});
