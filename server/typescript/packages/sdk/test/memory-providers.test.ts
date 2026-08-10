// Tests for loadMemory's provider-extension API (rc.3).
//
// Verifies the LoadMemoryOptions surface added in 0.7.0-rc.3:
//   - default behavior: core + forge providers (back-compat)
//   - opts.providers: additive — composed AFTER defaults
//   - opts.replaceDefaults: replaces the default bundle entirely
//   - error-code surfaces for duplicate / missing-dep / cycle
//
// Mirrors the cross-port contract verified by the conformance suite's
// provider-extension-* fixtures (TS, C#, Python).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MetaDataTypeProvider,
  TypeId,
  TYPE_FIELD,
  TYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  OBJECT_SUBTYPE_ENTITY,
  MetaField,
} from "@metaobjectsdev/metadata";
import { loadMemory, defaultLoadMemoryProviders } from "../src/memory.js";

function makeMetaRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memory-providers-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  return root;
}

// A minimal third-party provider that registers a new field subtype.
function geoProvider(): MetaDataTypeProvider {
  return {
    id: "test-geo",
    dependencies: ["metaobjects-core-types"],
    registerTypes(registry) {
      registry.register({
        typeId: new TypeId(TYPE_FIELD, "geopoint"),
        description: "A geographic point field",
        factory: (typeId, name) => new MetaField(typeId, name),
        childRules: [],
        attributes: [],
      });
    },
  };
}

describe("loadMemory — provider extension", () => {
  test("default behavior: core + forge providers are composed (back-compat)", async () => {
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
      expect(meta.findObject("User")).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opts.providers adds a custom subtype on top of the defaults", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({
          "metadata.root": {
            package: "test",
            children: [
              {
                "object.entity": {
                  name: "Place",
                  children: [
                    // Uses the test-only geopoint subtype registered by geoProvider.
                    { "field.geopoint": { name: "location" } },
                  ],
                },
              },
            ],
          },
        }),
      );
      const meta = await loadMemory(root, { providers: [geoProvider()] });
      const place = meta.findObject("Place");
      expect(place).toBeDefined();
      const loc = place!.children().find((c) => c.name === "location");
      expect(loc).toBeDefined();
      expect(loc!.subType).toBe("geopoint");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opts.providers extension does NOT break the default core subtypes", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({
          "metadata.root": {
            package: "test",
            children: [
              {
                "object.entity": {
                  name: "User",
                  children: [
                    { "field.string": { name: "email" } },
                  ],
                },
              },
            ],
          },
        }),
      );
      const meta = await loadMemory(root, { providers: [geoProvider()] });
      const u = meta.findObject("User");
      expect(u).toBeDefined();
      const email = u!.children().find((c) => c.name === "email");
      expect(email!.subType).toBe(FIELD_SUBTYPE_STRING);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opts.replaceDefaults skips defaults — core subtypes no longer recognized", async () => {
    const root = makeMetaRoot();
    try {
      // A minimal-but-valid metadata doc using only a custom subtype.
      // Without the core provider the field.string subtype is unknown,
      // and loadMemory should surface an error.
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({
          metadata: {
            package: "test",
            children: [
              {
                object: {
                  name: "User",
                  subType: OBJECT_SUBTYPE_ENTITY,
                  children: [
                    { field: { name: "email", subType: FIELD_SUBTYPE_STRING } },
                  ],
                },
              },
            ],
          },
        }),
      );
      // Supply ONLY the third-party provider — the metadata top-level
      // wrapper "metadata.root" is itself a core subtype, so parsing will
      // fail without the core provider. Either an unknown-type/subtype
      // error code or a composition error is acceptable; we just need to
      // observe the loader REFUSING to recognize the core subtype.
      await expect(
        loadMemory(root, {
          providers: [geoProvider()],
          replaceDefaults: true,
        }),
      ).rejects.toThrow(/depends on "metaobjects-core-types", which is not in the provider set/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("opts.replaceDefaults with empty providers throws (advanced — caller must supply set)", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({ metadata: { package: "test", children: [] } }),
      );
      await expect(
        loadMemory(root, { providers: [], replaceDefaults: true }),
      ).rejects.toThrow(/replaceDefaults/);
      await expect(
        loadMemory(root, { replaceDefaults: true }),
      ).rejects.toThrow(/replaceDefaults/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("duplicate provider id surfaces ERR_PROVIDER_DUPLICATE_ID", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({ metadata: { package: "test", children: [] } }),
      );
      // Two providers with the same id collide; composeRegistry throws.
      const dup1: MetaDataTypeProvider = {
        id: "test-dup",
        registerTypes() {},
      };
      const dup2: MetaDataTypeProvider = {
        id: "test-dup",
        registerTypes() {},
      };
      try {
        await loadMemory(root, { providers: [dup1, dup2] });
        throw new Error("expected loadMemory to throw");
      } catch (err) {
        const e = err as { code?: string; message?: string };
        expect(e.code).toBe("ERR_PROVIDER_DUPLICATE_ID");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing dependency surfaces ERR_PROVIDER_MISSING_DEPENDENCY", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({ metadata: { package: "test", children: [] } }),
      );
      // replaceDefaults so the dep "metaobjects-core-types" isn't ambient.
      const dependsOnMissing: MetaDataTypeProvider = {
        id: "test-needs-x",
        dependencies: ["does-not-exist"],
        registerTypes() {},
      };
      try {
        await loadMemory(root, {
          providers: [dependsOnMissing],
          replaceDefaults: true,
        });
        throw new Error("expected loadMemory to throw");
      } catch (err) {
        const e = err as { code?: string; message?: string };
        expect(e.code).toBe("ERR_PROVIDER_MISSING_DEPENDENCY");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dependency cycle surfaces ERR_PROVIDER_DEPENDENCY_CYCLE", async () => {
    const root = makeMetaRoot();
    try {
      writeFileSync(
        join(root, "metaobjects", "domain.json"),
        JSON.stringify({ metadata: { package: "test", children: [] } }),
      );
      const cycleA: MetaDataTypeProvider = {
        id: "cycle-a",
        dependencies: ["cycle-b"],
        registerTypes() {},
      };
      const cycleB: MetaDataTypeProvider = {
        id: "cycle-b",
        dependencies: ["cycle-a"],
        registerTypes() {},
      };
      try {
        await loadMemory(root, {
          providers: [cycleA, cycleB],
          replaceDefaults: true,
        });
        throw new Error("expected loadMemory to throw");
      } catch (err) {
        const e = err as { code?: string; message?: string };
        expect(e.code).toBe("ERR_PROVIDER_DEPENDENCY_CYCLE");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaultLoadMemoryProviders is a stable, public, non-empty bundle", () => {
    expect(defaultLoadMemoryProviders.length).toBeGreaterThanOrEqual(2);
    // The forge provider is in the bundle; consumers can introspect.
    const ids = defaultLoadMemoryProviders.map((p) => p.id);
    expect(ids).toContain("metaobjects-core-types");
    expect(ids).toContain("metaobjects-forge");
  });
});
