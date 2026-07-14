// packages/codegen-ts/test/templates/queries.test.ts
import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField } from "../_meta-build.js";
import {
  renderFindByIdFn, renderListFn, renderCreateFn,
  renderUpdateFn, renderDeleteByIdFn,
} from "../../src/templates/queries.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

function makePost(): MetaObject {
  const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
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

function makeCtx(post: MetaObject) {
  const root = metaRoot();
  root.addChild(post);
  return makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/server/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("renderFindByIdFn", () => {
  test("first parameter is db: Db (the persistence-context handle)", () => {
    const post = makePost();
    const ctx = makeCtx(post); // sqlite
    const out = renderFindByIdFn(post, ctx).toString();
    // Signature is `findPostById(db: Db, id: number)`. We assert structurally
    // (substring + ordering) rather than an exact regex on whitespace so the
    // test survives ts-poet line-wrapping decisions.
    expect(out).toMatch(/findPostById\(\s*db:\s*Db\s*,\s*id:\s*number\s*\)/);
  });

  test("emits findPostById with .limit(1) shape returning singleton", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderFindByIdFn(post, ctx).toString();
    expect(out).toContain("findPostById");
    expect(out).toContain("Promise<Post | null>");
    // New shape: plain select().limit(1) — no prepared statement.
    expect(out).toContain(".limit(1)");
    expect(out).toContain("return post ?? null");
    // Old prepared-statement artifacts must be gone.
    expect(out).not.toContain(".prepare(");
    expect(out).not.toContain("sql.placeholder");
  });
});

describe("renderListFn", () => {
  test("emits listPosts with optional limit/offset", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderListFn(post, ctx).toString();
    expect(out).toContain("listPosts");
    expect(out).toContain("limit");
    expect(out).toContain("offset");
    expect(out).toContain("Promise<Post[]>");
  });

  test("pluralizes entities ending in y correctly (Category -> listCategories)", () => {
    const cat = metaObject(OBJECT_SUBTYPE_ENTITY, "Category");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    cat.addChild(id);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    cat.addChild(primary);
    const ctx = makeCtx(cat);
    const out = renderListFn(cat, ctx).toString();
    expect(out).toContain("listCategories");
    expect(out).not.toContain("listCategorys");
  });

  test("first parameter is db: Db", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderListFn(post, ctx).toString();
    // Signature: listPosts(db: Db, opts?: { limit?: number; offset?: number })
    expect(out).toMatch(/listPosts\(\s*db:\s*Db\s*,\s*opts\?/);
  });
});

describe("renderCreateFn", () => {
  test("emits createPost with Zod validation and .returning()", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderCreateFn(post, ctx).toString();
    expect(out).toContain("createPost");
    expect(out).toContain("PostInsertSchema.parse(data)");
    expect(out).toContain(".returning()");
    expect(out).toContain("Promise<Post>");
  });

  test("first parameter is db: Db", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderCreateFn(post, ctx).toString();
    // Signature: createPost(db: Db, data: unknown)
    expect(out).toMatch(/createPost\(\s*db:\s*Db\s*,\s*data:\s*unknown\s*\)/);
  });
});

describe("renderUpdateFn", () => {
  test("emits updatePost with UPDATE-schema (patch) validation and .returning()", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderUpdateFn(post, ctx).toString();
    expect(out).toContain("updatePost");
    // FR-035: assignments validate against the all-optional UPDATE schema — NOT
    // InsertSchema.partial() — so no insert-time transforms (@autoSet onCreate →
    // now(), TPH discriminator injection) leak into the patch path.
    expect(out).toContain("PostUpdateSchema.parse(patch)");
    expect(out).toContain(".returning()");
    expect(out).toContain("Promise<Post | null>");
    // PATCH-5: an empty patch is a no-op read-back, never an empty-SET SQL error.
    expect(out).toContain("findPostById(db, id)");
  });

  test("signature is (db: Db, id: number, patch: <Entity>Patch)", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderUpdateFn(post, ctx).toString();
    // FR-035 typed patch surface: the param is the compile-safe PostPatch, not an
    // opaque `data: unknown` — a renamed/dropped field is a call-site compile error.
    expect(out).toMatch(/updatePost\(\s*db:\s*Db\s*,\s*id:\s*number\s*,\s*patch:\s*PostPatch\s*\)/);
  });
});

describe("renderDeleteByIdFn", () => {
  test("emits deletePostById returning boolean using .returning() (portable across D1, libsql, postgres)", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderDeleteByIdFn(post, ctx).toString();
    expect(out).toContain("deletePostById");
    expect(out).toContain("Promise<boolean>");
    // The helper now uses .returning() unconditionally so the result is an array
    // on every dialect (SQLite ≥3.35 covers D1 + libsql/Turso; postgres native).
    // The old `rowsAffected` shape was libsql/Turso-specific and missing on D1.
    expect(out).toContain(".returning()");
    expect(out).toContain("deleted.length > 0");
    expect(out).not.toContain("rowsAffected");
  });

  test("first parameter is db: Db", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderDeleteByIdFn(post, ctx).toString();
    // Signature: deletePostById(db: Db, id: number)
    expect(out).toMatch(/deletePostById\(\s*db:\s*Db\s*,\s*id:\s*number\s*\)/);
  });
});
