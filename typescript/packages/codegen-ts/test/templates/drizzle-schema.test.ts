// packages/codegen-ts/test/templates/drizzle-schema.test.ts
import { describe, test, expect } from "bun:test";
import { MetaModel, TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY,
         TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION,
         FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_INT,
         FIELD_SUBTYPE_TIMESTAMP, IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_SECONDARY,
         OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

function makeRoot(entities: MetaModel[]): MetaModel {
  const root = new MetaModel(new TypeId("metadata", "base"), "");
  for (const e of entities) root.addChild(e);
  return root;
}

function makePost(): MetaModel {
  const post = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  const id = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
  post.addChild(id);
  const title = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
  title.setAttr("required", true);
  title.setAttr("maxLength", 200);
  post.addChild(title);
  const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  post.addChild(primary);
  return post;
}

function makePostWithAuthor(): MetaModel {
  const post = makePost();
  // FK field
  const authorId = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "authorId");
  authorId.setAttr("required", true);
  post.addChild(authorId);
  // relationship child: Post has-one User (author)
  const rel = new MetaModel(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), "author");
  rel.setAttr("cardinality", "one");
  rel.setAttr("objectRef", "User");  // target entity
  rel.setAttr("fkField", "authorId"); // field on this entity that holds the FK
  post.addChild(rel);
  return post;
}

function makeUser(): MetaModel {
  const user = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
  const id = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
  user.addChild(id);
  const email = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "email");
  email.setAttr("required", true);
  user.addChild(email);
  const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  user.addChild(primary);
  return user;
}

describe("renderDrizzleSchema — SQLite", () => {
  test("emits sqliteTable with autoIncrement PK + notNull title", () => {
    const root = makeRoot([makePost()]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("Post")!, ctx).toString();
    expect(out).toContain('sqliteTable("posts"');
    expect(out).toContain("integer(\"id\").primaryKey({ autoIncrement: true })");
    expect(out).toContain("text(\"title\").notNull()");
    expect(out).toContain("export const posts");
  });

  test("emits .references() on FK column derived from relationship child", () => {
    const user = makeUser();
    const post = makePostWithAuthor();
    const root = makeRoot([user, post]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("Post")!, ctx).toString();
    expect(out).toContain(".references(");
    expect(out).toContain("users.id");
  });

  test("emits postsRelations export with one() for FK relationship", () => {
    const user = makeUser();
    const post = makePostWithAuthor();
    const root = makeRoot([user, post]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("Post")!, ctx).toString();
    expect(out).toContain("postsRelations");
    expect(out).toContain("postsRelations = relations(");
    expect(out).toContain("one(users");
  });

  test("inverse side (User) gets many() block", () => {
    const user = makeUser();
    const post = makePostWithAuthor();
    const root = makeRoot([user, post]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("User")!, ctx).toString();
    expect(out).toContain("usersRelations");
    expect(out).toContain("many(posts");
  });

  test("@default 'now' timestamp emits sql import in SQLite output", () => {
    const post = makePost();
    // Add a timestamp field with @default: "now"
    const createdAt = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_TIMESTAMP), "createdAt");
    createdAt.setAttr("required", true);
    createdAt.setAttr("default", "now");
    post.addChild(createdAt);

    const root = makeRoot([post]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    // Use renderEntityFile to get the full file output including resolved imports
    const out = renderEntityFile(post, ctx);
    // Verify the sql tag is emitted on the column
    expect(out).toContain("sql`CURRENT_TIMESTAMP`");
    // Verify `sql` is imported from "drizzle-orm" (not missing)
    expect(out).toMatch(/import\s*\{[^}]*\bsql\b[^}]*\}\s*from\s*"drizzle-orm"/);
  });
});

describe("renderDrizzleSchema — Postgres", () => {
  test("emits pgTable with bigserial PK for long id", () => {
    const root = makeRoot([makePost()]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("Post")!, ctx).toString();
    expect(out).toContain('pgTable("posts"');
    expect(out).toContain("bigserial");
    expect(out).toContain("varchar(\"title\", { length: 200 }).notNull()");
  });

  test("Postgres long PK emits bigserial, not serial", () => {
    const root = makeRoot([makePost()]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("Post")!, ctx).toString();
    expect(out).toContain("bigserial");
    // \bserial( should NOT appear — only bigserial should
    expect(out).not.toMatch(/\bserial\(/);
  });

  test("Postgres int PK emits serial (not bigserial)", () => {
    const smallEntity = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "SmallEntity");
    smallEntity.addChild(new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "id"));
    const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    smallEntity.addChild(primary);
    const root = makeRoot([smallEntity]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("SmallEntity")!, ctx).toString();
    expect(out).toMatch(/\bserial\(/);
    expect(out).not.toContain("bigserial");
  });

  test("composite PK emits table-level primaryKey callback, not per-column .primaryKey()", () => {
    const userTag = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "UserTag");
    const userId = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "userId");
    userId.setAttr("required", true);
    userTag.addChild(userId);
    const tagId = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "tagId");
    tagId.setAttr("required", true);
    userTag.addChild(tagId);
    const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["userId", "tagId"]);
    // No @generation — composite PKs are natural keys
    userTag.addChild(primary);
    const root = makeRoot([userTag]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("UserTag")!, ctx).toString();
    expect(out).toContain("primaryKey({ columns: [");
    // No per-column .primaryKey() — the table-level callback owns it
    expect(out).not.toMatch(/userId.*\.primaryKey\(\)/);
    expect(out).not.toMatch(/tagId.*\.primaryKey\(\)/);
    // Columns ARE still notNull (required was set)
    expect(out).toContain("userId");
    expect(out).toContain("tagId");
  });
});

describe("renderDrizzleSchema — secondary identity", () => {
  test("identity.secondary emits .unique() on each field + uniqueIndex callback", () => {
    const sub = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Subscriber");
    sub.addChild(new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
    const email = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "email");
    email.setAttr("required", true);
    sub.addChild(email);
    // Primary
    const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    sub.addChild(primary);
    // Secondary on email
    const secondary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY), "uniqueEmail");
    secondary.setAttr("fields", ["email"]);
    sub.addChild(secondary);

    const root = makeRoot([sub]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("Subscriber")!, ctx).toString();
    expect(out).toContain(".unique()");                  // .unique() on email column
    expect(out).toContain("uniqueIndex");                // table callback
    expect(out).toContain('"idx_subscribers_email"');    // index name in snake_case
  });

  test("composite secondary identity emits multi-column uniqueIndex", () => {
    const user = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
    user.addChild(new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
    user.addChild(new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "firstName"));
    user.addChild(new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "lastName"));
    const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    user.addChild(primary);
    const secondary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY), "uniqueName");
    secondary.setAttr("fields", ["firstName", "lastName"]);
    user.addChild(secondary);

    const root = makeRoot([user]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.childByName("User")!, ctx).toString();
    expect(out).toContain('"idx_users_first_name_last_name"');
    // .on() should reference both fields
    // Index callbacks use the (table) => ... param to avoid TS self-init issues.
    expect(out).toMatch(/\.on\(table\.firstName,\s*table\.lastName\)/);
  });
});
