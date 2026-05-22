import { describe, test, expect, beforeEach } from "bun:test";
import type { MetaData } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_RELATIONSHIP, TYPE_VIEW,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_BOOLEAN,
         IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_REFERENCE, OBJECT_SUBTYPE_ENTITY,
         RELATIONSHIP_SUBTYPE_ASSOCIATION,
         VIEW_SUBTYPE_TEXT,
         GENERATION_INCREMENT, CARDINALITY_ONE,
         IDENTITY_ATTR_FIELDS, IDENTITY_ATTR_GENERATION,
         IDENTITY_REFERENCE_ATTR_REFERENCES,
         RELATIONSHIP_ATTR_CARDINALITY, RELATIONSHIP_ATTR_OBJECT_REF,
         FIELD_ATTR_REQUIRED } from "@metaobjectsdev/metadata";
import { meta } from "./_meta-build.js";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import { MetadataError, UnsafeNameError, NotFoundError } from "../src/errors.js";

function makePost(): MetaData {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN), "isPublished"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
  primary.setAttr(IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT);
  post.addChild(primary);
  return post;
}

function makeRoot(entities: MetaData[]): MetaData {
  const r = meta(new TypeId("metadata", "base"), "");
  for (const e of entities) r.addChild(e);
  return r;
}

let om: ObjectManager;

beforeEach(() => {
  const driver = inMemoryDriver({
    seed: {
      posts: [
        { id: 1, title: "Hello", is_published: true },
        { id: 2, title: "Draft", is_published: false },
      ],
    },
    pkFields: { posts: ["id"] },
  });
  om = new ObjectManager({ metadata: makeRoot([makePost()]), driver });
});

describe("ObjectManager — findById", () => {
  test("returns the row when found", async () => {
    const row = await om.findById("Post", 1);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(1);
    expect(row!.title).toBe("Hello");
    expect(row!.isPublished).toBe(true);
  });

  test("returns null for missing id", async () => {
    expect(await om.findById("Post", 999)).toBeNull();
  });

  test("unknown entity → MetadataError", async () => {
    await expect(om.findById("Foo", 1)).rejects.toThrow(MetadataError);
  });

  test("unsafe entity name → UnsafeNameError", async () => {
    await expect(om.findById("../evil", 1)).rejects.toThrow(UnsafeNameError);
  });
});

describe("ObjectManager — findFirst", () => {
  test("returns first match by filter", async () => {
    const row = await om.findFirst("Post", { isPublished: true });
    expect(row?.id).toBe(1);
  });

  test("null when no match", async () => {
    expect(await om.findFirst("Post", { title: "missing" })).toBeNull();
  });
});

describe("ObjectManager — findMany", () => {
  test("returns all when no filter", async () => {
    const rows = await om.findMany("Post");
    expect(rows).toHaveLength(2);
  });

  test("with filter", async () => {
    const rows = await om.findMany("Post", { isPublished: false });
    expect(rows).toHaveLength(1);
  });

  test("with limit + orderBy", async () => {
    const rows = await om.findMany("Post", undefined, { orderBy: ["id", "desc"], limit: 1 });
    expect(rows[0]?.id).toBe(2);
  });
});

describe("ObjectManager — count", () => {
  test("total", async () => {
    expect(await om.count("Post")).toBe(2);
  });

  test("with filter", async () => {
    expect(await om.count("Post", { isPublished: true })).toBe(1);
  });
});

describe("ObjectManager — load (reference string)", () => {
  test("by simple ref", async () => {
    const row = await om.load("Post:1");
    expect(row?.title).toBe("Hello");
  });

  test("returns null for missing", async () => {
    expect(await om.load("Post:999")).toBeNull();
  });
});

describe("ObjectManager — refOf", () => {
  test("encodes to 'Post:1'", () => {
    expect(om.refOf("Post", { id: 1, title: "x" })).toBe("Post:1");
  });
});

describe("ObjectManager — create", () => {
  test("creates with auto-increment PK", async () => {
    const row = await om.create("Post", { title: "New", isPublished: true });
    expect(typeof row.id).toBe("number");
    expect(row.title).toBe("New");
    expect(await om.count("Post")).toBe(3);
  });

  test("caller-supplied PK on increment passes through (seeding / legacy import)", async () => {
    const row = await om.create("Post", { id: 99, title: "x", isPublished: true });
    expect(row.id).toBe(99);
    expect((await om.findById("Post", 99))?.title).toBe("x");
  });

  test("ValidationError when @required field missing", async () => {
    const entity = makeRoot([(() => {
      const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr(FIELD_ATTR_REQUIRED, true);
      post.addChild(title);
      const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
      primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
      primary.setAttr(IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT);
      post.addChild(primary);
      return post;
    })()]);
    const driver = inMemoryDriver({ pkFields: { posts: ["id"] } });
    const om2 = new ObjectManager({ metadata: entity, driver });
    await expect(om2.create("Post", {})).rejects.toMatchObject({
      name: "ValidationError",
      errors: [{ field: "title", rule: "required" }],
    });
  });
});

describe("ObjectManager — update", () => {
  test("updates and returns the updated row", async () => {
    const row = await om.update("Post", 1, { title: "Renamed" });
    expect(row?.title).toBe("Renamed");
  });

  test("default ifMissing=throw → NotFoundError", async () => {
    await expect(om.update("Post", 999, { title: "x" })).rejects.toThrow(NotFoundError);
  });

  test("ifMissing=ignore → returns null", async () => {
    expect(await om.update("Post", 999, { title: "x" }, { ifMissing: "ignore" })).toBeNull();
  });
});

describe("ObjectManager — delete", () => {
  test("deletes and returns true", async () => {
    expect(await om.delete("Post", 1)).toBe(true);
    expect(await om.count("Post")).toBe(1);
  });

  test("default ifMissing=throw → NotFoundError", async () => {
    await expect(om.delete("Post", 999)).rejects.toThrow(NotFoundError);
  });

  test("ifMissing=ignore → returns false", async () => {
    expect(await om.delete("Post", 999, { ifMissing: "ignore" })).toBe(false);
  });
});

describe("ObjectManager — createMany", () => {
  test("inserts all rows", async () => {
    const rows = await om.createMany("Post", [
      { title: "A", isPublished: true },
      { title: "B", isPublished: false },
    ]);
    expect(rows).toHaveLength(2);
    expect(await om.count("Post")).toBe(4);
  });

  test("validation error halts the batch (no partial inserts)", async () => {
    const entity = makeRoot([(() => {
      const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
      post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
      const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
      title.setAttr(FIELD_ATTR_REQUIRED, true);
      post.addChild(title);
      const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
      primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
      primary.setAttr(IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT);
      post.addChild(primary);
      return post;
    })()]);
    const driver = inMemoryDriver({ pkFields: { posts: ["id"] } });
    const om2 = new ObjectManager({ metadata: entity, driver });
    const failure = om2.createMany("Post", [{ title: "ok" }, { /* missing title */ }]);
    await expect(failure).rejects.toMatchObject({
      name: "ValidationError",
      errors: [{ field: "title", rule: "required" }],
    });
    expect(await om2.count("Post")).toBe(0);
  });

  test("driver-level constraint failure rolls back the batch", async () => {
    const failure = om.createMany("Post", [
      { title: "first", isPublished: true },
      { id: 1, title: "PK collision", isPublished: false },
    ]);
    await expect(failure).rejects.toMatchObject({ name: "ConstraintViolationError" });
    expect(await om.count("Post")).toBe(2);
  });
});

describe("ObjectManager — updateMany", () => {
  test("updates all matching, returns count", async () => {
    const n = await om.updateMany("Post", { isPublished: true }, { title: "Bumped" });
    expect(n).toBe(1);
    expect((await om.findById("Post", 1))?.title).toBe("Bumped");
  });

  test("with no matches returns 0", async () => {
    expect(await om.updateMany("Post", { id: 9999 }, { title: "x" })).toBe(0);
  });
});

describe("ObjectManager — deleteMany", () => {
  test("deletes all matching", async () => {
    expect(await om.deleteMany("Post", { isPublished: false })).toBe(1);
    expect(await om.count("Post")).toBe(1);
  });
});

function makePostWithAuthor(): MetaData {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title"));
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "authorId"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
  primary.setAttr(IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT);
  post.addChild(primary);
  // identity.reference establishes FK direction (Post.authorId → User).
  const ref = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_REFERENCE), "ref_author");
  ref.setAttr(IDENTITY_ATTR_FIELDS, ["authorId"]);
  ref.setAttr(IDENTITY_REFERENCE_ATTR_REFERENCES, "User");
  post.addChild(ref);
  const rel = meta(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), "author");
  rel.setAttr(RELATIONSHIP_ATTR_CARDINALITY, CARDINALITY_ONE);
  rel.setAttr(RELATIONSHIP_ATTR_OBJECT_REF, "User");
  post.addChild(rel);
  return post;
}

function makeUser(): MetaData {
  const user = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
  user.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  user.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "email"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
  primary.setAttr(IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT);
  user.addChild(primary);
  return user;
}

describe("ObjectManager — relate (lazy)", () => {
  test("Post.author returns the User row", async () => {
    const driver = inMemoryDriver({
      seed: {
        users: [{ id: 10, email: "a@x" }],
        posts: [{ id: 1, title: "Hello", author_id: 10 }],
      },
      pkFields: { users: ["id"], posts: ["id"] },
    });
    const om2 = new ObjectManager({ metadata: makeRoot([makePostWithAuthor(), makeUser()]), driver });
    const post = (await om2.findById("Post", 1))!;
    const author = await om2.relate("Post", post, "author");
    expect(author).not.toBeNull();
    expect((author as Record<string, unknown>).email).toBe("a@x");
  });

  test("User.posts returns array via inverse", async () => {
    const driver = inMemoryDriver({
      seed: {
        users: [{ id: 10, email: "a@x" }],
        posts: [
          { id: 1, title: "p1", author_id: 10 },
          { id: 2, title: "p2", author_id: 10 },
        ],
      },
      pkFields: { users: ["id"], posts: ["id"] },
    });
    const om2 = new ObjectManager({ metadata: makeRoot([makePostWithAuthor(), makeUser()]), driver });
    const user = (await om2.findById("User", 10))!;
    const posts = await om2.relate("User", user, "posts");
    expect(Array.isArray(posts)).toBe(true);
    expect((posts as Record<string, unknown>[]).length).toBe(2);
  });
});

describe("ObjectManager — include (eager)", () => {
  test("findById with include: ['author']", async () => {
    const driver = inMemoryDriver({
      seed: {
        users: [{ id: 10, email: "a@x" }],
        posts: [{ id: 1, title: "Hello", author_id: 10 }],
      },
      pkFields: { users: ["id"], posts: ["id"] },
    });
    const om2 = new ObjectManager({ metadata: makeRoot([makePostWithAuthor(), makeUser()]), driver });
    const post = await om2.findById("Post", 1, { include: ["author"] });
    expect(post).not.toBeNull();
    expect((post!.author as Record<string, unknown>).email).toBe("a@x");
  });

  test("findMany with include batches via IN(...)", async () => {
    const driver = inMemoryDriver({
      seed: {
        users: [{ id: 10, email: "a@x" }, { id: 11, email: "b@x" }],
        posts: [
          { id: 1, title: "p1", author_id: 10 },
          { id: 2, title: "p2", author_id: 11 },
        ],
      },
      pkFields: { users: ["id"], posts: ["id"] },
    });
    const om2 = new ObjectManager({ metadata: makeRoot([makePostWithAuthor(), makeUser()]), driver });
    const posts = await om2.findMany("Post", undefined, { include: ["author"] });
    expect(posts).toHaveLength(2);
    expect((posts[0]!.author as Record<string, unknown>).id).toBe(10);
    expect((posts[1]!.author as Record<string, unknown>).id).toBe(11);
  });

  test("nested includes throw MetadataError in v0.1", async () => {
    const driver = inMemoryDriver({ seed: { posts: [{ id: 1, title: "x", author_id: 10 }] }, pkFields: { posts: ["id"] } });
    const om2 = new ObjectManager({ metadata: makeRoot([makePostWithAuthor(), makeUser()]), driver });
    await expect(om2.findById("Post", 1, { include: ["author.profile"] })).rejects.toThrow(MetadataError);
  });
});

describe("ObjectManager — transaction", () => {
  test("commits on resolve", async () => {
    await om.transaction(async (txOm) => {
      await txOm.create("Post", { title: "tx", isPublished: true });
    });
    expect(await om.count("Post")).toBe(3);
  });

  test("rolls back on throw", async () => {
    await expect(om.transaction(async (txOm) => {
      await txOm.create("Post", { title: "tx", isPublished: true });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await om.count("Post")).toBe(2);
  });
});

describe("ObjectManager — view introspection", () => {
  test("viewFields returns names tagged with view", () => {
    const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
    post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
    const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
    const titleEdit = meta(new TypeId(TYPE_VIEW, VIEW_SUBTYPE_TEXT), "edit");
    title.addChild(titleEdit);
    post.addChild(title);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
    post.addChild(primary);

    const om2 = new ObjectManager({
      metadata: makeRoot([post]),
      driver: inMemoryDriver({}),
    });
    expect(om2.viewFields("Post", "edit")).toEqual(["title"]);
  });

  test("entityView throws when view name has no fields", () => {
    const om2 = new ObjectManager({ metadata: makeRoot([makePost()]), driver: inMemoryDriver({}) });
    expect(() => om2.entityView("Post", "missing")).toThrow(MetadataError);
  });
});

describe("ObjectManager — validate (standalone, no DB hit)", () => {
  test("returns ok=true when valid", () => {
    const om2 = new ObjectManager({ metadata: makeRoot([makePost()]), driver: inMemoryDriver({}) });
    expect(om2.validate("Post", { title: "ok", isPublished: true }).ok).toBe(true);
  });

  test("returns ok=false with errors[] when invalid", () => {
    const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
    post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
    const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
    title.setAttr(FIELD_ATTR_REQUIRED, true);
    post.addChild(title);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
    post.addChild(primary);

    const om2 = new ObjectManager({ metadata: makeRoot([post]), driver: inMemoryDriver({}) });
    const r = om2.validate("Post", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.field).toBe("title");
  });
});
