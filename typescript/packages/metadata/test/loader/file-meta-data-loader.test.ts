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
  return mkdtempSync(join(tmpdir(), "fmdl-test-"));
}

function writeFixture(dir: string, filename: string, entityName: string): string {
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
// loadDirectory — merges multiple files
// ---------------------------------------------------------------------------

describe("FileMetaDataLoader.loadDirectory()", () => {
  it("merges two json files into one MetaRoot — both entities present, no errors", async () => {
    const dir = makeTmpDir();
    try {
      writeFixture(dir, "meta.foo.json", "Foo");
      writeFixture(dir, "meta.bar.json", "Bar");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(loader.state).toBe("loaded");

      const objects = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT);
      const names = objects.map((o) => o.name);
      expect(names).toContain("Foo");
      expect(names).toContain("Bar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exclude glob skips matching file — excluded entity absent from result", async () => {
    const dir = makeTmpDir();
    try {
      writeFixture(dir, "meta.alpha.json", "Alpha");
      writeFixture(dir, "meta.beta.json", "Beta");
      writeFixture(dir, "meta.gamma.json", "Gamma");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir, { exclude: ["meta.beta.json"] });

      expect(result.errors).toHaveLength(0);
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).toContain("Alpha");
      expect(names).toContain("Gamma");
      expect(names).not.toContain("Beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-existent directory → collected error, loader does not throw", async () => {
    const loader = new FileMetaDataLoader();
    const result = await loader.loadDirectory("/tmp/__does_not_exist_fmdl_test__/subdir");

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toMatch(/loadDirectory: cannot read/);
  });

  it("ignores non-json files in directory", async () => {
    const dir = makeTmpDir();
    try {
      writeFixture(dir, "meta.foo.json", "Foo");
      writeFileSync(join(dir, "README.md"), "# ignore me", "utf-8");
      writeFileSync(join(dir, "notes.txt"), "ignore", "utf-8");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadDirectory(dir);

      expect(result.errors).toHaveLength(0);
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).toEqual(["Foo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loadFiles — explicit path list
// ---------------------------------------------------------------------------

describe("FileMetaDataLoader.loadFiles()", () => {
  it("loads an explicit list of paths", async () => {
    const dir = makeTmpDir();
    try {
      const p1 = writeFixture(dir, "meta.one.json", "One");
      const p2 = writeFixture(dir, "meta.two.json", "Two");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadFiles([p1, p2]);

      expect(result.errors).toHaveLength(0);
      expect(loader.state).toBe("loaded");
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).toContain("One");
      expect(names).toContain("Two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing path among valid paths → missing file is a collected error, valid files still load", async () => {
    const dir = makeTmpDir();
    try {
      const p1 = writeFixture(dir, "meta.valid.json", "Valid");
      const missing = join(dir, "meta.missing.json");

      const loader = new FileMetaDataLoader();
      const result = await loader.loadFiles([p1, missing]);

      // The missing file produces a collected error, NOT a thrown exception.
      expect(result.errors.length).toBeGreaterThan(0);

      // The valid file still loads — Valid entity is present.
      const names = result.root.ownChildren().filter((c) => c.type === TYPE_OBJECT).map((o) => o.name);
      expect(names).toContain("Valid");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
