import { describe, test, expect } from "bun:test";
import type { MetaData } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_RELATIONSHIP,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, RELATIONSHIP_SUBTYPE_ASSOCIATION,
         OBJECT_SUBTYPE_ENTITY, CARDINALITY_MANY } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import { resolveN2mDescriptor, buildN2mLazySpecs, buildN2mBatchSpecs } from "../src/n2m-resolver.js";

function makeTag(): MetaData {
  const t = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Tag");
  t.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  t.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "name"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  t.addChild(primary);
  return t;
}

function makePostTag(): MetaData {
  const pt = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "PostTag");
  pt.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "postId"));
  pt.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "tagId"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["postId", "tagId"]);
  pt.addChild(primary);
  return pt;
}

function makePost(): MetaData {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  post.addChild(primary);
  // tags relationship: cardinality many, joinEntity PostTag, joinFields [postId, tagId]
  const rel = meta(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), "tags");
  rel.setAttr("cardinality", CARDINALITY_MANY);
  rel.setAttr("objectRef", "Tag");
  rel.setAttr("joinEntity", "PostTag");
  rel.setAttr("joinFields", ["postId", "tagId"]);
  post.addChild(rel);
  return post;
}

function makeRoot(entities: MetaData[]): MetaData {
  const r = meta(new TypeId("metadata", "base"), "");
  for (const e of entities) r.addChild(e);
  return r;
}

describe("resolveN2mDescriptor", () => {
  test("Post.tags → Tag via PostTag join entity", () => {
    const root = makeRoot([makePost(), makeTag(), makePostTag()]);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root);
    expect(desc.targetEntityName).toBe("Tag");
    expect(desc.joinEntityName).toBe("PostTag");
    expect(desc.sourceJoinField).toBe("postId");
    expect(desc.targetJoinField).toBe("tagId");
  });

  test("non-N:M relationship → null", () => {
    const root = makeRoot([makePost(), makeTag(), makePostTag()]);
    const post = root.ownChildByName("Post")!;
    expect(resolveN2mDescriptor(post, "missing", root)).toBeNull();
  });
});

describe("buildN2mLazySpecs — single record", () => {
  test("returns 2 specs: [join-table SELECT WHERE postId = X, target SELECT WHERE id IN (tag ids)]", () => {
    const root = makeRoot([makePost(), makeTag(), makePostTag()]);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    const specs = buildN2mLazySpecs(desc, { id: 42 }, root);
    expect(specs.joinSpec.table).toBe("post_tags");
    expect(specs.joinSpec.where).toEqual({ kind: "eq", column: "post_id", value: 42 });
    expect(specs.makeTargetSpec).toBeInstanceOf(Function);
    // The makeTargetSpec returns the second-stage spec given join rows
    const targetSpec = specs.makeTargetSpec([{ post_id: 42, tag_id: 1 }, { post_id: 42, tag_id: 2 }]);
    expect(targetSpec).not.toBeNull();
    expect(targetSpec!.table).toBe("tags");
    expect(targetSpec!.where).toEqual({ kind: "in", column: "id", values: [1, 2] });
  });

  test("makeTargetSpec returns null when no join rows match", () => {
    const root = makeRoot([makePost(), makeTag(), makePostTag()]);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    const specs = buildN2mLazySpecs(desc, { id: 42 }, root);
    expect(specs.makeTargetSpec([])).toBeNull();
  });
});

describe("buildN2mBatchSpecs — many records (eager include)", () => {
  test("returns 2 specs: [join WHERE postId IN (...), target WHERE id IN (...)]", () => {
    const root = makeRoot([makePost(), makeTag(), makePostTag()]);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    const specs = buildN2mBatchSpecs(desc, [{ id: 1 }, { id: 2 }], root);
    expect(specs.joinSpec.table).toBe("post_tags");
    expect(specs.joinSpec.where).toEqual({ kind: "in", column: "post_id", values: [1, 2] });
  });
});
