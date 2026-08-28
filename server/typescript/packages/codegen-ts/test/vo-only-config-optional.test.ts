// #194 item 3 — a value-object-only project may omit dbImport/dialect (it generates
// zero DB code, so requiring them was a dead-but-mandatory tsc obligation). A model
// that DOES emit DB code must still set them, and omitting them errors clearly rather
// than silently defaulting (which would e.g. emit sqlite for a Postgres project).
//
// The two halves later split on WHERE the answer is needed. `dialect` stays eager:
// a wrong default silently emits the wrong SQL for every sourced object, so the model
// alone settles it. `dbImport` is only ever read by a generator that emits
// `import { db } from …`, and a project whose generated queries take `db` as a
// parameter never has one — so demanding it from the MODEL convicted projects that
// could not use it. It is now demanded at the point of USE, by the generator that
// needs it, naming that generator.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { entityFile } from "../src/generators/entity-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import type { MetaobjectsGenConfig } from "../src/metaobjects-config.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-vo-only-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "app", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

const VALUE_ONLY = [
  { "object.value": { name: "Slots", children: [
    { "field.string": { name: "goal", "@required": true } },
    { "field.string": { name: "note" } },
  ] } },
];

const ENTITY = [
  { "object.entity": { name: "User", children: [
    { "source.rdb": { "@table": "users" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "email", "@required": true } },
    { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
  ] } },
];

// #210 — a sourceless object.projection (no source.rdb child) is now a first-class,
// migration-recommended payload shape: assembly origins re-host onto it. Like a
// value object it declares no source, so #248 R2 says it emits zero DB code — and
// the source-based guard must NOT demand dialect/dbImport for it.
const SOURCELESS_PROJECTION = [
  { "object.projection": { name: "Report", children: [
    { "field.string": { name: "title" } },
    { "field.string": { name: "summary" } },
  ] } },
];

// dbImport/dialect deliberately OMITTED — legal for a value-object-only model.
// outDir is filled per-test with the beforeEach tmp dir (no writes into the package).
const configNoDb = (): MetaobjectsGenConfig =>
  ({ outDir: tmp, extStyle: "js", generators: [entityFile()] } as MetaobjectsGenConfig);

describe("#194 item 3 — dbImport/dialect optional for value-object-only and sourceless-projection models", () => {
  test("a value-object-only model generates with NO dbImport/dialect set (no throw)", async () => {
    const root = await load(VALUE_ONLY);
    const result = await runGen({ config: configNoDb(), metadata: root, projectRoot: tmp });
    // It runs to completion; a value object emits no query/route DB code, so the
    // absent dbImport/dialect are never read.
    expect(result.warnings.some((w) => w.includes("missing"))).toBe(false);
    expect(Array.isArray(result.files)).toBe(true);
  });

  test("a model whose only concrete object is a sourceless projection generates with NO dbImport/dialect (no throw)", async () => {
    const root = await load(SOURCELESS_PROJECTION);
    const result = await runGen({ config: configNoDb(), metadata: root, projectRoot: tmp });
    // #210/#248 — a sourceless projection declares no source.rdb, so it emits zero
    // DB code and must not demand database config; the guard keys on source, not subtype.
    expect(result.warnings.some((w) => w.includes("missing"))).toBe(false);
    expect(Array.isArray(result.files)).toBe(true);
  });

  test("a model with a DB entity but no dbImport/dialect throws a clear error naming the entity", async () => {
    const root = await load(ENTITY);
    let err: Error | undefined;
    try {
      await runGen({ config: configNoDb(), metadata: root, projectRoot: tmp });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("dialect");
    expect(err!.message).toContain("User"); // names the DB-emitting object
  });

  test("a DB entity with dialect but no dbImport generates when nothing emits a db import", async () => {
    // The shape the eager guard convicted: a real sourced entity, a generator that
    // takes `db` as a parameter rather than importing a singleton. Nothing can read
    // dbImport, so nothing may demand it.
    const root = await load(ENTITY);
    const cfg = { ...configNoDb(), dialect: "sqlite" as const } as MetaobjectsGenConfig;
    const result = await runGen({ config: cfg, metadata: root, projectRoot: tmp });
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("a generator that DOES emit `import { db }` still demands dbImport, and names itself", async () => {
    const root = await load(ENTITY);
    const cfg = {
      ...configNoDb(),
      dialect: "sqlite" as const,
      generators: [routesFile()],
    } as MetaobjectsGenConfig;
    let err: Error | undefined;
    try {
      await runGen({ config: cfg, metadata: root, projectRoot: tmp });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("dbImport");
    expect(err!.message).toContain("routes"); // the runner prefixes [<generator>]
  });

  test("an explicit dbImport equal to the default is honoured, not read as absent", async () => {
    // Declaration is tracked, never inferred by comparing against DEFAULT_DB_IMPORT:
    // `meta init` scaffolds a relative path, and a project is free to write the same
    // string the default happens to use.
    const root = await load(ENTITY);
    const cfg = {
      ...configNoDb(),
      dialect: "sqlite" as const,
      dbImport: "./db",
      generators: [routesFile()],
    } as MetaobjectsGenConfig;
    const result = await runGen({ config: cfg, metadata: root, projectRoot: tmp });
    expect(result.files.length).toBeGreaterThan(0);
  });

  test("a DB entity WITH dbImport/dialect set generates normally (no regression)", async () => {
    const root = await load(ENTITY);
    const cfg = { ...configNoDb(), dbImport: "./db", dialect: "postgres" as const } as MetaobjectsGenConfig;
    const result = await runGen({ config: cfg, metadata: root, projectRoot: tmp });
    expect(result.files.length).toBeGreaterThan(0);
  });
});
