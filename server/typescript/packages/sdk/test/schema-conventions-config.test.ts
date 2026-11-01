// `migrate.conventions` in .metaobjects/config.json: the schema conventions meta migrate
// names database-only objects with. The project-aware load carries the selection on the root,
// as it does `naming` and `wire`, so every expected-schema build of one loaded model — migrate,
// verify --db, the advisories — uses the same conventions. A project's own conventions object
// (from metaobjects.config.ts) arrives as a load option and wins over the preset name.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.js";
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

  test("the project-aware load carries it on the root", async () => {
    await withProject({ migrate: { conventions: "efcore" } }, async (dir) => {
      expect((await loadMemory(dir)).schemaConventions).toBe("efcore");
    });
  });

  test("absent, the root carries nothing (migrate's own default applies)", async () => {
    await withProject({}, async (dir) => {
      expect((await loadMemory(dir)).schemaConventions).toBeUndefined();
    });
  });

  test("a conventions object passed to the load wins over the preset name", async () => {
    const own = { id: "acme" };
    await withProject({ migrate: { conventions: "efcore" } }, async (dir) => {
      expect((await loadMemory(dir, { schemaConventions: own })).schemaConventions).toBe(own);
    });
  });
});
