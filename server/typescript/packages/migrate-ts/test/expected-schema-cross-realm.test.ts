// Cross-realm safety — buildExpectedSchema must recognise a source node built by
// a SECOND physical copy of @metaobjectsdev/metadata.
//
// `x instanceof MetaSource` is only sound when the class object and the instance
// come from the same physical copy of the package. A globally-installed or linked
// `meta` CLI alongside a project-local dependency puts two copies in one process,
// and then the class check is false for a node that is a source in every
// observable respect — the class-identity defect that split ts-poet's `Code`
// objects in 0.21.6.
//
// Here it is the worst instance of that family, because the failure is SILENT and
// lands on the schema engine: Pass 1 decides table persistability from "does this
// object have a writable source?". Answer that false and the entity is dropped
// from the EXPECTED schema entirely — so `meta migrate` sees a live table with no
// counterpart in metadata and proposes to DROP it, and `meta verify` reports drift
// against a model that is actually correct. Nothing errors.
//
// `meta migrate` aliases @metaobjectsdev/metadata to the CLI's own copy (the CLI's
// load-metaobjects-config.ts CLI_PKG_PATHS), which is why this has never fired in
// practice — but that alias map does not run when a consumer drives the migrate
// engine programmatically, so the engine must not depend on it.
//
// A foreign-realm node is simulated by re-prototyping a REAL loaded node onto a
// copy of its own prototype: every method and getter still resolves, the node is
// still a MetaData, but its prototype chain no longer passes through THIS copy's
// MetaSource — exactly the observable condition a split tree produces.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  TYPE_SOURCE,
  isMetaSource,
} from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { collectUnmanagedNames } from "../src/unmanaged.js";

async function loadJson(json: unknown): Promise<MetaData> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(json)),
  ]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

/**
 * Move a node into a simulated second copy of the package: clone its prototype
 * (keeping every method/getter and the MetaData base above it) and re-seat the
 * node on the clone, so `instanceof <ThisCopy's class>` is false while behaviour
 * is unchanged.
 */
function intoForeignRealm(node: MetaData): void {
  const ownProto = Object.getPrototypeOf(node) as object;
  const foreignProto = Object.create(Object.getPrototypeOf(ownProto) as object) as object;
  for (const key of Reflect.ownKeys(ownProto)) {
    if (key === "constructor") continue;
    const d = Object.getOwnPropertyDescriptor(ownProto, key);
    if (d !== undefined) Object.defineProperty(foreignProto, key, d);
  }
  Object.setPrototypeOf(node, foreignProto);
}

/** Re-seat every source node in the tree into the simulated second copy. */
function foreignRealmSources(root: MetaData): number {
  let moved = 0;
  for (const obj of root.children()) {
    for (const child of obj.children()) {
      if (child.type !== TYPE_SOURCE) continue;
      intoForeignRealm(child);
      moved += 1;
    }
  }
  return moved;
}

// @table is deliberately NOT the name-derived fallback ("Order" → "orders"). If
// resolveTableName's primary-source lookup falls through — which is exactly what a
// split tree caused before the fix — it silently returns the fallback instead, and
// `meta migrate` emits that as a table RENAME against a live database. With a
// case-aligned name the assertion below would pass either way and see nothing.
const TABLE = "order_header";

const MODEL = {
  "metadata.root": {
    package: "acme::probe",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "ref" } },
            { "source.rdb": { "@table": TABLE } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

describe("buildExpectedSchema survives a split @metaobjectsdev/metadata tree", () => {
  test("the simulation really does defeat instanceof (guards the guard)", async () => {
    // Without this, a bug in intoForeignRealm would make every assertion below
    // pass vacuously against ordinary same-copy nodes.
    const root = await loadJson(MODEL);
    const source = root.children()[0]?.children().find((c) => c.type === TYPE_SOURCE);
    expect(source).toBeDefined();

    const { MetaSource } = await import("@metaobjectsdev/metadata");
    expect(source instanceof MetaSource).toBe(true);
    intoForeignRealm(source as MetaData);
    expect(source instanceof MetaSource).toBe(false);

    // ...while the node is unchanged in every respect the engine actually uses.
    expect(isMetaSource(source)).toBe(true);
    expect((source as unknown as { isWritable(): boolean }).isWritable()).toBe(true);
    expect((source as unknown as { physicalName: string }).physicalName).toBe(TABLE);
  });

  test("an entity whose source came from a second copy still gets its table", async () => {
    const root = await loadJson(MODEL);
    expect(foreignRealmSources(root)).toBe(1);

    const snapshot = buildExpectedSchema(root);
    // The defect drops the table silently — `meta migrate` would then propose
    // DROP TABLE orders against a live database.
    expect(snapshot.tables.map((t) => t.name)).toEqual([TABLE]);
  });

  test("an @unmanaged source from a second copy is still silenced", async () => {
    const root = await loadJson({
      "metadata.root": {
        package: "acme::probe",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "source.rdb": { "@table": "orders", "@schema": "ops", "@unmanaged": true } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    expect(foreignRealmSources(root)).toBe(1);

    // Losing this turns a declared-external table back into a proposed drop.
    expect(collectUnmanagedNames(root)).toEqual(["ops.orders"]);
  });

  test("a sourceless entity is still not given a table", async () => {
    // The relaxation must not overshoot into emitting tables for everything.
    const root = await loadJson({
      "metadata.root": {
        package: "acme::probe",
        children: [
          {
            "object.entity": {
              name: "Ghost",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    expect(buildExpectedSchema(root).tables).toEqual([]);
  });
});
