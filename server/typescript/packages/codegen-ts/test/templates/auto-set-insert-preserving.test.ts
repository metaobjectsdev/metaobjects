// Issue #203 — the `insertPreserving` escape hatch (TS parity with the other 4 ports).
//
// For an entity that declares @autoSet fields, codegen emits an additional
// `<Entity>InsertPreservingSchema` (the @autoSet columns validated VERBATIM, WITHOUT
// the create-time `now()` transform) plus an `insertPreserving<Entity>(db, data)`
// query — the import / restore / replication path that keeps the original timestamps.
// Emitted ONLY when the entity has @autoSet fields; a plain entity is byte-identical.

import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_TIMESTAMP,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField } from "../_meta-build.js";
import { renderZodValidators, hasAutoSetFields } from "../../src/templates/zod-validators.js";
import { renderInsertPreservingFn } from "../../src/templates/queries.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

/** Entity WITH @autoSet fields (createdAt onCreate + updatedAt onUpdate). */
function makeAutoSetEntity(): MetaObject {
  const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Event");
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  entity.addChild(id);
  const name = metaField(FIELD_SUBTYPE_STRING, "name");
  name.setAttr("required", true);
  entity.addChild(name);
  const createdAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
  createdAt.setAttr("autoSet", "onCreate");
  entity.addChild(createdAt);
  const updatedAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "updatedAt");
  updatedAt.setAttr("autoSet", "onUpdate");
  entity.addChild(updatedAt);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);
  return entity;
}

/** Plain entity, NO @autoSet field. */
function makePlainEntity(): MetaObject {
  const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  entity.addChild(id);
  const title = metaField(FIELD_SUBTYPE_STRING, "title");
  title.setAttr("required", true);
  entity.addChild(title);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);
  return entity;
}

function makeCtx(obj: MetaObject) {
  const root = metaRoot();
  root.addChild(obj);
  return makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/server/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("hasAutoSetFields", () => {
  test("true when an entity declares an @autoSet field", () => {
    expect(hasAutoSetFields(makeAutoSetEntity())).toBe(true);
  });
  test("false for a plain entity", () => {
    expect(hasAutoSetFields(makePlainEntity())).toBe(false);
  });
});

describe("InsertPreservingSchema (emitted only for @autoSet entities)", () => {
  test("@autoSet entity emits <Entity>InsertPreservingSchema", () => {
    const out = renderZodValidators(makeAutoSetEntity()).toString();
    expect(out).toContain("export const EventInsertPreservingSchema");
  });

  test("@autoSet columns are VERBATIM in the preserving schema — no now() transform", () => {
    const out = renderZodValidators(makeAutoSetEntity()).toString();
    const preserving = out.split("export const EventInsertPreservingSchema")[1] ?? "";
    // createdAt + updatedAt appear, but NOT with the create-time now() transform.
    expect(preserving).toContain("createdAt:");
    expect(preserving).toContain("updatedAt:");
    expect(preserving).not.toContain("new Date().toISOString()");
  });

  test("plain entity emits NO preserving schema", () => {
    const out = renderZodValidators(makePlainEntity()).toString();
    expect(out).not.toContain("InsertPreservingSchema");
  });
});

describe("renderInsertPreservingFn", () => {
  test("emits insertPreserving<Entity> parsing the preserving schema and inserting verbatim", () => {
    const entity = makeAutoSetEntity();
    const out = renderInsertPreservingFn(entity, makeCtx(entity)).toString();
    expect(out).toContain("insertPreservingEvent");
    expect(out).toContain("EventInsertPreservingSchema.parse(data)");
    expect(out).toContain(".insert(");
    expect(out).toContain(".returning()");
  });
});

describe("renderQueriesFile insertPreserving gating", () => {
  test("@autoSet entity's queries file contains insertPreserving + imports the preserving schema", () => {
    const entity = makeAutoSetEntity();
    const out = renderQueriesFile(entity, makeCtx(entity));
    expect(out).toContain("insertPreservingEvent");
    expect(out).toContain("EventInsertPreservingSchema");
  });

  test("plain entity's queries file has NO insertPreserving", () => {
    const entity = makePlainEntity();
    const out = renderQueriesFile(entity, makeCtx(entity));
    expect(out).not.toContain("insertPreserving");
    expect(out).not.toContain("InsertPreservingSchema");
  });
});
