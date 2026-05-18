import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "../src/memory.js";
import { TYPE_OBJECT } from "@metaobjects/metadata";

function makeMetaRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-load-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  mkdirSync(join(root, "metaobjects", "_pending"), { recursive: true });
  return root;
}

describe("loadMemory", () => {
  test("loads metadata files from metaobjects/", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              { object: { name: "User", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      const meta = await loadMemory(root);
      const user = meta.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === "User");
      expect(user).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes _pending/ subdirectory", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "main.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              { object: { name: "Main", subType: "entity", children: [] } },
            ],
          },
        }),
      );
      writeFileSync(
        join(root, "metaobjects", "_pending", "draft.json"),
        JSON.stringify({
          metadata: {
            package: "test::draft",
            children: [
              { object: { name: "Draft", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      const meta = await loadMemory(root);
      const names = meta.ownChildren().map((c) => c.name);
      expect(names).toContain("Main");
      expect(names).not.toContain("Draft");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads decision children when metadata files contain them", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "decisions.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              {
                decision: {
                  name: "useTanstackQuery",
                  subType: "global",
                  "@forgeConfidence": 0.9,
                },
              },
            ],
          },
        }),
      );

      const meta = await loadMemory(root);
      const dec = meta.ownChildren().find((c) => c.type === "decision");
      expect(dec).toBeDefined();
      expect(dec!.name).toBe("useTanstackQuery");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws if metaobjects/ doesn't exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "memory-load-nodir-"));
    try {
      await expect(loadMemory(root)).rejects.toThrow(/cannot read|ENOENT|no such/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns empty model when metaobjects/ has no .json files", async () => {
    const root = makeMetaRoot();
    try {
      const meta = await loadMemory(root);
      expect(meta.ownChildren()).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadMemory — cross-package loading via workspace", () => {
  test("loads transitive extends: deps from workspace peers", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-loadmem-"));
    try {
      // Workspace setup: shared package + billing package that extends shared
      writeFileSync(join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

      // shared package: defines a User entity
      mkdirSync(join(wsRoot, "packages", "shared", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "shared", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "shared", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/shared",
          version: "1.0.0",
          metaobjectsPackage: "acme::shared",
          extends: [],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "shared", "metaobjects", "shared.json"),
        JSON.stringify({
          metadata: {
            package: "acme::shared",
            children: [
              { object: { name: "User", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      // billing package: extends shared; defines an Invoice entity
      mkdirSync(join(wsRoot, "packages", "billing", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "billing", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "billing", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/billing",
          version: "1.0.0",
          metaobjectsPackage: "acme::billing",
          extends: ["@acme/shared"],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "billing", "metaobjects", "billing.json"),
        JSON.stringify({
          metadata: {
            package: "acme::billing",
            children: [
              { object: { name: "Invoice", subType: "entity", children: [] } },
            ],
          },
        }),
      );

      // Load from billing's perspective
      const meta = await loadMemory(join(wsRoot, "packages", "billing"));
      const childNames = meta.ownChildren().map((c) => c.name).sort();
      // Both packages' entities are loaded into the merged MetaData tree
      expect(childNames).toContain("User");
      expect(childNames).toContain("Invoice");
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });

  test("single-package mode works unchanged when no workspace present", async () => {
    // No workspace config — loadMemory falls back to current package only
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "myapp.json"),
        JSON.stringify({
          metadata: {
            package: "myapp",
            children: [
              { object: { name: "Only", subType: "entity", children: [] } },
            ],
          },
        }),
      );
      const meta = await loadMemory(root);
      expect(meta.ownChildren().map((c) => c.name)).toEqual(["Only"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cross-package super: resolves via extends graph", async () => {
    const wsRoot = mkdtempSync(join(tmpdir(), "ws-crossref-"));
    try {
      writeFileSync(join(wsRoot, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");

      // common: declares an abstract id field
      mkdirSync(join(wsRoot, "packages", "common", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "common", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "common", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/common",
          version: "1.0.0",
          metaobjectsPackage: "acme::common",
          extends: [],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "common", "metaobjects", "common.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme::common",
            children: [
              { "field.long": { name: "id", abstract: true } },
            ],
          },
        }),
      );

      // domain: extends common; uses super: to inherit common::id
      mkdirSync(join(wsRoot, "packages", "domain", ".meta"), { recursive: true });
      mkdirSync(join(wsRoot, "packages", "domain", "metaobjects"), { recursive: true });
      writeFileSync(
        join(wsRoot, "packages", "domain", ".meta", "package.meta.json"),
        JSON.stringify({
          name: "@acme/domain",
          version: "1.0.0",
          metaobjectsPackage: "acme::domain",
          extends: ["@acme/common"],
        }),
      );
      writeFileSync(
        join(wsRoot, "packages", "domain", "metaobjects", "domain.json"),
        JSON.stringify({
          "metadata.root": {
            package: "acme::domain",
            children: [
              {
                "object.entity": {
                  name: "Widget",
                  children: [
                    { field: { name: "id", extends: "::acme::common::id" } },
                  ],
                },
              },
            ],
          },
        }),
      );

      const meta = await loadMemory(join(wsRoot, "packages", "domain"));
      const widget = meta.ownChildren().find((c) => c.name === "Widget");
      expect(widget).toBeDefined();
      const idField = widget!.ownChildren().find((c) => c.name === "id");
      expect(idField).toBeDefined();
      // super resolved across package boundary
      expect(idField!.superResolved).toBeDefined();
      expect(idField!.superResolved!.typeId.subType).toBe("long");
    } finally {
      rmSync(wsRoot, { recursive: true, force: true });
    }
  });
});
