// Follow-up to #368 — M:N derivation used the VISITING entity, not the entity
// that DECLARES the relationship.
//
// buildRelationMap walks `root.objects()` and, for each, the RESOLVING
// `obj.relationships()` — so a M:N relationship declared on an abstract base
// is reached again through every entity that extends it, with `obj` being the
// INHERITING entity. buildM2mEntry passed that entity to deriveM2MFields as
// the source, so:
//   * an inherited SELF-JOIN compared @objectRef (the base) against the child,
//     concluded "hetero", looked for a junction reference to the child, found
//     none and threw;
//   * an inherited HETERO relationship looked for a junction reference to the
//     child when the junction references the base, and threw too.
// buildM2mEntry catches and returns null, so the navigation was silently
// dropped from the generated relations() block — no error, no output.
//
// The child is declared BEFORE the base in both fixtures, so the walk reaches
// it first (the order shape the #368 loader regressions established).

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildRelationMap } from "../src/relation-resolver.js";

const SELF_JOIN = {
  "metadata.root": {
    package: "repro",
    children: [
      { "object.entity": { name: "Node", extends: "NodeBase", children: [
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "NodeBase", "@isAbstract": true, children: [
        { "relationship.association": { name: "peers", "@cardinality": "many", "@objectRef": "NodeBase",
            "@through": "NodeLink", "@symmetric": true } },
      ] } },
      { "object.entity": { name: "NodeLink", children: [
        { "field.int": { name: "id" } },
        { "field.int": { name: "aId" } },
        { "field.int": { name: "bId" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "a", "@fields": ["aId"], "@references": "NodeBase" } },
        { "identity.reference": { name: "b", "@fields": ["bId"], "@references": "NodeBase" } },
      ] } },
    ],
  },
};

const HETERO = {
  "metadata.root": {
    package: "repro",
    children: [
      { "object.entity": { name: "Article", extends: "ArticleBase", children: [
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "ArticleBase", "@isAbstract": true, children: [
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag",
            "@through": "ArticleTag" } },
      ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.int": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "ArticleTag", children: [
        { "field.int": { name: "id" } },
        { "field.int": { name: "articleId" } },
        { "field.int": { name: "tagId" } },
        { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "articleRef", "@fields": ["articleId"], "@references": "ArticleBase" } },
        { "identity.reference": { name: "tagRef", "@fields": ["tagId"], "@references": "Tag" } },
      ] } },
    ],
  },
};

async function load(model: unknown): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("buildRelationMap — M:N inherited via extends", () => {
  test("inherited self-join emits a navigation on the child (was: silently dropped)", async () => {
    const root = await load(SELF_JOIN);
    // Pin the premise: the child is walked before the base it inherits from.
    expect(root.objects().map((o) => o.name)).toEqual(["Node", "NodeBase", "NodeLink"]);

    const entries = buildRelationMap(root).get("Node") ?? [];
    const peers = entries.find((e) => e.name === "peers");
    expect(peers).toBeDefined();
    expect(peers!.cardinality).toBe("many");
    expect(peers!.junctionEntity).toBe("NodeLink");
    expect(peers!.sourceJoinField).toBe("aId");
    expect(peers!.targetJoinField).toBe("bId");
    expect(peers!.symmetric).toBe(true);
  });

  test("inherited hetero M:N emits a navigation on the child (was: silently dropped)", async () => {
    const root = await load(HETERO);
    const entries = buildRelationMap(root).get("Article") ?? [];
    const tags = entries.find((e) => e.name === "tags");
    expect(tags).toBeDefined();
    expect(tags!.targetEntity).toBe("Tag");
    expect(tags!.junctionEntity).toBe("ArticleTag");
    expect(tags!.sourceJoinField).toBe("articleId");
    expect(tags!.targetJoinField).toBe("tagId");
  });
});
