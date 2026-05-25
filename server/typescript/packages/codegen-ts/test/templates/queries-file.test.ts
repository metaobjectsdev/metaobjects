// packages/codegen-ts/test/templates/queries-file.test.ts
import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField } from "../_meta-build.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

function makePost(): MetaObject {
  const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  post.addChild(id);
  const title = metaField(FIELD_SUBTYPE_STRING, "title");
  title.setAttr("required", true);
  post.addChild(title);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  post.addChild(primary);
  return post;
}

describe("renderQueriesFile", () => {
  test("emits @generated header", () => {
    const root = metaRoot();
    const post = makePost();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/server/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderQueriesFile(post, ctx);
    expect(out).toContain(GENERATED_HEADER);
  });

  test("does NOT import a runtime db value (lifecycle is parameter-passed)", () => {
    const root = metaRoot();
    const post = makePost();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/server/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderQueriesFile(post, ctx);
    // No `import { db } from "~/server/db"` (or any path) — db is a parameter.
    expect(out).not.toMatch(/^import\s*\{\s*db\s*\}/m);
    expect(out).not.toContain("~/server/db");
  });

  test("emits sqlite-flavoured `type Db = ...` alias for sqlite/d1/libsql", () => {
    const root = metaRoot();
    const post = makePost();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/server/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderQueriesFile(post, ctx);
    expect(out).toContain('import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"');
    expect(out).toContain('type Db = BaseSQLiteDatabase<"async", Record<string, never>>;');
  });

  test("emits postgres-flavoured `type Db = ...` alias for postgres", () => {
    const root = metaRoot();
    const post = makePost();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "postgres",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/server/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderQueriesFile(post, ctx);
    expect(out).toContain('import type { NodePgDatabase } from "drizzle-orm/node-postgres"');
    expect(out).toContain('type Db = NodePgDatabase<Record<string, never>>;');
  });

  test("imports entity types from ./Post.js", () => {
    const root = metaRoot();
    const post = makePost();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/server/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderQueriesFile(post, ctx);
    expect(out).toContain("./Post");
    expect(out).toContain("PostInsertSchema");
  });

  test("contains all 5 CRUD functions", () => {
    const root = metaRoot();
    const post = makePost();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/server/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderQueriesFile(post, ctx);
    expect(out).toContain("findPostById");
    expect(out).toContain("listPosts");
    expect(out).toContain("createPost");
    expect(out).toContain("updatePost");
    expect(out).toContain("deletePostById");
  });
});
