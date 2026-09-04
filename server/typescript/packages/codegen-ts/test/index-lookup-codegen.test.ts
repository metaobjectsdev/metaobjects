// packages/codegen-ts/test/index-lookup-codegen.test.ts
// TDD: failing-first tests for index.lookup Drizzle codegen (Task 5).
import { describe, test, expect } from "bun:test";
import {
  TypeId,
  TYPE_IDENTITY, TYPE_INDEX,
  IDENTITY_SUBTYPE_PRIMARY, IDENTITY_SUBTYPE_SECONDARY,
  INDEX_SUBTYPE_LOOKUP,
  INDEX_ATTR_FIELDS,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_TIMESTAMP,
  OBJECT_SUBTYPE_ENTITY,
  MetaIndex,
} from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField, attachRdbSource } from "./_meta-build.js";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { metaRoot } from "./_meta-build.js";

function makeRoot(entities: MetaObject[]): MetaRoot {
  const root = metaRoot();
  for (const e of entities) root.addChild(e);
  return root;
}

/** Build an Order entity with a composite index.lookup on customerId+placedAt */
function makeOrderWithLookupIndex(): MetaObject {
  const order = metaObject(OBJECT_SUBTYPE_ENTITY, "Order");
  attachRdbSource(order, "orders");
  order.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
  order.addChild(metaField(FIELD_SUBTYPE_LONG, "customerId"));
  order.addChild(metaField(FIELD_SUBTYPE_TIMESTAMP, "placedAt"));

  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  order.addChild(primary);

  // index.lookup: non-unique composite on customerId + placedAt DESC
  const idx = new MetaIndex(new TypeId(TYPE_INDEX, INDEX_SUBTYPE_LOOKUP), "orders_customer_placed_idx");
  idx.setAttr(INDEX_ATTR_FIELDS, ["customerId", "placedAt"]);
  idx.setAttr("orders", ["asc", "desc"]);
  order.addChild(idx);

  return order;
}

/** Build an entity with identity.secondary (should always emit uniqueIndex) */
function makeUserWithSecondary(): MetaObject {
  const user = metaObject(OBJECT_SUBTYPE_ENTITY, "User");
  attachRdbSource(user, "users");
  user.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
  user.addChild(metaField(FIELD_SUBTYPE_STRING, "email"));

  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "pk");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  user.addChild(primary);

  const secondary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY), "idx_email");
  secondary.setAttr("fields", ["email"]);
  user.addChild(secondary);

  return user;
}

describe("renderDrizzleSchema — index.lookup emits non-unique index", () => {
  test("index.lookup emits index(...) not uniqueIndex(...)", () => {
    const order = makeOrderWithLookupIndex();
    const root = makeRoot([order]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Order")!, ctx).toString();
    expect(out).toContain("index(");
    expect(out).not.toContain("uniqueIndex(");
  });

  test("index.lookup emits correct index name from MetaIndex.name", () => {
    const order = makeOrderWithLookupIndex();
    const root = makeRoot([order]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Order")!, ctx).toString();
    expect(out).toContain('"orders_customer_placed_idx"');
  });

  test("index.lookup emits .on(table.customerId.asc(), table.placedAt.desc()) — @orders honoured", () => {
    const order = makeOrderWithLookupIndex();
    const root = makeRoot([order]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Order")!, ctx).toString();
    // The fixture's own comment says "customerId + placedAt DESC" and it sets
    // @orders ["asc","desc"], yet this assertion used to require the direction to be
    // ABSENT — pinning the defect rather than the intent. migrate emits the DESC, so the
    // generated schema declared a differently-ordered index than the database has.
    expect(out).toMatch(/\.on\(table\.customerId\.asc\(\),\s*table\.placedAt\.desc\(\)\)/);
  });

  // The physical escapes (@expr / @where / @using) reached migrate and never reached this
  // file at all, which is a SHAPE divergence rather than a naming one: a PARTIAL unique index
  // read as a fully unique one in the generated schema, and an @expr-only index emitted
  // nothing whatsoever because both loops required a non-empty @fields. `drizzle-kit push`
  // would then propose replacing the database's index with the wrong one.
  test("@where emits a partial index — a partial UNIQUE must not read as a total one", () => {
    const user = makeUserWithSecondary();
    const sec = user.children().find((c) => c.name === "idx_email")!;
    sec.setAttr("where", "deleted_at IS NULL");
    const root = makeRoot([user]);
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).toMatch(/\.where\(sql`deleted_at IS NULL`\)/);
  });

  test("@expr emits an expression index, which used to emit NOTHING", () => {
    const user = makeUserWithSecondary();
    const sec = user.children().find((c) => c.name === "idx_email")!;
    // An expression index keys off @expr, not @fields — migrate emits it on @expr alone.
    sec.setAttr("fields", []);
    sec.setAttr("expr", "lower(email)");
    const root = makeRoot([user]);
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).toContain('uniqueIndex("idx_email")');
    expect(out).toMatch(/\.on\(sql`lower\(email\)`\)/);
  });

  test("@using selects the access method and replaces .on()", () => {
    const user = makeUserWithSecondary();
    const sec = user.children().find((c) => c.name === "idx_email")!;
    sec.setAttr("using", "gin");
    const root = makeRoot([user]);
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).toMatch(/\.using\("gin", table\.email\)/);
  });

  test("@using btree is omitted — migrate treats it as the default, so emitting it would differ", () => {
    const user = makeUserWithSecondary();
    const sec = user.children().find((c) => c.name === "idx_email")!;
    sec.setAttr("using", "btree");
    const root = makeRoot([user]);
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).not.toContain(".using(");
    expect(out).toMatch(/\.on\(table\.email\)/);
  });

  test("index.lookup does NOT add .unique() to the indexed columns", () => {
    const order = makeOrderWithLookupIndex();
    const root = makeRoot([order]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("Order")!, ctx).toString();
    expect(out).not.toContain(".unique()");
  });
});

describe("renderDrizzleSchema — identity.secondary always emits uniqueIndex", () => {
  test("identity.secondary emits uniqueIndex (always unique)", () => {
    const user = makeUserWithSecondary();
    const root = makeRoot([user]);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderDrizzleSchema(root.findObject("User")!, ctx).toString();
    expect(out).toContain("uniqueIndex(");
  });
});
