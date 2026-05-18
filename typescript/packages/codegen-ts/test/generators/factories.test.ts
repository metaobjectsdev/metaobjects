import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import type { MetaObject } from "@metaobjects/metadata";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { formFile } from "../../src/generators/form-file.js";
import { barrel } from "../../src/generators/barrel.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";
import { GENERATED_HEADER } from "../../src/constants.js";
import type { GenContext } from "../../src/generator.js";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "single-entity.json");

async function buildCtx(genFilter?: (e: MetaObject) => boolean): Promise<GenContext> {
  const loader = new FileMetaDataLoader();
  const { root } = await loader.loadFiles([FIXTURE]);
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return {
    entities, loadedRoot: root,
    matches: (e) => genFilter?.(e) ?? true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
}

describe("queriesFile()", () => {
  test("emits <Entity>.queries.ts with findById + create", async () => {
    const ctx = await buildCtx();
    const gen = queriesFile();
    const files = await gen.generate(ctx);
    const f = files.find(f => f.path === "Post.queries.ts");
    expect(f).toBeDefined();
    expect(f!.content).toContain(GENERATED_HEADER);
    expect(f!.content).toContain("findPostById");
    expect(f!.content).toContain("createPost");
  });

  test("respects user-provided filter", async () => {
    const gen = queriesFile({ filter: () => false });
    // Thread gen.filter through ctx.matches as runGen() would.
    const ctx = await buildCtx((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });
});

describe("routesFile()", () => {
  test("emits <Entity>.routes.ts wiring mountCrudRoutes from drizzle-fastify", async () => {
    const ctx = await buildCtx();
    const gen = routesFile();
    const files = await gen.generate(ctx);
    const f = files.find(f => f.path === "Post.routes.ts");
    expect(f).toBeDefined();
    expect(f!.content).toContain("mountCrudRoutes");
    expect(f!.content).toContain("@metaobjects/runtime-ts/drizzle-fastify");
  });

  test("respects user-provided filter", async () => {
    const gen = routesFile({ filter: () => false });
    // Thread gen.filter through ctx.matches as runGen() would.
    const ctx = await buildCtx((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });

});

describe("formFile()", () => {
  test("emits <Entity>.form.tsx with useEntityForm import", async () => {
    const ctx = await buildCtx();
    const gen = formFile();
    const files = await gen.generate(ctx);
    const f = files.find(f => f.path === "Post.form.tsx");
    expect(f).toBeDefined();
    expect(f!.content).toContain("@metaobjects/runtime-ts-client/react");
    expect(f!.content).toContain("useEntityForm");
  });

  test("respects user-provided filter", async () => {
    const gen = formFile({ filter: () => false });
    // Thread gen.filter through ctx.matches as runGen() would.
    const ctx = await buildCtx((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });

});

describe("barrel()", () => {
  test("emits one index.ts re-exporting every entity (not queries / routes / forms)", async () => {
    const ctx = await buildCtx();
    const gen = barrel();
    const files = await gen.generate(ctx);
    expect(files.length).toBe(1);
    const idx = files[0]!;
    expect(idx.path).toBe("index.ts");
    expect(idx.content).toContain(`export * from "./Post"`);
    expect(idx.content).not.toContain("queries");
    expect(idx.content).not.toContain("routes");
  });
});
