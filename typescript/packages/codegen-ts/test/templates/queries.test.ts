// packages/codegen-ts/test/templates/queries.test.ts
import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjects/metadata";
import { TypeId, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
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
  test("emits findPostById with prepared statement (sqlite has no name arg)", () => {
    const post = makePost();
    const ctx = makeCtx(post); // sqlite
    const out = renderFindByIdFn(post, ctx).toString();
    expect(out).toContain("findPostById");
    // sqlite: prepare() has no args (drizzle-orm 0.41+ removed the name arg).
    expect(out).toMatch(/\.prepare\(\s*\)/);
    expect(out).toContain("Promise<Post | null>");
    expect(out).toContain("return post ?? null");
  });

  test("postgres emits prepare(name) for plan caching", () => {
    const post = makePost();
    const ctx = { ...makeCtx(post), dialect: "postgres" as const };
    const out = renderFindByIdFn(post, ctx).toString();
    expect(out).toContain('.prepare("find_post_by_id")');
  });

  test("postgres prepared statement name is stable across calls", () => {
    const post = makePost();
    const ctx = { ...makeCtx(post), dialect: "postgres" as const };
    const out1 = renderFindByIdFn(post, ctx).toString();
    const out2 = renderFindByIdFn(post, ctx).toString();
    const match1 = out1.match(/prepare\(['"]([^'"]+)['"]\)/);
    const match2 = out2.match(/prepare\(['"]([^'"]+)['"]\)/);
    expect(match1?.[1]).toBe(match2?.[1]);
    expect(match1?.[1]).toBe("find_post_by_id");
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
});

describe("renderUpdateFn", () => {
  test("emits updatePost with partial Zod validation and .returning()", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderUpdateFn(post, ctx).toString();
    expect(out).toContain("updatePost");
    expect(out).toContain("PostInsertSchema.partial().parse(data)");
    expect(out).toContain(".returning()");
    expect(out).toContain("Promise<Post | null>");
  });
});

describe("renderDeleteByIdFn", () => {
  test("emits deletePostById returning boolean", () => {
    const post = makePost();
    const ctx = makeCtx(post);
    const out = renderDeleteByIdFn(post, ctx).toString();
    expect(out).toContain("deletePostById");
    expect(out).toContain("Promise<boolean>");
    expect(out).toContain("rowsAffected");
  });
});
