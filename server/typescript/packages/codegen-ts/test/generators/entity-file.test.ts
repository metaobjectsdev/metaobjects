import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import { entityFile } from "../../src/generators/entity-file.js";
import { GENERATED_HEADER } from "../../src/constants.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";
import type { GenContext } from "../../src/generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "single-entity.json");

describe("entityFile() factory", () => {
  test("returns a Generator named 'entity-file'", () => {
    const gen = entityFile();
    expect(gen.name).toBe("entity-file");
    expect(typeof gen.generate).toBe("function");
  });

  test("emits one <Entity>.ts per entity with @generated header and Drizzle table", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
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

  test("allowlists: false produces a generated file with no runtime-ts/drizzle-fastify imports", async () => {
    // End-to-end: factory → generate → emitted file content. Verifies the
    // option threads from the user-facing factory all the way through to the
    // formatted output that gets written to disk.
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
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

    const files = await entityFile({ allowlists: false }).generate(ctx);
    const post = files.find(f => f.path === "Post.ts");
    expect(post).toBeDefined();
    expect(post!.content).not.toContain("FilterAllowlist");
    expect(post!.content).not.toContain("SortAllowlist");
    expect(post!.content).not.toContain("@metaobjectsdev/runtime-ts/drizzle-fastify");
    // Sanity: the rest of the entity file still emits.
    expect(post!.content).toContain(GENERATED_HEADER);
    expect(post!.content).toContain("sqliteTable");
    expect(post!.content).toContain("PostInsertSchema");
  });

  test("filter option narrows generated entities", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
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
