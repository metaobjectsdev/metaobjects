/**
 * #225 — computeDrift was refactored into a thin Kysely-introspection wrapper
 * over a new `computeDriftFromActual(actual, dialect, metadata, opts)`, so a
 * caller with no Kysely driver for its dialect (Cloudflare D1 has none — it
 * has no client wire protocol) can still run the same expected-schema + diff
 * pipeline against a snapshot obtained some other way.
 *
 * This test proves the refactor is behavior-preserving: given the SAME actual
 * snapshot, `computeDriftFromActual` must return results identical to what
 * `computeDrift` returns when it introspects that same DB itself.
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
import { computeDrift, computeDriftFromActual } from "../../src/drift/drift.js";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-drift-from-actual-"));
  const url = `file:${join(tmpDir, "test.db")}`;
  k = new Kysely({ dialect: new LibsqlDialect({ url }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

const META = JSON.stringify({
  "metadata.root": {
    package: "acme::driftrefactor",
    children: [
      {
        "object.entity": {
          name: "Gadget",
          children: [
            { "source.rdb": {} },
            { "field.long": { name: "id" } },
            { "field.string": { name: "label" } },
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

describe("computeDriftFromActual — behavior-preservation vs computeDrift", () => {
  test("in-sync DB → both return identical (empty) results", async () => {
    const root = await loadMeta(META);
    const expected = buildExpectedSchema(root, { dialect: "sqlite" });
    const actual0 = await introspect(k, "sqlite");
    const { up } = emit((await diff(expected, actual0)).changes, {
      dialect: "sqlite",
      expectedSchema: expected,
    });
    await applyRaw(k, up);

    const viaWrapper = await computeDrift(k, "sqlite", root);

    // Independently introspect the SAME db and feed it to the extracted core.
    const actual = await introspect(k, "sqlite");
    const viaCore = await computeDriftFromActual(actual, "sqlite", root);

    expect(viaCore).toEqual(viaWrapper);
    expect(viaCore.changes).toEqual([]);
  });

  test("drifted DB (missing column) → both surface the identical add-column change", async () => {
    // Materialize a reduced schema (no `label`), then diff the FULL metadata
    // (with `label`) against it — mirrors drift-sqlite.test.ts's pattern.
    const reduced = JSON.parse(META);
    const gadget = reduced["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "Gadget",
    )["object.entity"];
    gadget.children = gadget.children.filter(
      (ch: Record<string, { name?: string }>) => ch["field.string"]?.name !== "label",
    );
    const reducedRoot = await loadMeta(JSON.stringify(reduced));
    const reducedExpected = buildExpectedSchema(reducedRoot, { dialect: "sqlite" });
    const { up } = emit((await diff(reducedExpected, await introspect(k, "sqlite"))).changes, {
      dialect: "sqlite",
      expectedSchema: reducedExpected,
    });
    await applyRaw(k, up);

    const fullRoot = await loadMeta(META);

    const viaWrapper = await computeDrift(k, "sqlite", fullRoot);

    const actual = await introspect(k, "sqlite");
    const viaCore = await computeDriftFromActual(actual, "sqlite", fullRoot);

    expect(viaCore).toEqual(viaWrapper);
    expect(viaCore.changes.length).toBeGreaterThan(0);
    const addLabel = viaCore.changes.find(
      (c) => c.kind === "add-column" && "column" in c && c.column.name === "label",
    );
    expect(addLabel).toBeDefined();
  });
});
