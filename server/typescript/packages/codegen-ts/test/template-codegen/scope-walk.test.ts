import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { templateGenerator } from "../../src/generators/template-generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "tmpl-scope-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function genPerEntity(outDir: string, projectRoot: string) {
  const loader = new MetaDataLoader();
  const res = await loader.load([new FileSource(resolve(import.meta.dir, "../fixtures/single-entity.json"))]);
  expect(res.errors).toEqual([]);
  await runGen({
    config: defineConfig({
      outDir, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
      generators: [templateGenerator({
        name: "entity-name-list",
        template: "scopecheck/entity",
        scope: "perEntity",
        outputPattern: "{name}.txt",
      })],
    }),
    metadata: res.root,
    projectRoot,
  });
}

describe("templateGenerator scope=perEntity", () => {
  test("emits one file per concrete entity via the named walk", async () => {
    const tdir = join(tmp, "templates", "scopecheck");
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, "entity.mustache"), "name={{name}} pkg={{package}}\n");
    const outDir = join(tmp, "out");
    await genPerEntity(outDir, tmp);
    const files = readdirSync(outDir).sort();
    expect(files.length).toBeGreaterThan(0);
    const first = readFileSync(join(outDir, files[0]!), "utf8");
    expect(first).toMatch(/^name=/);
  });
});

describe("templateGenerator option validation", () => {
  test("throws when both walk and scope are given", () => {
    expect(() => templateGenerator({
      name: "bad", template: "x", scope: "perEntity", outputPattern: "{name}.txt",
      walk: () => [],
    })).toThrow(/exactly one/i);
  });
  test("throws when neither walk nor scope is given", () => {
    expect(() => templateGenerator({ name: "bad2", template: "x" })).toThrow(/exactly one/i);
  });
  test("throws when scope is given without outputPattern", () => {
    expect(() => templateGenerator({ name: "bad3", template: "x", scope: "perModel" }))
      .toThrow(/outputPattern/i);
  });
});
