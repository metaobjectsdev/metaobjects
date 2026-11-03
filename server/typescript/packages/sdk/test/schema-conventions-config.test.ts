// `migrate.conventions` and `migrate.checks` in .metaobjects/config.json: the schema
// conventions meta migrate names database-only objects with, and which validator CHECKs it
// emits. Both are migrate settings, so the resolved collection carries them and the loaded
// model does not; the CLI resolves them once and hands them to every expected-schema build.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, loadConfig } from "../src/config.js";
import { resolveCollection } from "../src/collection.js";
import { loadMemory } from "../src/memory.js";

const MODEL = { "metadata.root": { package: "w", children: [
  { "object.entity": { name: "Thing", children: [{ "field.string": { name: "id" } }] } },
] } };

async function withProject<T>(config: Record<string, unknown>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "mo-conventions-"));
  try {
    mkdirSync(join(dir, ".metaobjects"));
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, ...config }));
    writeFileSync(join(dir, "metaobjects", "meta.w.json"), JSON.stringify(MODEL));
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("migrate.conventions", () => {
  test("is a string in the config schema", () => {
    expect(ConfigSchema.safeParse({ schema_version: 1, migrate: { conventions: "efcore" } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ schema_version: 1, migrate: { conventions: 3 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ schema_version: 1, migrate: { conventions: "" } }).success).toBe(false);
  });

  test("the resolved collection carries it", async () => {
    await withProject({ migrate: { conventions: "efcore" } }, async (dir) => {
      expect((await resolveCollection(dir)).schemaConventions).toBe("efcore");
    });
    await withProject({}, async (dir) => {
      expect((await resolveCollection(dir)).schemaConventions).toBeUndefined();
    });
  });

  test("the loaded model does not: it is migrate's setting, not the model's", async () => {
    await withProject({ migrate: { conventions: "efcore" } }, async (dir) => {
      expect("schemaConventions" in (await loadMemory(dir))).toBe(false);
    });
  });
});

describe("migrate.checks", () => {
  test("skipRedundant is carried by the collection, false when absent", async () => {
    await withProject({ migrate: { checks: { skipRedundant: true } } }, async (dir) => {
      expect((await resolveCollection(dir)).skipRedundantChecks).toBe(true);
    });
    await withProject({ migrate: { checks: {} } }, async (dir) => {
      expect((await resolveCollection(dir)).skipRedundantChecks).toBe(false);
    });
    await withProject({}, async (dir) => {
      expect((await resolveCollection(dir)).skipRedundantChecks).toBe(false);
    });
  });

  test("a bad checks block is refused, naming the key", async () => {
    const refusal = (checks: unknown) => withProject({ migrate: { checks } }, async (dir) => {
      try {
        await loadConfig(join(dir, ".metaobjects"));
      } catch (err) {
        return (err as Error).message;
      }
      return "accepted";
    });
    expect(await refusal(true)).toMatch(/migrate\.checks: .*expected object/);
    expect(await refusal({ skipRedundnat: true })).toMatch(/migrate\.checks: .*skipRedundnat/);
    expect(await refusal({ skipRedundant: "yes" })).toMatch(/migrate\.checks\.skipRedundant: .*expected boolean/);
  });
});
