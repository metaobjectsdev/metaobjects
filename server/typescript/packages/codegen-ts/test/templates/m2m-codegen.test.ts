// FR-018 Unit 10 — TS M:N codegen.
//
// Exercises the three M:N modes (hetero, directed self-join, symmetric) through
// the loader → relation-resolver → drizzle-schema + routes pipeline:
//   - buildRelationMap derives the junction FK columns from the junction's two
//     identity.reference children (no @joinFields restated);
//   - the source entity's relations() block gains a many(junction) navigation;
//   - the junction entity's relations() block gains two one() belongs-to sides;
//   - the routes file emits a mountM2mRoute(...) traversal per M:N relationship.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";

const META = {
  "metadata.root": {
    package: "demo",
    children: [
      { "object.entity": { name: "Post", children: [
        { "source.rdb": { "@table": "posts" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "title", "@required": true } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Tag", children: [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "PostTag", children: [
        { "source.rdb": { "@table": "post_tags" } },
        { "field.long": { name: "postId", "@required": true } },
        { "field.long": { name: "tagId", "@required": true } },
        { "identity.primary": { "name": "id", "@fields": ["postId", "tagId"] } },
        { "identity.reference": { name: "fkPost", "@fields": "postId", "@references": "Post" } },
        { "identity.reference": { name: "fkTag", "@fields": "tagId", "@references": "Tag" } },
      ] } },
      { "object.entity": { name: "Person", children: [
        { "source.rdb": { "@table": "people" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        { "relationship.association": { name: "following", "@cardinality": "many", "@objectRef": "Person", "@through": "Follow", "@sourceRefField": "followerId" } },
        { "relationship.association": { name: "friends", "@cardinality": "many", "@objectRef": "Person", "@through": "Friendship", "@symmetric": true } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Follow", children: [
        { "source.rdb": { "@table": "follows" } },
        { "field.long": { name: "followerId", "@required": true } },
        { "field.long": { name: "followeeId", "@required": true } },
        { "identity.primary": { "name": "id", "@fields": ["followerId", "followeeId"] } },
        { "identity.reference": { name: "fkFollower", "@fields": "followerId", "@references": "Person" } },
        { "identity.reference": { name: "fkFollowee", "@fields": "followeeId", "@references": "Person" } },
      ] } },
      { "object.entity": { name: "Friendship", children: [
        { "source.rdb": { "@table": "friendships" } },
        { "field.long": { name: "personAId", "@required": true } },
        { "field.long": { name: "personBId", "@required": true } },
        { "identity.primary": { "name": "id", "@fields": ["personAId", "personBId"] } },
        { "identity.reference": { name: "fkPersonA", "@fields": "personAId", "@references": "Person" } },
        { "identity.reference": { name: "fkPersonB", "@fields": "personBId", "@references": "Person" } },
      ] } },
    ],
  },
};

async function loadRoot(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(META))]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "./db",
    apiPrefix: "/api",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("buildRelationMap — M:N entries", () => {
  test("hetero: Post gains a m2m entry pointing at Tag through PostTag", async () => {
    const root = await loadRoot();
    const map = buildRelationMap(root);
    const postEntries = map.get("Post") ?? [];
    const m2m = postEntries.find((e) => e.name === "tags");
    expect(m2m).toBeDefined();
    expect(m2m!.cardinality).toBe("many");
    expect(m2m!.targetEntity).toBe("Tag");
    expect(m2m!.junctionEntity).toBe("PostTag");
    expect(m2m!.sourceJoinField).toBe("postId");
    expect(m2m!.targetJoinField).toBe("tagId");
    expect(m2m!.symmetric).toBe(false);
  });

  test("directed self-join: Person.following picks followerId as source", async () => {
    const root = await loadRoot();
    const map = buildRelationMap(root);
    const e = (map.get("Person") ?? []).find((x) => x.name === "following")!;
    expect(e.junctionEntity).toBe("Follow");
    expect(e.sourceJoinField).toBe("followerId");
    expect(e.targetJoinField).toBe("followeeId");
    expect(e.symmetric).toBe(false);
  });

  test("symmetric self-join: Person.friends marked symmetric", async () => {
    const root = await loadRoot();
    const map = buildRelationMap(root);
    const e = (map.get("Person") ?? []).find((x) => x.name === "friends")!;
    expect(e.junctionEntity).toBe("Friendship");
    expect(e.symmetric).toBe(true);
  });
});

describe("renderDrizzleSchema — M:N relations() navigation", () => {
  test("Post.tags emits many(postTags) through the junction", async () => {
    const root = await loadRoot();
    const out = renderDrizzleSchema(root.findObject("Post")!, ctxFor(root)).toString();
    expect(out).toContain("postsRelations");
    expect(out).toContain("tags: many(postTags)");
  });

  test("junction PostTag emits two one() belongs-to sides", async () => {
    const root = await loadRoot();
    const out = renderDrizzleSchema(root.findObject("PostTag")!, ctxFor(root)).toString();
    expect(out).toContain("postTagsRelations");
    expect(out).toContain("one(posts");
    expect(out).toContain("one(tags");
  });
});

describe("renderRoutesFile — M:N traversal route", () => {
  test("hetero: Post routes mount the tags traversal via mountM2mRoute", async () => {
    const root = await loadRoot();
    const out = renderRoutesFile(root.findObject("Post")!, ctxFor(root));
    expect(out).toContain("mountM2mRoute");
    expect(out).toContain('relationName: "tags"');
    expect(out).toContain("junctionTable: postTags");
    expect(out).toContain("targetTable: tags");
    expect(out).toContain('sourceColumn: "post_id"');
    expect(out).toContain('targetColumn: "tag_id"');
    expect(out).toContain("symmetric: false");
  });

  test("symmetric: Person.friends route carries symmetric: true", async () => {
    const root = await loadRoot();
    const out = renderRoutesFile(root.findObject("Person")!, ctxFor(root));
    expect(out).toContain('relationName: "friends"');
    expect(out).toContain("symmetric: true");
    // directed self-join uses the @sourceRefField-derived source column.
    expect(out).toContain('relationName: "following"');
    expect(out).toContain('sourceColumn: "follower_id"');
    expect(out).toContain('targetColumn: "followee_id"');
  });
});
