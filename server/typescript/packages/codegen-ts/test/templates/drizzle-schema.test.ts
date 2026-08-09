// packages/codegen-ts/test/templates/drizzle-schema.test.ts
import { describe, test, expect } from "bun:test";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION,
         FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_INT,
         FIELD_SUBTYPE_TIMESTAMP, IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_SECONDARY,
         OBJECT_SUBTYPE_ENTITY, TYPE_FIELD, TYPE_IDENTITY, FIELD_SUBTYPE_ENUM } from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField, attachRdbSource } from "../_meta-build.js";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

function makeRoot(entities: MetaObject[]): MetaRoot {
  const root = metaRoot();
  for (const e of entities) root.addChild(e);
  return root;
}

function makePost(): MetaObject {
  const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
  attachRdbSource(post, "posts");
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  post.addChild(id);
  const title = metaField(FIELD_SUBTYPE_STRING, "title");
  title.setAttr("required", true);
  title.setAttr("maxLength", 200);
  post.addChild(title);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  post.addChild(primary);
  return post;
}

function makePostWithAuthor(): MetaObject {
  const post = makePost();
  // FK field
  const authorId = metaField(FIELD_SUBTYPE_LONG, "authorId");
  authorId.setAttr("required", true);
  post.addChild(authorId);
  // identity.reference establishes FK direction (Post.authorId → User).
  const ref = meta(new TypeId(TYPE_IDENTITY, "reference"), "ref_author");
  ref.setAttr("fields", ["authorId"]);
  ref.setAttr("references", "User");
  post.addChild(ref);
  // relationship child: Post has-one User (author)
  const rel = meta(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), "author");
  rel.setAttr("cardinality", "one");
  rel.setAttr("objectRef", "User");  // target entity
  post.addChild(rel);
  return post;
}

function makeUser(): MetaObject {
  const user = metaObject(OBJECT_SUBTYPE_ENTITY, "User");
  attachRdbSource(user, "users");
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  user.addChild(id);
  const email = metaField(FIELD_SUBTYPE_STRING, "email");
  email.setAttr("required", true);
  user.addChild(email);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
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
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
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
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
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
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain("postsRelations");
    expect(out).toContain("postsRelations = relations(");
    expect(out).toContain("one(users");
  });

  test("inverse side (User) gets NO lazy many() block (ADR-0038)", () => {
    // ADR-0038: reverse 1:N navigation is no longer a lazy Drizzle many() entry
    // (framework-bound + N+1-prone + same-pair collision). It is now an explicit
    // FK finder in the FK-holder's (Post's) queries module. So User's relations
    // block does NOT gain a `many(posts)` entry. A User with no FKs of its own
    // emits no relations() block at all.
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
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).not.toContain("many(posts");
  });

  test("@default 'now' timestamp emits sql import in SQLite output", () => {
    const post = makePost();
    // Add a timestamp field with @default: "now"
    const createdAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
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
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain('pgTable("posts"');
    expect(out).toContain("bigserial");
    expect(out).toContain("varchar(\"title\", { length: 200 }).notNull()");
  });

  // Reported against an adopting project: @autoSet's $defaultFn ignored timestampMode and always
  // returned a string, failing to typecheck against a "date"-mode column (Date-typed).
  test("@autoSet field respects timestampMode: \"date\" — $defaultFn returns Date, not a string", () => {
    const post = makePost();
    const createdAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
    createdAt.setAttr("required", true);
    createdAt.setAttr("autoSet", "onCreate");
    post.addChild(createdAt);

    const root = makeRoot([post]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      timestampMode: "date",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain(".$defaultFn(() => new Date())");
    expect(out).not.toContain(".toISOString()");
    expect(out).toMatch(/timestamp\("created_at",\s*\{\s*mode:\s*"date"/);
  });

  test("@autoSet field defaults to timestampMode: \"string\" unchanged (no config set)", () => {
    const post = makePost();
    const createdAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
    createdAt.setAttr("required", true);
    createdAt.setAttr("autoSet", "onCreate");
    post.addChild(createdAt);

    const root = makeRoot([post]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain(".$defaultFn(() =>");
    expect(out).toContain("new Date().toISOString()");
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
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain("bigserial");
    // \bserial( should NOT appear — only bigserial should
    expect(out).not.toMatch(/\bserial\(/);
  });

  test("Postgres int PK emits serial (not bigserial)", () => {
    const smallEntity = metaObject(OBJECT_SUBTYPE_ENTITY, "SmallEntity");
    smallEntity.addChild(metaField(FIELD_SUBTYPE_INT, "id"));
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
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
    const out = renderDrizzleSchema(root.findObject("SmallEntity")!, ctx).toString();
    expect(out).toMatch(/\bserial\(/);
    expect(out).not.toContain("bigserial");
  });

  test("composite PK emits table-level primaryKey callback, not per-column .primaryKey()", () => {
    const userTag = metaObject(OBJECT_SUBTYPE_ENTITY, "UserTag");
    const userId = metaField(FIELD_SUBTYPE_LONG, "userId");
    userId.setAttr("required", true);
    userTag.addChild(userId);
    const tagId = metaField(FIELD_SUBTYPE_LONG, "tagId");
    tagId.setAttr("required", true);
    userTag.addChild(tagId);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
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
    const out = renderDrizzleSchema(root.findObject("UserTag")!, ctx).toString();
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
    const sub = metaObject(OBJECT_SUBTYPE_ENTITY, "Subscriber");
    sub.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
    const email = metaField(FIELD_SUBTYPE_STRING, "email");
    email.setAttr("required", true);
    sub.addChild(email);
    // Primary
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    sub.addChild(primary);
    // Secondary on email
    const secondary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY), "uniqueEmail");
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
    const out = renderDrizzleSchema(root.findObject("Subscriber")!, ctx).toString();
    expect(out).toContain(".unique()");                  // .unique() on email column
    expect(out).toContain("uniqueIndex");                // table callback
    expect(out).toContain('"idx_subscribers_email"');    // index name in snake_case
  });

  test("composite secondary identity emits multi-column uniqueIndex", () => {
    const user = metaObject(OBJECT_SUBTYPE_ENTITY, "User");
    user.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
    user.addChild(metaField(FIELD_SUBTYPE_STRING, "firstName"));
    user.addChild(metaField(FIELD_SUBTYPE_STRING, "lastName"));
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    user.addChild(primary);
    const secondary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY), "uniqueName");
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
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).toContain('"idx_users_first_name_last_name"');
    // .on() should reference both fields
    // Index callbacks use the (table) => ... param to avoid TS self-init issues.
    expect(out).toMatch(/\.on\(table\.firstName,\s*table\.lastName\)/);
  });

  test("soft identity.reference (@enforce: false) omits .references()", () => {
    const user = makeUser();
    const post = makePost();
    // FK field
    const authorId = metaField(FIELD_SUBTYPE_LONG, "authorId");
    authorId.setAttr("required", true);
    post.addChild(authorId);
    // identity.reference with @enforce: false → logical-only.
    const ref = meta(new TypeId(TYPE_IDENTITY, "reference"), "ref_author");
    ref.setAttr("fields", ["authorId"]);
    ref.setAttr("references", "User");
    ref.setAttr("enforce", false);
    post.addChild(ref);
    // relationship child stays (relations() block still emits it for query nav).
    const rel = meta(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), "author");
    rel.setAttr("cardinality", "one");
    rel.setAttr("objectRef", "User");
    post.addChild(rel);

    const root = makeRoot([user, post]);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    // The FK column itself is still declared, but no .references() chain.
    expect(out).toContain('integer("author_id")');
    expect(out).not.toContain(".references(");
  });
});

describe("renderDrizzleSchema — field.enum CHECK constraints", () => {
  function makeOrderWithEnum(dialect: "sqlite" | "postgres") {
    const order = metaObject(OBJECT_SUBTYPE_ENTITY, "Order");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    order.addChild(id);
    const status = metaField(FIELD_SUBTYPE_ENUM, "status");
    status.setAttr("values", ["DRAFT", "PUBLISHED", "ARCHIVED"]);
    order.addChild(status);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    order.addChild(primary);
    const root = makeRoot([order]);
    const ctx = makeRenderContext({
      dialect,
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    return { root, ctx };
  }

  test("SQLite: enum field emits check() callback with sql`...`", () => {
    const { root, ctx } = makeOrderWithEnum("sqlite");
    const out = renderDrizzleSchema(root.findObject("Order")!, ctx).toString();
    // Check constraint should be emitted as a table-level callback entry.
    expect(out).toContain("check(");
    expect(out).toContain("status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')");
    expect(out).toContain("sql`status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')`");
    // The check function should be imported from drizzle-orm/sqlite-core.
    expect(out).toContain("drizzle-orm/sqlite-core");
  });

  test("Postgres: enum field emits check() callback with sql`...`", () => {
    const { root, ctx } = makeOrderWithEnum("postgres");
    const out = renderDrizzleSchema(root.findObject("Order")!, ctx).toString();
    expect(out).toContain("check(");
    expect(out).toContain("status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')");
    expect(out).toContain("drizzle-orm/pg-core");
  });
});

describe("renderDrizzleSchema — collection-name control", () => {
  test("per-entity override renames the table VAR (table name stays from @table)", () => {
    const root = makeRoot([makePost()]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
      collectionNameOverrides: { Post: "post" },
    });
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain("export const post = ");      // overridden var
    expect(out).toContain('pgTable("posts"');           // physical table name unchanged
    expect(out).not.toContain("export const posts ");
  });

  test("pluralizeCollections:false keeps the var singular", () => {
    const root = makeRoot([makePost()]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
      pluralizeCollections: false,
    });
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    expect(out).toContain("export const post = ");
  });

  test("an FK reference resolves to the OVERRIDDEN target var (consistency)", () => {
    const user = makeUser();
    const post = makePostWithAuthor();
    const root = makeRoot([user, post]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
      collectionNameOverrides: { User: "userAccount" },
    });
    const out = renderDrizzleSchema(root.findObject("Post")!, ctx).toString();
    // The .references() target must use the overridden var name, not "users".
    expect(out).toContain("userAccount");
    expect(out).not.toContain("=> users.");
  });
});

describe("renderDrizzleSchema — self-referential FK", () => {
  // A FK whose target IS the same entity (e.g. createdBy → this table, parentId,
  // managerId). Drizzle requires referencing the LOCAL table const directly with
  // an explicit `Any*Column` return type — NOT a self-import (which would be a
  // circular import + implicit-any error).
  function makeSelfRef(): MetaObject {
    const node = metaObject(OBJECT_SUBTYPE_ENTITY, "Node");
    attachRdbSource(node, "nodes");
    node.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
    node.addChild(metaField(FIELD_SUBTYPE_LONG, "parentId"));
    const pk = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "pk");
    pk.setAttr("fields", ["id"]);
    pk.setAttr("generation", "increment");
    node.addChild(pk);
    const ref = meta(new TypeId(TYPE_IDENTITY, "reference"), "fk_parent");
    ref.setAttr("fields", ["parentId"]);
    ref.setAttr("references", "Node");
    node.addChild(ref);
    return node;
  }

  test("Postgres: self-FK emits (): AnyPgColumn => <self>.id with no self-import", () => {
    const root = makeRoot([makeSelfRef()]);
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Node")!, ctx).toString();
    expect(out).toContain("AnyPgColumn");
    expect(out).toContain("references((): AnyPgColumn => nodes.id)");
    // Must NOT import its own module.
    expect(out).not.toContain('from "./Node"');
    expect(out).not.toContain("from './Node'");
  });

  test("SQLite: self-FK uses AnySQLiteColumn", () => {
    const root = makeRoot([makeSelfRef()]);
    const ctx = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Node")!, ctx).toString();
    expect(out).toContain("references((): AnySQLiteColumn => nodes.id)");
    expect(out).not.toContain('from "./Node"');
  });
});

describe("renderDrizzleSchema — cross-module circular FK", () => {
  // Two entities that reference each other (Author → Book and Book → Author).
  // Like a self-FK, the cross-MODULE import cycle makes TS infer the table const
  // as `any` (TS7022 "implicitly has type 'any' … referenced in its own
  // initializer") under `strict` unless the .references() callback carries an
  // explicit `Any*Column` return type. Regression: cross-entity FK callbacks must
  // be annotated too — not only self-referential ones.
  function makeAuthorBook(): MetaObject[] {
    const mkEntity = (name: string, table: string, fkField: string, target: string): MetaObject => {
      const e = metaObject(OBJECT_SUBTYPE_ENTITY, name);
      attachRdbSource(e, table);
      e.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
      e.addChild(metaField(FIELD_SUBTYPE_LONG, fkField));
      const pk = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "pk");
      pk.setAttr("fields", ["id"]);
      pk.setAttr("generation", "increment");
      e.addChild(pk);
      const ref = meta(new TypeId(TYPE_IDENTITY, "reference"), "fk");
      ref.setAttr("fields", [fkField]);
      ref.setAttr("references", target);
      e.addChild(ref);
      return e;
    };
    return [
      mkEntity("Author", "authors", "favoriteBookId", "Book"),
      mkEntity("Book", "books", "authorId", "Author"),
    ];
  }

  test("Postgres: cross-entity FK in a reference cycle is annotated with AnyPgColumn", () => {
    const root = makeRoot(makeAuthorBook());
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const authorOut = renderDrizzleSchema(root.findObject("Author")!, ctx).toString();
    expect(authorOut).toContain("references((): AnyPgColumn => books.id)");
    const bookOut = renderDrizzleSchema(root.findObject("Book")!, ctx).toString();
    expect(bookOut).toContain("references((): AnyPgColumn => authors.id)");
  });
});
