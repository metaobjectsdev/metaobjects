// The shared foreign-key index corpus: `fixtures/foreign-key-index-conformance/` pins which
// foreign keys `migrate.foreignKeyIndexes` indexes and under what name, per dialect. The C# EF
// context generator and the Kotlin Exposed table generator write the same indexes into their
// models and pass the same expected files, so one rule decides "uncovered" in every port.
//
// `declared.<dialect>.json` pins the other half of the agreement: the database name of every
// `identity.secondary` and `index.lookup`, which a declared name over 63 bytes cuts on Postgres
// exactly as a foreign-key index name is cut. The Drizzle, EF Core and Exposed mappings declare
// those names, so the C# and Kotlin runners read this file too.
//
// Regenerate the expected files (after a deliberate change, reviewed):
// META_WRITE_FK_INDEXES=1 bun test test/foreign-key-index-conformance.test.ts

import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchemaWithProvenance } from "../src/expected-schema.js";
import { PG_IDENTIFIER_MAX_BYTES, storedIdentifier, type IndexDescriptor } from "../src/types.js";
import { qualifiedDbName } from "../src/qualified-name.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/foreign-key-index-conformance");

const CASES = [
  { file: "expected.postgres.json", declared: "declared.postgres.json", dialect: "postgres" },
  { file: "expected.sqlite.json", declared: "declared.sqlite.json", dialect: "sqlite" },
] as const;

async function load() {
  const dir = join(CORPUS, "input");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => new InMemoryStringSource(readFileSync(join(dir, f), "utf8"), { id: f, format: "json" }));
  const { root, errors } = await new MetaDataLoader().load(sources);
  expect(errors).toEqual([]);
  return root;
}

describe("foreign-key-index-conformance — the indexes migrate.foreignKeyIndexes adds", () => {
  for (const c of CASES) {
    test(c.file, async () => {
      const built = buildExpectedSchemaWithProvenance(await load(), { dialect: c.dialect, foreignKeyIndexes: true });
      // Keyed by table name (the corpus has no @schema); tables with none are left out.
      const added = built.foreignKeyIndexes ?? new Map<string, IndexDescriptor[]>();
      const actual = Object.fromEntries(
        built.snapshot.tables
          .map((t) => [t.name, added.get(qualifiedDbName(t)) ?? []] as const)
          .filter(([, ixs]) => ixs.length > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([table, ixs]) => [table, ixs.map((ix) => ({ name: ix.name, columns: [...ix.columns] }))]),
      );
      const path = join(CORPUS, c.file);
      if (process.env["META_WRITE_FK_INDEXES"] === "1") writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
      expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    });
  }

  for (const c of CASES) {
    test(c.declared, async () => {
      const root = await load();
      const built = buildExpectedSchemaWithProvenance(root, { dialect: c.dialect, foreignKeyIndexes: true });
      const added = built.foreignKeyIndexes ?? new Map<string, IndexDescriptor[]>();
      // Every index but the foreign-key ones and a `@unique` field's `<table>_<column>_unique`:
      // the `identity.secondary` and `index.lookup` nodes, under the name migrate gives them.
      const actual = Object.fromEntries(
        built.snapshot.tables
          .map((t) => {
            const fk = new Set((added.get(qualifiedDbName(t)) ?? []).map((ix) => ix.name));
            const declared = t.indexes.filter((ix) =>
              !fk.has(ix.name) && !(ix.unique && ix.columns.length === 1 &&
                ix.name === storedIdentifier(`${t.name}_${ix.columns[0]}_unique`, c.dialect)));
            return [t.name, declared] as const;
          })
          .filter(([, ixs]) => ixs.length > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([table, ixs]) => [table, ixs.map((ix) => ({ name: ix.name, columns: [...ix.columns] }))]),
      );
      const path = join(CORPUS, c.declared);
      if (process.env["META_WRITE_FK_INDEXES"] === "1") writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
      expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    });
  }

  test("postgres: a name over 63 bytes is cut to the 63 bytes Postgres stores", async () => {
    const built = buildExpectedSchemaWithProvenance(await load(), { dialect: "postgres", foreignKeyIndexes: true });
    const long = built.snapshot.tables.find((t) => t.name === "customer_order_line_item_allocations_by_region")!;
    const ix = long.indexes.find((i) => i.columns[0] === "fulfilment_warehouse_reference_id")!;
    expect(Buffer.byteLength(ix.name, "utf8")).toBe(PG_IDENTIFIER_MAX_BYTES);
    expect(`${long.name}_fulfilment_warehouse_reference_id_idx`.startsWith(ix.name)).toBe(true);
  });
});
