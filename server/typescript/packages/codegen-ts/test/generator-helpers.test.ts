import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { FileMetaDataLoader } from "@metaobjectsdev/metadata/core";
import { perEntity, oncePerRun, type GenContext, type Generator } from "../src/generator.js";

const SINGLE_ENTITY_FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

function makeCtx(
  entities: MetaObject[],
  loadedRoot: MetaRoot,
  match: (e: MetaObject) => boolean = () => true
): GenContext {
  return {
    entities,
    loadedRoot,
    matches: match,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    warn: () => {},
  };
}

describe("perEntity helper", () => {
  test("emits one file per matching entity", async () => {
    const loader = new FileMetaDataLoader();
    const result = await loader.loadFiles([SINGLE_ENTITY_FIXTURE]);
    const entities = result.root.objects();
    const ctx = makeCtx(entities, result.root);
    const fn = perEntity((e) => ({ path: `${e.name}.ts`, content: `// ${e.name}` }));
    const files = await fn(ctx);
    expect(files.length).toBe(entities.length);
    expect(files[0]!.path).toBe(`${entities[0]!.name}.ts`);
  });

  test("respects ctx.matches filter", async () => {
    const loader = new FileMetaDataLoader();
    const result = await loader.loadFiles([SINGLE_ENTITY_FIXTURE]);
    const entities = result.root.objects();
    const ctx = makeCtx(entities, result.root, (e) => e.name === "Post");
    const fn = perEntity((e) => ({ path: `${e.name}.ts`, content: "" }));
    const files = await fn(ctx);
    expect(files.length).toBe(1);
    expect(files.every(f => f.path.startsWith("Post"))).toBe(true);
  });
});

describe("oncePerRun helper", () => {
  test("called once with all matching entities", async () => {
    const loader = new FileMetaDataLoader();
    const result = await loader.loadFiles([SINGLE_ENTITY_FIXTURE]);
    const entities = result.root.objects();
    const ctx = makeCtx(entities, result.root);
    let invocations = 0;
    const fn = oncePerRun((all) => {
      invocations++;
      return { path: "index.ts", content: all.map(e => e.name).join(",") };
    });
    const files = await fn(ctx);
    expect(invocations).toBe(1);
    expect(files.length).toBe(1);
    expect(files[0]!.path).toBe("index.ts");
  });
});

describe("Generator interface — target fields", () => {
  test("accepts optional target + emitsEntityModule", () => {
    const g: Generator = { name: "x", generate: async () => [], target: "web", emitsEntityModule: true };
    expect(g.target).toBe("web");
    expect(g.emitsEntityModule).toBe(true);
  });
});
