import { describe, test, expect } from "bun:test";
import type { MetaModel } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_RELATIONSHIP,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, RELATIONSHIP_SUBTYPE_ASSOCIATION,
         OBJECT_SUBTYPE_ENTITY, CARDINALITY_ONE } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import {
  resolveRelationDescriptor,
  buildLazyRelateSpec,
  buildIncludeBatchSpec,
  type RelationDescriptor,
} from "../src/relation-resolver.js";
import { MetadataError } from "../src/errors.js";

function makeUser(): MetaModel {
  const user = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
  user.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  user.addChild(primary);
  return user;
}

function makePost(): MetaModel {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "authorId"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  post.addChild(primary);
  const rel = meta(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), "author");
  rel.setAttr("cardinality", CARDINALITY_ONE);
  rel.setAttr("objectRef", "User");
  rel.setAttr("fkField", "authorId");
  post.addChild(rel);
  return post;
}

function makeRoot(entities: MetaModel[]): MetaModel {
  const r = meta(new TypeId("metadata", "base"), "");
  for (const e of entities) r.addChild(e);
  return r;
}

describe("resolveRelationDescriptor — one-side", () => {
  test("Post.author → cardinality 'one' to User via authorId", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const post = root.childByName("Post")!;
    const desc = resolveRelationDescriptor(post, "author", root);
    expect(desc.cardinality).toBe("one");
    expect(desc.targetEntityName).toBe("User");
    expect(desc.sourceField).toBe("authorId");
    expect(desc.targetField).toBe("id");
  });

  test("unknown relation name → MetadataError", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const post = root.childByName("Post")!;
    expect(() => resolveRelationDescriptor(post, "missing", root)).toThrow(MetadataError);
  });
});

describe("resolveRelationDescriptor — many-side (inverse)", () => {
  test("User.posts → cardinality 'many' (inverse of Post.author)", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const user = root.childByName("User")!;
    const desc = resolveRelationDescriptor(user, "posts", root);
    expect(desc.cardinality).toBe("many");
    expect(desc.targetEntityName).toBe("Post");
    expect(desc.sourceField).toBe("id");
    expect(desc.targetField).toBe("authorId");
  });
});

describe("buildLazyRelateSpec", () => {
  test("one-side: SELECT users WHERE id = post.authorId", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const post = root.childByName("Post")!;
    const desc = resolveRelationDescriptor(post, "author", root);
    const spec = buildLazyRelateSpec(desc, { id: 42, authorId: 7 }, root);
    expect(spec).not.toBeNull();
    expect(spec!.table).toBe("users");
    expect(spec!.where).toEqual({ kind: "eq", column: "id", value: 7 });
  });

  test("one-side with null FK: returns null spec (caller returns null)", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const post = root.childByName("Post")!;
    const desc = resolveRelationDescriptor(post, "author", root);
    const spec = buildLazyRelateSpec(desc, { id: 42, authorId: null }, root);
    expect(spec).toBeNull();
  });

  test("many-side: SELECT posts WHERE author_id = user.id", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const user = root.childByName("User")!;
    const desc = resolveRelationDescriptor(user, "posts", root);
    const spec = buildLazyRelateSpec(desc, { id: 7 }, root);
    expect(spec).not.toBeNull();
    expect(spec!.table).toBe("posts");
    expect(spec!.where).toEqual({ kind: "eq", column: "author_id", value: 7 });
  });
});

describe("buildIncludeBatchSpec — many-side IN(...)", () => {
  test("loads posts for many users in one query", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const user = root.childByName("User")!;
    const desc = resolveRelationDescriptor(user, "posts", root);
    const records = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const spec = buildIncludeBatchSpec(desc, records, root);
    expect(spec).not.toBeNull();
    expect(spec!.table).toBe("posts");
    expect(spec!.where).toEqual({ kind: "in", column: "author_id", values: [1, 2, 3] });
  });

  test("one-side eager-load: WHERE id IN (...) for unique FK values", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const post = root.childByName("Post")!;
    const desc = resolveRelationDescriptor(post, "author", root);
    const records = [
      { id: 1, authorId: 5 },
      { id: 2, authorId: 7 },
      { id: 3, authorId: 5 },         // duplicate FK
      { id: 4, authorId: null },      // null FK
    ];
    const spec = buildIncludeBatchSpec(desc, records, root);
    expect(spec).not.toBeNull();
    expect(spec!.table).toBe("users");
    expect(spec!.where?.kind).toBe("in");
    if (spec!.where?.kind === "in") {
      expect(spec!.where.values.sort()).toEqual([5, 7]); // dedup + skip null
    }
  });

  test("returns null when no FK values to load", () => {
    const root = makeRoot([makeUser(), makePost()]);
    const post = root.childByName("Post")!;
    const desc = resolveRelationDescriptor(post, "author", root);
    const records = [{ id: 1, authorId: null }];
    expect(buildIncludeBatchSpec(desc, records, root)).toBeNull();
  });
});
