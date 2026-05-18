import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMetaDataLoader } from "../../src/core/file-meta-data-loader.js";
import { TYPE_OBJECT } from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fmdl-yaml-test-"));
}

function writeYamlFixture(dir: string, filename: string, entityName: string): string {
  const path = join(dir, filename);
  const content = `metadata:
  children:
    - object:
        name: ${entityName}
        children:
          - field.long: id
          - identity.primary:
              '@fields': id
`;
  writeFileSync(path, content, "utf-8");
  return path;
}

function writeJsonFixture(dir: string, filename: string, entityName: string): string {
  const path = join(dir, filename);
  const content = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: entityName,
            children: [
              { "field.long": { name: "id" } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
      ],
    },
  });
  writeFileSync(path, content, "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// YAML discovery tests
// ---------------------------------------------------------------------------

describe("FileMetaDataLoader.loadDirectory() — YAML discovery", () => {
  it("discovers and loads a .yaml metadata file", async () => {
    const dir = makeTmpDir();
    try {
      writeYamlFixture(dir, "meta.shop.yaml", "Product");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir);

      expect(result.errors).toHaveLength(0);
      expect(result.root.ownChildByName("Product")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers and loads a .yml metadata file", async () => {
    const dir = makeTmpDir();
    try {
      writeYamlFixture(dir, "meta.shop.yml", "Product");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir);

      expect(result.errors).toHaveLength(0);
      expect(result.root.ownChildByName("Product")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers .json and .yaml files together", async () => {
    const dir = makeTmpDir();
    try {
      writeJsonFixture(dir, "meta.json.json", "Product");
      writeYamlFixture(dir, "meta.yaml.yaml", "Customer");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir);

      expect(result.errors).toHaveLength(0);
      expect(result.root.ownChildByName("Product")).toBeDefined();
      expect(result.root.ownChildByName("Customer")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers .json, .yaml, and .yml files together", async () => {
    const dir = makeTmpDir();
    try {
      writeJsonFixture(dir, "a.json", "FromJson");
      writeYamlFixture(dir, "b.yaml", "FromYaml");
      writeYamlFixture(dir, "c.yml", "FromYml");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir);

      expect(result.errors).toHaveLength(0);
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).toContain("FromJson");
      expect(names).toContain("FromYaml");
      expect(names).toContain("FromYml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exclude glob skips matching yaml file", async () => {
    const dir = makeTmpDir();
    try {
      writeYamlFixture(dir, "meta.alpha.yaml", "Alpha");
      writeYamlFixture(dir, "meta.beta.yaml", "Beta");
      writeYamlFixture(dir, "meta.gamma.yml", "Gamma");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir, { exclude: ["meta.beta.yaml"] });

      expect(result.errors).toHaveLength(0);
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).toContain("Alpha");
      expect(names).toContain("Gamma");
      expect(names).not.toContain("Beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exclude glob with case-insensitive match skips .yml file", async () => {
    const dir = makeTmpDir();
    try {
      writeYamlFixture(dir, "meta.skip.yml", "Skip");
      writeYamlFixture(dir, "meta.keep.yml", "Keep");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir, { exclude: ["meta.skip.yml"] });

      expect(result.errors).toHaveLength(0);
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).not.toContain("Skip");
      expect(names).toContain("Keep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
