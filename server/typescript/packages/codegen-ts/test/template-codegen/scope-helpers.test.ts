import { describe, test, expect } from "bun:test";
import { perPackage, perModel, oncePerRun } from "../../src/generator.js";
import type { GenContext, EmittedFile } from "../../src/generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolve } from "node:path";

const FIXTURE = resolve(import.meta.dir, "../fixtures/single-entity.json");

async function ctxFor(path: string): Promise<GenContext> {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(path)]);
  expect(res.errors).toEqual([]);
  const entities = res.root.objects();
  return {
    entities, loadedRoot: res.root, matches: () => true,
    config: {} as GenContext["config"], warn: () => {},
  };
}

describe("perPackage", () => {
  test("runs fn once per distinct package, packages sorted", async () => {
    const ctx = await ctxFor(FIXTURE);
    const seen: string[] = [];
    const gen = perPackage((pkg, ents) => {
      seen.push(pkg);
      return { path: `${pkg || "_"}/out.txt`, content: `${ents.length}` } as EmittedFile;
    });
    const files = await gen(ctx);
    expect(seen).toEqual(["demo"]);
    expect(files.length).toBe(1);
    expect(ctx.entities.every((e) => e.package == null)).toBe(true);
  });
});

describe("perModel / oncePerRun alias", () => {
  test("perModel runs fn once with all matched entities", async () => {
    const ctx = await ctxFor(FIXTURE);
    let calls = 0;
    const gen = perModel((ents) => { calls++; return { path: "all.txt", content: `${ents.length}` }; });
    const files = await gen(ctx);
    expect(calls).toBe(1);
    expect(files.length).toBe(1);
  });
  test("oncePerRun is the same function as perModel (alias)", () => {
    expect(oncePerRun).toBe(perModel);
  });
});
