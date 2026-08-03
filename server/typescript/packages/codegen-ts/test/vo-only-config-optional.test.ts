// #194 item 3 — a value-object-only project may omit dbImport/dialect (it generates
// zero DB code, so requiring them was a dead-but-mandatory tsc obligation). A model
// that DOES emit DB code must still set them, and omitting them errors clearly rather
// than silently defaulting (which would e.g. emit sqlite for a Postgres project).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { entityFile } from "../src/generators/entity-file.js";
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
    { "field.long": { name: "id" } },
    { "field.string": { name: "email", "@required": true } },
    { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
  ] } },
];

// dbImport/dialect deliberately OMITTED — legal for a value-object-only model.
// outDir is filled per-test with the beforeEach tmp dir (no writes into the package).
const configNoDb = (): MetaobjectsGenConfig =>
  ({ outDir: tmp, extStyle: "js", generators: [entityFile()] } as MetaobjectsGenConfig);

describe("#194 item 3 — dbImport/dialect optional for value-object-only projects", () => {
  test("a value-object-only model generates with NO dbImport/dialect set (no throw)", async () => {
    const root = await load(VALUE_ONLY);
    const result = await runGen({ config: configNoDb(), metadata: root, projectRoot: tmp });
    // It runs to completion; a value object emits no query/route DB code, so the
    // absent dbImport/dialect are never read.
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
    expect(err!.message).toContain("dialect and dbImport");
    expect(err!.message).toContain("User"); // names the DB-emitting object
  });

  test("a DB entity WITH dbImport/dialect set generates normally (no regression)", async () => {
    const root = await load(ENTITY);
    const cfg = { ...configNoDb(), dbImport: "./db", dialect: "postgres" as const } as MetaobjectsGenConfig;
    const result = await runGen({ config: cfg, metadata: root, projectRoot: tmp });
    expect(result.files.length).toBeGreaterThan(0);
  });
});
