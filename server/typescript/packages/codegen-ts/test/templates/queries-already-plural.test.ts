// an already-plural entity name used to make the generated collection
// variable (e.g. `programPurchaseStats`, after the already-plural pluralize fix) IDENTICAL
// to the bare camelCase local row variable these functions destructure, producing
// `const [programPurchaseStats] = await db.insert(programPurchaseStats)...` — a
// TDZ "used before its declaration" compile error. The local row variable must be
// disambiguated in exactly that collision case.
import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  TypeId, TYPE_IDENTITY,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
  IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
} from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField } from "../_meta-build.js";
import {
  renderFindByIdFn, renderCreateFn, renderInsertPreservingFn, renderUpdateFn,
} from "../../src/templates/queries.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

function makeAlreadyPluralEntity(): MetaObject {
  const obj = metaObject(OBJECT_SUBTYPE_ENTITY, "ProgramPurchaseStats");
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  obj.addChild(id);
  const label = metaField(FIELD_SUBTYPE_STRING, "label");
  obj.addChild(label);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  obj.addChild(primary);
  return obj;
}

function makeCtx(entity: MetaObject, dialect: "postgres" | "sqlite" = "postgres") {
  const root = metaRoot();
  root.addChild(entity);
  return makeRenderContext({
    dialect, loadedRoot: root, outDir: "/x", dbImport: "~/server/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
}

// Every case below must never destructure a variable name that ALSO appears, as its
// own initializer's RHS, on the same statement (`const [x] = await db...(x)...` —
// a TDZ "used before its declaration" compile error regardless of which Drizzle
// method chain the collision shows up in: `.from(x)`, `.insert(x)`, `.update(x)`).
function assertNoSelfReferencingDestructure(out: string): void {
  for (const line of out.split("\n")) {
    const decl = line.match(/const \[(\w+)\] = await (.*);?$/);
    if (decl === null) continue;
    const [, destructured, rhs] = decl!;
    const rhsIdentifiers = rhs!.match(/\b\w+\b/g) ?? [];
    expect(rhsIdentifiers).not.toContain(destructured);
  }
}

describe("already-plural entity name — no self-referencing local variable", () => {
  test("renderFindByIdFn", () => {
    const entity = makeAlreadyPluralEntity();
    const out = renderFindByIdFn(entity, makeCtx(entity)).toString();
    assertNoSelfReferencingDestructure(out);
    expect(out).toContain("from(programPurchaseStats)");
  });

  test("renderCreateFn", () => {
    const entity = makeAlreadyPluralEntity();
    const out = renderCreateFn(entity, makeCtx(entity)).toString();
    assertNoSelfReferencingDestructure(out);
  });

  test("renderInsertPreservingFn", () => {
    const entity = makeAlreadyPluralEntity();
    const out = renderInsertPreservingFn(entity, makeCtx(entity)).toString();
    assertNoSelfReferencingDestructure(out);
  });

  test("renderUpdateFn", () => {
    const entity = makeAlreadyPluralEntity();
    const out = renderUpdateFn(entity, makeCtx(entity)).toString();
    assertNoSelfReferencingDestructure(out);
  });

  test("ordinary (non-colliding) entity keeps the existing bare camelCase local variable", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    post.addChild(id);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    post.addChild(primary);
    const out = renderCreateFn(post, makeCtx(post)).toString();
    expect(out).toContain("const [post] = await db.insert(posts)");
  });
});
