// packages/codegen-ts/test/templates/queries-file.test.ts
import { describe, test, expect } from "bun:test";
import type { MetaModel } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_METADATA,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, SUBTYPE_ROOT,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta } from "../_meta-build.js";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

function makePost(): MetaModel {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  const id = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
  post.addChild(id);
  const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
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
    const root = meta(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
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

  test("imports db from configured dbImport path", () => {
    const root = meta(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
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
    expect(out).toContain("~/server/db");
    expect(out).toContain("import");
    expect(out).toContain("db");
  });

  test("imports entity types from ./Post.js", () => {
    const root = meta(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
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
    const root = meta(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
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
