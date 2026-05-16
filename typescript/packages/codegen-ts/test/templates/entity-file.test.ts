import { describe, test, expect } from "bun:test";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_METADATA,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, SUBTYPE_ROOT,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta } from "../_meta-build.js";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

describe("renderEntityFile", () => {
  test("emits @generated header + table + types + validators", () => {
    const root = meta(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
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
    root.addChild(post);

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(post, ctx);
    expect(out).toContain(GENERATED_HEADER);
    expect(out).toContain("sqliteTable");
    expect(out).toContain("InferSelectModel");
    expect(out).toContain("PostInsertSchema");
    expect(out).toContain("import");
    expect(out).toContain("drizzle-orm/sqlite-core");
    expect(out).toContain("drizzle-orm");
    expect(out).toContain("zod");
  });
});
