// The oracle CLI (D8) loads a project the way `meta` does: through the providers its
// `metaobjects.config.ts` registers. A bare `loadMemory` stops at `Unknown type`.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import { loadProjectModel } from "../src/load-project-model.ts";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `import { TypeId, TYPE_VALIDATOR, MetaValidator } from "@metaobjectsdev/metadata";`,
  `const geoProvider = {`,
  `  id: "test-geocheck",`,
  `  dependencies: ["metaobjects-core-types"],`,
  `  registerTypes(registry) {`,
  `    registry.register({`,
  `      typeId: new TypeId(TYPE_VALIDATOR, "geocheck"),`,
  `      description: "A custom validator",`,
  `      factory: (typeId, name) => new MetaValidator(typeId, name),`,
  `      childRules: [],`,
  `      attributes: [],`,
  `    });`,
  `  },`,
  `};`,
  `export default defineConfig({ outDir: "out", dialect: "postgres", generators: [], providers: [geoProvider] });`,
].join("\n");

const META = {
  "metadata.root": {
    package: "acme::geo",
    children: [{
      "object.entity": {
        name: "Place",
        children: [
          { "field.long": { name: "id" } },
          { "field.string": { name: "name", children: [{ "validator.geocheck": { name: "chk" } }] } },
          { "source.rdb": { name: "src", "@table": "places" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
};

async function project(withConfig: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "load-project-model-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.json"), JSON.stringify(META), "utf8");
  if (withConfig) await writeFile(join(root, "metaobjects.config.ts"), CONFIG, "utf8");
  return root;
}

describe("loadProjectModel", () => {
  test("a bare loadMemory cannot load a project whose vocabulary comes from a config provider", async () => {
    const root = await project(true);
    await expect(loadMemory(root)).rejects.toThrow(/geocheck/);
  });

  test("loads that project through the providers its config registers", async () => {
    const root = await project(true);
    const model = await loadProjectModel(root);
    expect(model.objects().map((o) => o.name)).toContain("Place");
  });
});
