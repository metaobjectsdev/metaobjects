import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { entityFile } from "../../src/generators/entity-file.js";
import { GENERATED_HEADER } from "../../src/constants.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";
import type { GenContext } from "../../src/generator.js";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "single-entity.json");

describe("entityFile() factory", () => {
  test("returns a Generator named 'entity-file'", () => {
    const gen = entityFile();
    expect(gen.name).toBe("entity-file");
    expect(typeof gen.generate).toBe("function");
  });

  test("emits one <Entity>.ts per entity with @generated header and Drizzle table", async () => {
    const loader = new FileMetaDataLoader();
    const { root } = await loader.loadFiles([FIXTURE]);
    const entities = root.objects();

    const renderContext = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
      dbImport: "../db", extStyle: "none",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const ctx: GenContext = {
      entities, loadedRoot: root,
      matches: () => true,
      config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
      renderContext,
      warn: () => {},
    };

    const files = await entityFile().generate(ctx);
    expect(files.length).toBe(entities.length);
    const post = files.find(f => f.path === "Post.ts");
    expect(post).toBeDefined();
    expect(post!.content).toContain(GENERATED_HEADER);
    expect(post!.content).toContain("sqliteTable");
    expect(post!.content).toContain("PostInsertSchema");
  });

  test("filter option narrows generated entities", async () => {
    const loader = new FileMetaDataLoader();
    const { root } = await loader.loadFiles([FIXTURE]);
    const entities = root.objects();

    const renderContext = makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
      dbImport: "../db", extStyle: "none",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const filter = (e: { name: string }) => e.name === "DoesNotExist";
    const gen = entityFile({ filter });
    const ctx: GenContext = {
      entities, loadedRoot: root,
      matches: (e) => gen.filter?.(e) ?? true,
      config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
      renderContext,
      warn: () => {},
    };
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });
});
