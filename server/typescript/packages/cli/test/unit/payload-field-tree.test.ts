import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { derivePayloadFieldTree } from "../../src/lib/payload-field-tree.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// Multi-file (multi-package) load — one InMemoryStringSource per doc, merged into a
// single root (mirrors fixtures/conformance/loader-same-name-distinct-packages).
async function loadRootFromDocs(...docs: unknown[]) {
  const res = await new MetaDataLoader().load(docs.map((d) => new InMemoryStringSource(JSON.stringify(d))));
  expect(res.errors).toEqual([]);
  return res.root;
}

const model = [
  { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title" } }] } },
  {
    // #210 — origin.collection is an ASSEMBLY origin: its host is a sourceless
    // object.projection (a value may host only origin.passthrough).
    "object.projection": {
      name: "AuthorBrief",
      children: [
        { "field.string": { name: "displayName" } },
        { "field.int": { name: "postCount" } },
        {
          "field.object": {
            name: "posts",
            "isArray": true,
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
    const tree = derivePayloadFieldTree(root, "AuthorBrief", "acme::ai");
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

  // ADR-0041: two packages each declare an object.value `Note` (alpha: alphaText, beta:
  // betaText), and `Digest` references BOTH by FULLY-QUALIFIED @objectRef. Pre-fix the
  // resolver matched the ref by raw bare name, so an FQN ref matched NOTHING and the nested
  // subtree was empty; now it binds the exact package.
  test("FQN nested @objectRef binds the exact package across a cross-package short-name collision", async () => {
    const root = await loadRootFromDocs(
      { "metadata.root": { package: "acme::alpha", children: [
        { "object.value": { name: "Note", children: [{ "field.string": { name: "alphaText" } }] } } ] } },
      { "metadata.root": { package: "acme::beta", children: [
        { "object.value": { name: "Note", children: [{ "field.string": { name: "betaText" } }] } } ] } },
      { "metadata.root": { package: "acme::app", children: [
        { "object.value": { name: "Digest", children: [
          { "field.object": { name: "fromAlpha", "@objectRef": "acme::alpha::Note" } },
          { "field.object": { name: "fromBeta", "@objectRef": "acme::beta::Note" } } ] } } ] } },
    );
    expect(derivePayloadFieldTree(root, "Digest", "acme::app")).toEqual([
      { name: "fromAlpha", fields: [{ name: "alphaText" }] },
      { name: "fromBeta", fields: [{ name: "betaText" }] },
    ]);
  });
});
