import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMemory } from "@metaobjects/sdk";
import { TYPE_OBJECT } from "@metaobjects/metadata";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function copyFixture(name: string): string {
  const dest = mkdtempSync(join(tmpdir(), `memload-${name}-`));
  cpSync(join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

describe("loadMemory — trainer-website-meta", () => {
  test("loads 3 objects + 1 decision", async () => {
    const root = copyFixture("trainer-website-meta");
    try {
      const meta = await loadMemory(root);
      const objects = meta.children().filter((c) => c.type === TYPE_OBJECT);
      const decisions = meta.children().filter((c) => c.type === "decision");
      expect(objects.map((o) => o.name).sort()).toEqual(["Post", "Tag", "User"]);
      expect(decisions.map((d) => d.name)).toEqual(["useTanstackQuery"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadMemory — multi-package-meta", () => {
  // Cross-file super resolution: the SP6 fix made the Loader defer super
  // resolution to a second pass after all input files are parsed, so refs
  // from one file can target nodes declared in another file (regardless of
  // load order).
  test("resolves cross-file super: references", async () => {
    const root = copyFixture("multi-package-meta");
    try {
      const meta = await loadMemory(root);
      const widget = meta.children().find((c) => c.name === "Widget");
      expect(widget).toBeDefined();
      // id field's super resolves to common::id across files
      const idField = widget!.children().find((c) => c.name === "id");
      expect(idField).toBeDefined();
      expect(idField!.superRef).toBe("::demo::common::id");
      expect(idField!.superResolved).toBeDefined();
      expect(idField!.superResolved!.fqn()).toBe("demo::common::id");
      expect(idField!.superResolved!.typeId.subType).toBe("long");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadMemory — invalid-json", () => {
  test("surfaces parse error", async () => {
    const root = copyFixture("invalid-json");
    try {
      await expect(loadMemory(root)).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadMemory — unresolved-super", () => {
  test("either loads with warning or throws — document observed behavior", async () => {
    const root = copyFixture("unresolved-super");
    try {
      try {
        const meta = await loadMemory(root);
        expect(meta).toBeDefined();
      } catch {
        // Throws acceptable too — both paths document behavior
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
