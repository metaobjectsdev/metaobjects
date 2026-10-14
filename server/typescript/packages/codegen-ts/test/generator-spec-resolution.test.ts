import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig, REMOVED_GENERATOR_NAMES, removedGeneratorMessage, resolveGenerators } from "../src/metaobjects-config.js";
import { generatorRegistry } from "../src/generator-registry.js";
import { entityFile } from "../src/generators/entity-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

// ADR-0021 #1 (TS parity) — select generators by STABLE-NAME STRING in the
// config `generators` array, resolved via the generator registry, as an
// alternative to the typed factory array. The string form uses the generator's
// DEFAULT options (same contract as C#/Python `--generators`). The factory
// array stays primary + fully supported.

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-spec-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function loadRoot() {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([new FileSource(FIXTURE)]);
  return root;
}

describe("resolveGenerators (registry string resolution)", () => {
  test('a native stable name resolves to the registry factory (default options)', () => {
    const gens = resolveGenerators(["entity"]);
    expect(gens).toHaveLength(1);
    expect(gens[0]!.name).toBe(entityFile().name);
  });

  test("non-string (factory) entries pass through untouched", () => {
    const factory = entityFile();
    const gens = resolveGenerators([factory]);
    expect(gens[0]).toBe(factory);
  });

  test("mixed array resolves strings and preserves factories", () => {
    const factory = routesFile();
    const gens = resolveGenerators(["entity", factory]);
    expect(gens).toHaveLength(2);
    expect(gens[0]!.name).toBe(entityFile().name);
    expect(gens[1]).toBe(factory);
  });

  test("unknown name → error listing the available names", () => {
    expect(() => resolveGenerators(["not-a-generator"]))
      .toThrow(/unknown generator "not-a-generator"/);
    // Lists native names so the user can correct it.
    try {
      resolveGenerators(["not-a-generator"]);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("entity");
      expect(msg).toContain("routes");
      // every registered name is selectable, the documentation generators included
      expect(msg).toContain("api-docs");
      expect(msg).toContain("metamodel-docs");
      // a removed name is NOT advertised as selectable
      expect(msg).not.toContain("mermaid-er");
    }
  });

  // ADR-0034 Amendment 9: documentation is a generator like any other, so a neutral name
  // resolves, and writes to the `docs` target.
  test('neutral name "docs" resolves to the docs generator, writing to the docs target', () => {
    const [docs] = resolveGenerators(["docs"]);
    expect(docs?.name).toBe("docs-file");
    expect(docs?.target).toBe("docs");
  });

  // 1.1 removed the standalone `mermaid-er` generator: the `docs` generator draws the diagram. A
  // config that still names it worked yesterday, so it is told what happened and what to
  // do, not "unknown generator", which sends its reader looking for a typo.
  test('removed name "mermaid-er" → says it was removed and that the docs generator draws the diagram', () => {
    let message = "";
    try {
      resolveGenerators(["entity", "mermaid-er"]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('generator "mermaid-er" was removed in 1.1');
    expect(message).toContain("the `docs` generator (docsFile()) draws the ER diagram");
    expect(message).toContain('Remove "mermaid-er" from `generators`');
    expect(message).not.toContain("unknown generator");
    // And it is gone from the registry, not merely refused.
    expect(generatorRegistry["mermaid-er"]).toBeUndefined();
  });

  // The same answer for a caller that must decide something from it (the CLI's verify
  // advisory), without matching the sentence.
  test("removedGeneratorMessage answers for a removed name only", () => {
    expect(removedGeneratorMessage("mermaid-er")).toContain('generator "mermaid-er" was removed in 1.1');
    expect(removedGeneratorMessage("entity")).toBeUndefined();
    expect(removedGeneratorMessage("no-such-generator")).toBeUndefined();
    // A name that is a property of every object is not a removed generator.
    expect(removedGeneratorMessage("toString")).toBeUndefined();
    expect(removedGeneratorMessage("constructor")).toBeUndefined();
  });

  // Every removed name says that it was removed and what to list instead.
  test("every removed name says it was removed, and is not a registered name", () => {
    expect(Object.keys(REMOVED_GENERATOR_NAMES)).toEqual(["mermaid-er"]);
    for (const [name, message] of Object.entries(REMOVED_GENERATOR_NAMES)) {
      expect(message, name).toContain(`generator "${name}" was removed`);
      expect(message, name).toContain("Remove");
      // A removed name must not also be a registered one: the registry would never be reached.
      expect(generatorRegistry[name], name).toBeUndefined();
    }
  });
});

describe('runGen — string selection produces identical output to the factory', () => {
  test('generators: ["entity"] === generators: [entityFile()] (byte-identical)', async () => {
    const root = await loadRoot();

    const byString = await runGen({
      config: defineConfig({
        outDir: join(tmp, "s"), extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: ["entity"],
      }),
      metadata: root,
    });
    const byFactory = await runGen({
      config: defineConfig({
        outDir: join(tmp, "f"), extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [entityFile()],
      }),
      metadata: root,
    });

    const sFiles = readdirSync(join(tmp, "s")).sort();
    const fFiles = readdirSync(join(tmp, "f")).sort();
    expect(sFiles).toEqual(fFiles);
    expect(sFiles.length).toBeGreaterThan(0);
    for (const name of sFiles) {
      const a = readFileSync(join(tmp, "s", name), "utf-8");
      const b = readFileSync(join(tmp, "f", name), "utf-8");
      expect(a, `byte-identical for ${name}`).toBe(b);
    }
    expect(byString.warnings).toEqual([]);
    expect(byFactory.warnings).toEqual([]);
  });

  test('mixed ["entity", routesFile()] runs both generators', async () => {
    const root = await loadRoot();
    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: ["entity", routesFile()],
      }),
      metadata: root,
    });
    expect(result.warnings).toEqual([]);
    const names = result.files.map((f) => f.path);
    // entity module + routes module both present
    expect(names.some((p) => p.endsWith("Post.ts"))).toBe(true);
    expect(names.some((p) => p.includes("routes") || p.includes("Routes"))).toBe(true);
  });

  test('unknown string name in config → runGen throws listing native names', async () => {
    const root = await loadRoot();
    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: ["bogus"],
      }),
      metadata: root,
    })).rejects.toThrow(/unknown generator "bogus"/);
  });

  test('neutral string name "docs" with no docs target → runGen refuses it by name', async () => {
    const root = await loadRoot();
    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: ["docs"],
      }),
      metadata: root,
    })).rejects.toThrow(/"docs-file" writes documentation to the "docs" target/);
  });
});
