/**
 * computeDrift integration test — structural + view-body drift vs a live DB.
 *
 * Mirrors sqlite-roundtrip.test.ts's libsql-tmp-file harness. Builds a small
 * metadata root, materializes its expected schema into the DB, and asserts:
 *   - in-sync DB → computeDrift returns no changes;
 *   - missing-column DB → computeDrift surfaces the add-column change.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";
import { introspect } from "../../src/introspect/index.js";
import { computeDrift } from "../../src/drift/drift.js";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-drift-sqlite-"));
  const url = `file:${join(tmpDir, "test.db")}`;
  k = new Kysely({ dialect: new LibsqlDialect({ url }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::drift",
    children: [
      {
        "object.entity": {
          name: "Widget",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name" } },
            { "field.string": { name: "color" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

async function loadMeta(json: string) {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

async function applyRaw(kysely: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(kysely);
  }
}

describe("computeDrift — sqlite", () => {
  test("in-sync DB → no changes", async () => {
    const root = await loadMeta(META);
    const expected = buildExpectedSchema(root, { dialect: "sqlite" });
    const actual0 = await introspect(k, "sqlite");
    const { up } = emit((await diff(expected, actual0)).changes, {
      dialect: "sqlite",
      expectedSchema: expected,
    });
    await applyRaw(k, up);

    const result = await computeDrift(k, "sqlite", root);
    expect(result.changes).toEqual([]);
  });

  test("DB missing a column → drift surfaces the add-column change", async () => {
    // Materialize the schema WITHOUT the `color` column by loading a reduced
    // metadata root, applying it, then diffing the full metadata.
    const reduced = JSON.parse(META);
    const widget = reduced["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "Widget",
    )["object.entity"];
    widget.children = widget.children.filter(
      (ch: Record<string, { name?: string }>) => ch["field.string"]?.name !== "color",
    );
    const reducedRoot = await loadMeta(JSON.stringify(reduced));
    const reducedExpected = buildExpectedSchema(reducedRoot, { dialect: "sqlite" });
    const { up } = emit((await diff(reducedExpected, await introspect(k, "sqlite"))).changes, {
      dialect: "sqlite",
      expectedSchema: reducedExpected,
    });
    await applyRaw(k, up);

    // Now drift the FULL metadata (with `color`) against the reduced DB.
    const fullRoot = await loadMeta(META);
    const result = await computeDrift(k, "sqlite", fullRoot);
    expect(result.changes.length).toBeGreaterThan(0);
    const addColor = result.changes.find(
      (c) => c.kind === "add-column" && "column" in c && c.column.name === "color",
    );
    expect(addColor).toBeDefined();
  });
});
