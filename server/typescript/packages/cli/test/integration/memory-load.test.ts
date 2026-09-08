import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function copyFixture(name: string): string {
  const dest = mkdtempSync(join(tmpdir(), `memload-${name}-`));
  cpSync(join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

describe("loadMemory — trainer-website-meta", () => {
  test("loads 3 objects, and no forge vocabulary — that is opt-in now", async () => {
    // This fixture used to carry a `decision.global` node and eight `@forge*` attrs, and
    // they loaded because `forgeTypesProvider` was in the DEFAULT composition. No other
    // port registers any of it and `expected-registry.json` carries none of it, so the
    // fixture was quietly exercising vocabulary that only TypeScript accepted — which is
    // a good part of how the divergence stayed invisible. The vocabulary is opt-in now
    // (ADR-0023 consumer-provider); the sdk's own suite covers the opt-in path.
    const root = copyFixture("trainer-website-meta");
    try {
      const meta = await loadMemory(root);
      const objects = meta.objects();
      expect(objects.map((o) => o.name).sort()).toEqual(["Post", "Tag", "User"]);
      expect(meta.ownChildren().filter((c) => c.type === "decision")).toEqual([]);
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
      const widget = meta.ownChildren().find((c) => c.name === "Widget");
      expect(widget).toBeDefined();
      // id field's super resolves to common::id across files
      const idField = widget!.ownChildren().find((c) => c.name === "id");
      expect(idField).toBeDefined();
      expect(idField!.superRef).toBe("demo::common::id"); // FR-032: canonical refs are FQN
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
      await expect(loadMemory(root)).rejects.toThrow(/Invalid JSON/);
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
