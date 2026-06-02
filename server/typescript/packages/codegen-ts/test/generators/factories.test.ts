import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { queriesFile } from "../../src/generators/queries-file.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { routesFileHono } from "../../src/generators/routes-file-hono.js";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { barrel } from "../../src/generators/barrel.js";
import { docsFile } from "../../src/generators/docs-file.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { makeRenderContext } from "../../src/render-context.js";
import { GENERATED_HEADER } from "../../src/constants.js";
import type { GenContext } from "../../src/generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "single-entity.json");

async function buildCtx(genFilter?: (e: MetaObject) => boolean): Promise<GenContext> {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([new FileSource(FIXTURE)]);
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
    expect(f!.content).toContain("@metaobjectsdev/runtime-ts/drizzle-fastify");
  });

  test("respects user-provided filter", async () => {
    const gen = routesFile({ filter: () => false });
    // Thread gen.filter through ctx.matches as runGen() would.
    const ctx = await buildCtx((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });

});

describe("routesFileHono()", () => {
  test("emits <Entity>.routes.hono.ts wiring mountCrudRoutes from runtime-ts/hono", async () => {
    const ctx = await buildCtx();
    const gen = routesFileHono();
    const files = await gen.generate(ctx);
    const f = files.find(f => f.path === "Post.routes.hono.ts");
    expect(f).toBeDefined();
    expect(f!.content).toContain("mountCrudRoutes");
    expect(f!.content).toContain("@metaobjectsdev/runtime-ts/hono");
    expect(f!.content).toContain("registerPostRoutes");
  });

  test("respects user-provided filter", async () => {
    const gen = routesFileHono({ filter: () => false });
    const ctx = await buildCtx((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });

  test("accepts target", () => {
    expect(routesFileHono({ target: "api-hono" }).target).toBe("api-hono");
  });
});

describe("formFile()", () => {
  test("emits <Entity>.form.tsx with useEntityForm import", async () => {
    const ctx = await buildCtx();
    const gen = formFile();
    const files = await gen.generate(ctx);
    const f = files.find(f => f.path === "Post.form.tsx");
    expect(f).toBeDefined();
    expect(f!.content).toContain("@metaobjectsdev/react");
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

describe("docsFile()", () => {
  test("emits <Entity>.md with @generated marker + H1 + Storage section", async () => {
    const ctx = await buildCtx();
    const gen = docsFile();
    const files = await gen.generate(ctx);
    const f = files.find(f => f.path === "Post.md");
    expect(f).toBeDefined();
    // HTML-comment-wrapped marker drives the overwrite-policy on subsequent runs.
    expect(f!.content).toStartWith("<!-- @generated by @metaobjectsdev/codegen-ts");
    expect(f!.content).toContain("# Post\n");
    expect(f!.content).toContain("**Type:** `object.entity`");
    expect(f!.content).toContain("## Storage");
    // Neutral Constraints replaces the old language-specific sections.
    expect(f!.content).toContain("## Constraints");
    expect(f!.content).not.toContain("## Generated code");
    expect(f!.content).not.toContain("Zod");
  });

  test("respects user-provided filter", async () => {
    const gen = docsFile({ filter: () => false });
    const ctx = await buildCtx((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files).toEqual([]);
  });

  test("accepts target", () => {
    expect(docsFile({ target: "docs" }).target).toBe("docs");
  });

  test("target is undefined when unset", () => {
    expect(docsFile().target).toBeUndefined();
  });
});

describe("factories — target wiring", () => {
  test("entityFile sets emitsEntityModule and accepts target", () => {
    expect(entityFile().emitsEntityModule).toBe(true);
    expect(entityFile({ target: "model" }).target).toBe("model");
  });
  test("routesFile/queriesFile/barrel accept target", () => {
    expect(routesFile({ target: "api" }).target).toBe("api");
    expect(queriesFile({ target: "model" }).target).toBe("model");
    expect(barrel({ target: "model" }).target).toBe("model");
  });
  test("target is undefined when unset (back-compat)", () => {
    expect(entityFile().target).toBeUndefined();
    expect(barrel().target).toBeUndefined();
  });
});
