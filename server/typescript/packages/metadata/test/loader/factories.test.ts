import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { FileSource } from "../../src/loader/sources/file-source.js";

describe("MetaDataLoader static factories", () => {
  test("fromString loads JSON", async () => {
    const r = await MetaDataLoader.fromString(
      `{"metadata.root":{"package":"x","children":[]}}`,
      "json",
    );
    expect(r.errors).toEqual([]);
    expect(r.root.package).toBe("x");
  });

  test("fromString loads YAML", async () => {
    const r = await MetaDataLoader.fromString(
      "metadata:\n  package: x\n  children: []\n",
      "yaml",
    );
    expect(r.errors).toEqual([]);
    expect(r.root.package).toBe("x");
  });

  test("fromDirectory loads a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ld-"));
    try {
      await writeFile(
        join(dir, "meta.tiny.json"),
        `{"metadata.root":{"package":"x","children":[]}}`,
      );
      const r = await MetaDataLoader.fromDirectory(dir);
      expect(r.errors).toEqual([]);
      expect(r.root.package).toBe("x");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("fromDirectory honors exclude", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ld-"));
    try {
      await writeFile(
        join(dir, "meta.a.json"),
        `{"metadata.root":{"package":"x","children":[{"object.entity":{"name":"Alpha"}}]}}`,
      );
      await writeFile(
        join(dir, "meta.b.json"),
        `{"metadata.root":{"package":"x","children":[{"object.entity":{"name":"Beta"}}]}}`,
      );
      const r = await MetaDataLoader.fromDirectory(dir, { exclude: ["meta.b.json"] });
      expect(r.errors).toEqual([]);
      const names = r.root.ownChildren().map((c) => c.name);
      expect(names).toContain("Alpha");
      expect(names).not.toContain("Beta");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("fromUris loads from file:// URIs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lu-"));
    try {
      const p = join(dir, "meta.tiny.json");
      await writeFile(p, `{"metadata.root":{"package":"u","children":[]}}`);
      const r = await MetaDataLoader.fromUris(["file://" + p]);
      expect(r.errors).toEqual([]);
      expect(r.root.package).toBe("u");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("fromDirectory error semantics", () => {
  test("missing directory collects error and returns synthetic empty root", async () => {
    const r = await MetaDataLoader.fromDirectory("/nonexistent/path/that/should/not/exist");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.root).toBeDefined();
  });
});

describe("load() partial failure", () => {
  test("missing file among valid paths collects error; valid files still load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ld-partial-"));
    try {
      const validPath = join(dir, "meta.tiny.json");
      const missingPath = join(dir, "meta.absent.json");
      await writeFile(validPath, `{"metadata.root":{"package":"x","children":[]}}`);
      const result = await new MetaDataLoader().load([
        new FileSource(validPath),
        new FileSource(missingPath),  // file does not exist
      ]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.root).toBeDefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
