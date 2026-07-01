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

  test("index.lookup emits .on(table.customerId, table.placedAt)", () => {
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
    expect(out).toMatch(/\.on\(table\.customerId,\s*table\.placedAt\)/);
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
