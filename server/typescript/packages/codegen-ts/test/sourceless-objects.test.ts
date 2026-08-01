// #248 R2 — DB-artifact tier (queries/routes/hono) must gate on SOURCE presence,
// never subtype. Before this fix, queries-file/routes-file/routes-file-hono
// filtered on `subType !== OBJECT_SUBTYPE_VALUE` (queries) or nothing at all
// (routes/hono) — so a sourceless entity ("Ghost") got a queries/routes file
// importing Drizzle table/allowlist exports the entity-file generator (correctly)
// never emits (hasWritableRdbSource gates THAT tier already), and a plain
// object.value ("Money") got a broken routes file with no persistence layer at
// all. Both are TS2305/TS2724-class breakage in generated output.
//
// The fix: `hasAnyRdbSource` (any source.rdb, not just writable) — the queries/
// routes/hono/api-model tier's sibling of the entity-file tier's
// `hasWritableRdbSource` — gates DB-bound artifact emission. A read-only-source
// projection still gets queries/routes (the existing read-only path); a
// zero-source object of ANY subtype gets neither.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, routesFile, routesFileHono } from "../src/generators/index.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-sourceless-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function loadRoot(children: unknown[]) {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::probe", children } })),
  ]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

// Order — a normal, sourced entity (the well-formed baseline, Task 1's fixture shape).
const ORDER = {
  "object.entity": {
    name: "Order",
    children: [
      { "source.rdb": { "@table": "orders" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "reference" } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ],
  },
};

// Money — a plain object.value (two fields, no identity, no source — value
// purity, ADR-0028). Before the fix, routes-file.ts had NO value skip at all.
const MONEY = {
  "object.value": {
    name: "Money",
    children: [
      { "field.long": { name: "cents" } },
      { "field.string": { name: "currency" } },
    ],
  },
};

// Ghost — an entity with identity but NO source.* child at all. Loads clean
// (validate-source-roles: zero sources = "not persisted", not an error).
const GHOST = {
  "object.entity": {
    name: "Ghost",
    children: [
      { "field.long": { name: "id" } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ],
  },
};

function genConfig(outDir: string) {
  return defineConfig({
    outDir,
    extStyle: "none",
    dbImport: "~/server/db",
    dialect: "postgres",
    generators: [entityFile(), queriesFile(), routesFile(), routesFileHono()],
  });
}

describe("#248 R2 — sourceless objects get no DB-bound artifacts", () => {
  test("Order (sourced) gets entity+queries+routes+hono; Money (value) and Ghost (sourceless entity) get neither", async () => {
    const root = await loadRoot([ORDER, MONEY, GHOST]);
    const out = await runGen({ config: genConfig(tmp), metadata: root });
    expect(out.warnings).toEqual([]);

    // runGen reports files.path as absolute (outDir-joined) paths.
    const paths = new Set(out.files.map((f) => f.path));
    const at = (name: string) => join(tmp, name);

    // INCLUDES — the sourced entity gets the full DB-bound surface; the
    // sourceless/value objects still get their shape-only entity file.
    expect(paths.has(at("Order.ts"))).toBe(true);
    expect(paths.has(at("Order.queries.ts"))).toBe(true);
    expect(paths.has(at("Order.routes.ts"))).toBe(true);
    expect(paths.has(at("Order.routes.hono.ts"))).toBe(true);
    expect(paths.has(at("Money.ts"))).toBe(true);
    expect(paths.has(at("Ghost.ts"))).toBe(true);

    // EXCLUDES — no DB-bound artifact for a plain value or a sourceless entity;
    // this is the actual bug (queries/routes previously emitted here, importing
    // Drizzle table/allowlist exports that were never generated).
    expect(paths.has(at("Ghost.queries.ts"))).toBe(false);
    expect(paths.has(at("Ghost.routes.ts"))).toBe(false);
    expect(paths.has(at("Ghost.routes.hono.ts"))).toBe(false);
    expect(paths.has(at("Money.queries.ts"))).toBe(false);
    expect(paths.has(at("Money.routes.ts"))).toBe(false);
    expect(paths.has(at("Money.routes.hono.ts"))).toBe(false);

    // Nothing beyond the on-disk files reported by runGen either.
    const onDisk = new Set(readdirSync(tmp));
    expect(onDisk.has("Ghost.queries.ts")).toBe(false);
    expect(onDisk.has("Money.routes.ts")).toBe(false);
  });

  test("content no-churn: Order.* is byte-identical whether or not Money/Ghost are co-loaded", async () => {
    const mixedRoot = await loadRoot([ORDER, MONEY, GHOST]);
    const mixedOut = tmp;
    await runGen({ config: genConfig(mixedOut), metadata: mixedRoot });

    const soloDir = mkdtempSync(join(tmpdir(), "codegen-sourceless-solo-"));
    try {
      const soloRoot = await loadRoot([ORDER]);
      await runGen({ config: genConfig(soloDir), metadata: soloRoot });

      for (const name of ["Order.ts", "Order.queries.ts", "Order.routes.ts"]) {
        const mixed = readFileSync(join(mixedOut, name), "utf-8");
        const solo = readFileSync(join(soloDir, name), "utf-8");
        expect(mixed).toBe(solo);
      }
    } finally {
      rmSync(soloDir, { recursive: true, force: true });
    }
  });

  test("a read-only-source projection is still queryable (queries+routes emitted)", async () => {
    // Same Program/Week/ProgramSummary shape as
    // test/projection/queries-file.test.ts — a writable-source base entity plus
    // a read-only (@kind: view) projection derived from it via origin.aggregate.
    const root = await loadRoot([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.int": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Week",
          children: [
            { "source.rdb": { "@table": "weeks" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "programId" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProgramSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
            { "field.int": { name: "id" } },
            {
              "field.int": {
                name: "weekCount",
                children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }],
              },
            },
          ],
        },
      },
    ]);

    const out = await runGen({ config: genConfig(tmp), metadata: root });
    expect(out.warnings).toEqual([]);
    const paths = new Set(out.files.map((f) => f.path));
    expect(paths.has(join(tmp, "ProgramSummary.ts"))).toBe(true);
    expect(paths.has(join(tmp, "ProgramSummary.queries.ts"))).toBe(true);
    expect(paths.has(join(tmp, "ProgramSummary.routes.ts"))).toBe(true);
  });
});
