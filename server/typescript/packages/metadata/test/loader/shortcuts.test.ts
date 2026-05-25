import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDirectory,
  loadString,
  loadUris,
  InMemoryStringSource,
} from "../../src/index.js";
// Source classes live in the /core entry (server-side only).
import { FileSource, DirectorySource, UriSource } from "../../src/core/index.js";

describe("module-level loader shortcuts", () => {
  test("loadString JSON", async () => {
    const r = await loadString(
      `{"metadata.root":{"package":"x","children":[]}}`,
      "json",
    );
    expect(r.errors).toEqual([]);
    expect(r.root.package).toBe("x");
  });

  test("loadString YAML", async () => {
    const r = await loadString(
      "metadata:\n  package: x\n  children: []\n",
      "yaml",
    );
    expect(r.errors).toEqual([]);
    expect(r.root.package).toBe("x");
  });

  test("loadDirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shrt-"));
    try {
      await writeFile(
        join(dir, "meta.tiny.json"),
        `{"metadata.root":{"package":"x","children":[]}}`,
      );
      const r = await loadDirectory(dir);
      expect(r.errors).toEqual([]);
      expect(r.root.package).toBe("x");
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test("loadUris", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shrt-"));
    try {
      const p = join(dir, "x.json");
      await writeFile(p, `{"metadata.root":{"package":"u","children":[]}}`);
      const r = await loadUris(["file://" + p]);
      expect(r.errors).toEqual([]);
      expect(r.root.package).toBe("u");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("metadata package exports — re-export surface", () => {
  test("InMemoryStringSource is exported from the root entry", () => {
    expect(InMemoryStringSource).toBeDefined();
    expect(typeof InMemoryStringSource).toBe("function");
  });

  test("FileSource / DirectorySource / UriSource are exported from /core", () => {
    expect(FileSource).toBeDefined();
    expect(DirectorySource).toBeDefined();
    expect(UriSource).toBeDefined();
  });
});
